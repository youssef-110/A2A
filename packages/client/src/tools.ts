import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SKILL_MD } from "./instructions.ts";

/**
 * The AI apps A2A plugs into. Each gets its own agent (sam-claude, sam-antigravity, ...) and an MCP
 * server entry that runs `a2a mcp --tool <id>`, so every app speaks as itself.
 */
export interface Tool {
  id: string;
  label: string;
  /** Goes after the person's name in the agent address: sam-<suffix>. */
  suffix: string;
}

export const TOOLS: Tool[] = [
  { id: "claude-code", label: "Claude Code", suffix: "claude" },
  { id: "antigravity", label: "Antigravity", suffix: "antigravity" },
  { id: "gemini-cli", label: "Gemini CLI", suffix: "gemini" },
  { id: "codex", label: "Codex", suffix: "codex" },
  { id: "cursor", label: "Cursor", suffix: "cursor" },
  { id: "windsurf", label: "Windsurf", suffix: "windsurf" },
  { id: "vscode", label: "VS Code", suffix: "vscode" },
  { id: "claude-desktop", label: "Claude Desktop", suffix: "desktop" },
  { id: "opencode", label: "OpenCode", suffix: "opencode" },
];

export const toolById = (id: string): Tool | undefined => TOOLS.find((t) => t.id === id);

