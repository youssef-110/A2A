import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { KeyObject } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadPrivateKey } from "@a2a/protocol";

export type RuntimeKind = "none" | "claude" | "codex" | "opencode" | "command";
export type SpawnOn = "request" | "notify" | "reply";

export interface AgentConfig {
  address: string;
  key: string;
  /** The relay this agent lives on, when it isn't the main one (someone else's workspace you were invited into). */
  server?: string;
  /** The AI app this agent speaks for: claude-code, antigravity, cursor, ... Each app gets its own agent. */
  tool?: string;
  display_name?: string;
  description?: string;
  runtime: RuntimeKind;
  /** command runtime: the program and arguments. codex runtime: optional replacement for `codex exec`. */
  command?: string[];
  workdir?: string;
  /** Tools the spawned agent may use, in addition to the a2a tools (Claude Code names; mapped for OpenCode). */
  allowed_tools?: string[];
  /** claude: alias or model id. codex: model id. opencode: provider/model, e.g. anthropic/claude-sonnet-5-5. */
  model?: string;
  permission_mode?: string;
  /** Extra system prompt text for the spawned agent. */
  instructions?: string;
  session?: "per_thread" | "none";
  max_concurrent?: number;
  timeout?: string;
  spawn_on?: SpawnOn[];
}

export interface ClientConfig {
  server: string;
  name: string;
  relay_public_key?: string;
  /** Other relays this computer is in, each with its pinned key (workspaces of people who invited you). */
  networks?: { server: string; relay_public_key: string; name?: string }[];
  /** The base of this person's agent names: "sam" for sam-claude, sam-antigravity, ... */
  person?: string;
  default_agent?: string;
  agents: AgentConfig[];
}

export function resolveHome(explicit?: string): string {
  return resolve(explicit ?? process.env.A2A_HOME ?? join(homedir(), ".a2a"));
}

/** Unix socket paths are limited to ~104 bytes on macOS, so long homes get a hashed path in tmp. */
export function socketPath(home: string): string {
  if (process.env.A2A_SOCKET) return process.env.A2A_SOCKET;
  const p = join(home, "a2a.sock");
  if (Buffer.byteLength(p) < 100) return p;
  return join(tmpdir(), `a2a-${createHash("sha256").update(home).digest("hex").slice(0, 16)}.sock`);
}

/** Windows can block Unix socket listen (EACCES), so there the daemon uses loopback TCP instead. */
export const useTcpIpc = process.platform === "win32";

/** Where the Windows daemon writes its loopback port and per-run token. */
export const ipcInfoPath = (home: string): string => join(home, "run", "ipc.json");

export const configPath = (home: string): string => join(home, "config.yaml");

export function loadConfig(home: string): ClientConfig {
  const path = configPath(home);
  if (!existsSync(path)) throw new Error(`No a2a config at ${path}. Run \`a2a init --server <relay url>\` first.`);
  const raw = parseYaml(readFileSync(path, "utf8")) as Partial<ClientConfig>;
  if (!raw?.server) throw new Error(`${path}: server is required`);
  return {
    server: raw.server.replace(/\/$/, ""),
    name: raw.name ?? "a2a-client",
    relay_public_key: raw.relay_public_key,
    ...(raw.networks?.length ? { networks: raw.networks } : {}),
    ...(raw.person ? { person: raw.person } : {}),
    default_agent: raw.default_agent,
    agents: raw.agents ?? [],
  };
}

/** The relay an agent of this computer lives on. */
export const serverOf = (config: ClientConfig, agent: AgentConfig): string => agent.server ?? config.server;

/** Every relay this computer connects to, the main one first. */
export const serversOf = (config: ClientConfig): string[] => [...new Set([config.server, ...(config.networks ?? []).map((n) => n.server), ...config.agents.map((a) => serverOf(config, a))])];

/** The pinned key of a relay, if known. */
export const relayKeyOf = (config: ClientConfig, server: string): string | undefined =>
  server === config.server ? config.relay_public_key : config.networks?.find((n) => n.server === server)?.relay_public_key;

export function pinRelayKey(config: ClientConfig, server: string, key: string, name?: string): void {
  if (server === config.server) {
    config.relay_public_key = key;
    return;
  }
  const n = (config.networks ??= []).find((x) => x.server === server);
  if (n) n.relay_public_key = key;
  else config.networks.push({ server, relay_public_key: key, ...(name ? { name } : {}) });
}

/**
 * The agents one AI app speaks as, one per relay. Without a tool: the default agent plus agents
 * of the same name on other relays (what `a2a join` creates).
 */
export function agentsFor(config: ClientConfig, tool?: string): AgentConfig[] {
  if (tool) return config.agents.filter((a) => a.tool === tool);
  const main = config.agents.find((a) => a.address === config.default_agent) ?? config.agents[0];
  if (!main) return [];
  if (main.tool) return [main, ...config.agents.filter((a) => a !== main && a.tool === main.tool)];
  const short = main.address.split("/").pop();
  return [main, ...config.agents.filter((a) => a !== main && !a.tool && a.address.split("/").pop() === short)];
}

export function saveConfig(home: string, config: ClientConfig): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const header = "# a2a client config. Edit agents here, then restart `a2a run`.\n";
  writeFileSync(configPath(home), header + stringifyYaml(config, { lineWidth: 0 }), { mode: 0o600 });
}

export function keyPath(home: string, agent: AgentConfig): string {
  return isAbsolute(agent.key) ? agent.key : join(home, agent.key);
}

export function loadAgentKey(home: string, agent: AgentConfig): KeyObject {
  return loadPrivateKey(readFileSync(keyPath(home, agent), "utf8"));
}

export function writeKey(home: string, name: string, pem: string): string {
  const dir = join(home, "keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name}.pem`);
  writeFileSync(file, pem, { mode: 0o600 });
  chmodSync(file, 0o600);
  return `keys/${name}.pem`;
}

export function pickAgent(config: ClientConfig, requested?: string): AgentConfig {
  const address = requested ?? process.env.A2A_AGENT ?? config.default_agent;
  if (address) {
    const a = config.agents.find((x) => x.address === address);
    if (!a) throw new Error(`${address} is not an agent on this client. Agents here: ${config.agents.map((x) => x.address).join(", ") || "none"}`);
    return a;
  }
  if (config.agents.length === 1) return config.agents[0]!;
  throw new Error("Several agents are configured; pass --from/--agent or set default_agent in config.yaml.");
}

const DURATION_RE = /^(\d+)\s*(s|m|h)$/;
export function durationMs(value: string | undefined, fallbackMs: number): number {
  const m = value ? DURATION_RE.exec(value.trim()) : null;
  if (!m) return fallbackMs;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3600_000 }[m[2] as "s"];
}
