import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { CLI_PATH } from "./daemon.ts";

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Starts this computer's a2a client when the person signs in, so agents with auto-reply on keep
 * listening with every app closed. It runs `a2a start`, which does nothing when the client already
 * runs. Windows: a hidden script in the Startup folder. macOS: a LaunchAgent run once at login.
 * Linux: an XDG autostart entry. Returns the file written, or null when skipped.
 */
export function installAutostart(home: string): string | null {
  // Only for the installed client, never from tests or a source checkout.
  if (process.env.NODE_TEST_CONTEXT || process.env.A2A_NO_AUTOSTART || !/a2a\.mjs$/.test(CLI_PATH)) return null;
  const args = [process.execPath, "--disable-warning=ExperimentalWarning", CLI_PATH, "--home", home, "start"];
  try {
    if (platform() === "win32") {
      const dir = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "a2a-client.vbs");
      // VBScript doubles quotes inside a string; 0 = hidden window, False = don't wait.
      writeFileSync(file, `' Starts the a2a client at sign-in, hidden, so agents with auto-reply on keep listening.\r\nCreateObject("WScript.Shell").Run "${args.map((a) => `""${a}""`).join(" ")}", 0, False\r\n`);
      return file;
    }
    if (platform() === "darwin") {
      const file = join(homedir(), "Library", "LaunchAgents", "dev.a2a.autostart.plist");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.a2a.autostart</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`,
      );
      return file;
    }
    const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart", "a2a-client.desktop");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `[Desktop Entry]\nType=Application\nName=a2a client\nComment=Keeps agents with auto-reply on listening\nExec=${args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`);
    return file;
  } catch {
    return null;
  }
}

/** Writes a launchd agent (macOS) or systemd user unit (Linux) that keeps `a2a run` alive. */
export function installService(home: string, name: string, load: boolean): string {
  const label = `dev.a2a.client.${name.replace(/[^a-zA-Z0-9.-]/g, "-")}`;
  const args = [process.execPath, "--disable-warning=ExperimentalWarning", CLI_PATH, "--home", home, "run"];
  const logDir = join(home, "logs");
  mkdirSync(logDir, { recursive: true });

  if (platform() === "darwin") {
    const file = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>A2A_HOME</key><string>${xml(home)}</string>
    <key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(logDir, "client.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, "client.log"))}</string>
</dict>
</plist>
`,
    );
    const uid = process.getuid?.() ?? 501;
    if (load) {
      try {
        execFileSync("launchctl", ["bootout", `gui/${uid}`, file], { stdio: "ignore" });
      } catch {
        /* not loaded yet */
      }
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, file], { stdio: "inherit" });
      return `Installed and started ${label}. Logs: ${join(logDir, "client.log")}`;
    }
    return `Wrote ${file}\nStart it with:\n  launchctl bootstrap gui/${uid} ${file}`;
  }

  const unit = `a2a-client-${name.replace(/[^a-zA-Z0-9-]/g, "-")}.service`;
  const file = join(homedir(), ".config", "systemd", "user", unit);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `[Unit]
Description=A2A client (${name})
After=network-online.target

[Service]
Environment=A2A_HOME=${home}
Environment=PATH=${process.env.PATH ?? "/usr/bin:/bin"}
ExecStart=${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`,
  );
  if (load) {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", unit], { stdio: "inherit" });
    return `Installed and started ${unit}. Logs: journalctl --user -u ${unit} -f`;
  }
  return `Wrote ${file}\nStart it with:\n  systemctl --user daemon-reload && systemctl --user enable --now ${unit}`;
}
