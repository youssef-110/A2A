import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { CLI_PATH } from "./daemon.ts";

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