/** Tests point this somewhere temporary so they never touch real app configs. */
const home = (): string => process.env.A2A_APPS_HOME ?? homedir();
const appData = (): string => process.env.A2A_APPS_HOME ? join(process.env.A2A_APPS_HOME, "AppData", "Roaming") : (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"));

/** Per-OS folder where desktop apps keep settings. */
function appSupport(app: string): string {
  if (process.platform === "win32") return join(appData(), app);
  if (process.platform === "darwin") return join(home(), "Library", "Application Support", app);
  return join(home(), ".config", app);
}

/** Full path of a command, or null. Tests (A2A_APPS_HOME) never find real apps. */
function findOnPath(cmd: string): string | null {
  if (process.env.A2A_APPS_HOME) return null;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const hits = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // On Windows prefer a real program over a shim without an extension.
  return hits.find((h) => /\.(exe|cmd|bat)$/i.test(h)) ?? hits[0] ?? null;
}

const onPath = (cmd: string): boolean => findOnPath(cmd) !== null;

interface Target {
  /** Where the app keeps its MCP servers. */
  file: string;
  /** Whether the app looks installed on this computer. */
  present: () => boolean;
  kind: "mcpServers" | "vscode" | "opencode" | "codex" | "claude-cli";
  /** Antigravity and Claude Code read skills; others get the same guidance from the MCP server's instructions. */
  skillDir?: string;
}

function target(id: string): Target {
  const h = home();
  switch (id) {
    case "claude-code":
      return { file: join(h, ".claude.json"), present: () => existsSync(join(h, ".claude")), kind: "claude-cli" };
    case "antigravity":
      return { file: join(h, ".gemini", "antigravity", "mcp_config.json"), present: () => existsSync(join(h, ".gemini", "antigravity")), kind: "mcpServers", skillDir: join(h, ".gemini", "antigravity", "skills", "a2a") };
    case "gemini-cli":
      return { file: join(h, ".gemini", "settings.json"), present: () => existsSync(join(h, ".gemini", "settings.json")) || onPath("gemini"), kind: "mcpServers" };
    case "codex":
      return { file: join(h, ".codex", "config.toml"), present: () => existsSync(join(h, ".codex")), kind: "codex" };
    case "cursor":
      return { file: join(h, ".cursor", "mcp.json"), present: () => existsSync(join(h, ".cursor")), kind: "mcpServers" };
    case "windsurf":
      return { file: join(h, ".codeium", "windsurf", "mcp_config.json"), present: () => existsSync(join(h, ".codeium", "windsurf")), kind: "mcpServers" };
    case "vscode":
      return { file: join(appSupport("Code"), "User", "mcp.json"), present: () => existsSync(join(appSupport("Code"), "User")), kind: "vscode" };
    case "claude-desktop":
      return { file: join(appSupport("Claude"), "claude_desktop_config.json"), present: () => existsSync(appSupport("Claude")), kind: "mcpServers" };
    case "opencode":
      return { file: join(h, ".config", "opencode", "opencode.json"), present: () => existsSync(join(h, ".config", "opencode")), kind: "opencode" };
    default:
      throw new Error(`Unknown app "${id}". Known: ${TOOLS.map((t) => t.id).join(", ")}`);
  }
}

/** The AI apps installed on this computer. */
export function detectTools(): Tool[] {
  return TOOLS.filter((t) => target(t.id).present());
}

/** Whether the Claude Code plug-in is installed (it brings its own MCP server, skill and hooks). */
export function claudePluginInstalled(): boolean {
  try {
    const j = JSON.parse(readFileSync(join(home(), ".claude", "plugins", "installed_plugins.json"), "utf8")) as { plugins?: Record<string, unknown> };
    return Object.keys(j.plugins ?? j).some((k) => k.startsWith("a2a@"));
  } catch {
    return false;
  }
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    if (v === null) return {};
    throw new Error("not an object");
  } catch {
    throw new Error(`${file} isn't plain JSON (it may have comments), so it wasn't changed. Add the a2a server to it by hand.`);
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export interface McpCommand {
  command: string;
  args: string[];
}

/**
 * Adds (or updates) the a2a MCP server in an app's config. Returns where it went, or why not.
 * Only the "a2a" entry is touched; everything else in the file stays as it was.
 */
export function installTool(id: string, mcp: McpCommand): { ok: boolean; where: string } {
  const t = target(id);
  const args = [...mcp.args, "--tool", id];
  switch (t.kind) {
    case "claude-cli": {
      if (claudePluginInstalled()) return { ok: true, where: "the a2a plug-in" };
      const exe = findOnPath("claude");
      if (!exe) return { ok: false, where: "Claude Code's `claude` command isn't on PATH; install the plug-in with /plugin install a2a@a2a" };
      // A .cmd shim needs a shell, and cmd.exe splits unquoted paths with spaces ("C:\Program Files\..."), so quote every argument.
      const shell = /\.(cmd|bat)$/i.test(exe);
      const run = (a: string[]) =>
        spawnSync(shell ? `"${exe}"` : exe, shell ? a.map((x) => `"${x.replace(/"/g, '""')}"`) : a, { stdio: "ignore", windowsHide: true, shell });
      const add = ["mcp", "add", "--scope", "user", "a2a", "--", mcp.command, ...args];
      // Add first; only when an entry already exists, replace it, so a failure never leaves you with none.
      if (run(add).status === 0) return { ok: true, where: "Claude Code (user MCP servers)" };
      if (run(["mcp", "get", "a2a"]).status !== 0) return { ok: false, where: "`claude mcp add` failed; install the plug-in with /plugin install a2a@a2a" };
      run(["mcp", "remove", "--scope", "user", "a2a"]);
      return run(add).status === 0 ? { ok: true, where: "Claude Code (user MCP servers, updated)" } : { ok: false, where: "`claude mcp add` failed after removing the old entry; run `a2a connect --app claude-code` again" };
    }
    case "mcpServers": {
      const j = readJson(t.file);
      j.mcpServers = { ...((j.mcpServers as object) ?? {}), a2a: { command: mcp.command, args } };
      writeJson(t.file, j);
      if (t.skillDir) {
        mkdirSync(t.skillDir, { recursive: true });
        writeFileSync(join(t.skillDir, "SKILL.md"), SKILL_MD);
      }
      return { ok: true, where: t.file };
    }
    case "vscode": {
      const j = readJson(t.file);
      j.servers = { ...((j.servers as object) ?? {}), a2a: { type: "stdio", command: mcp.command, args } };
      writeJson(t.file, j);
      return { ok: true, where: t.file };
    }
    case "opencode": {
      const j = readJson(t.file);
      j.mcp = { ...((j.mcp as object) ?? {}), a2a: { type: "local", command: [mcp.command, ...args], enabled: true, timeout: 600000 } };
      writeJson(t.file, j);
      return { ok: true, where: t.file };
    }
    case "codex": {
      const old = existsSync(t.file) ? readFileSync(t.file, "utf8") : "";
      // Drop an earlier [mcp_servers.a2a] table (up to the next table header), then append the current one.
      let skipping = false;
      const kept = old
        .split(/\r?\n/)
        .filter((line) => {
          // Only real table headers end the skip; a line that merely starts with "[" (inside a multi-line array) doesn't.
          if (/^\s*\[\[?[\w."' -]+\]\]?\s*(#.*)?$/.test(line)) skipping = /^\s*\[mcp_servers\.(a2a|"a2a")(\.[^\]]+)?\]/.test(line);
          return !skipping;
        })
        .join("\n")
        .trimEnd();
      const toml = `[mcp_servers.a2a]\ncommand = ${JSON.stringify(mcp.command)}\nargs = [${args.map((a) => JSON.stringify(a)).join(", ")}]\ntool_timeout_sec = 600\n`;
      mkdirSync(dirname(t.file), { recursive: true });
      writeFileSync(t.file, `${kept ? `${kept}\n\n` : ""}${toml}`);
      return { ok: true, where: t.file };
    }
  }
}
