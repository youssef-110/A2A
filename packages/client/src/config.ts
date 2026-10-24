import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { KeyObject } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadPrivateKey } from "@a2a/protocol";

export type RuntimeKind = "none" | "claude" | "codex" | "command";
export type SpawnOn = "request" | "notify" | "reply";

export interface AgentConfig {
  address: string;
  key: string;
  display_name?: string;
  description?: string;
  runtime: RuntimeKind;
  /** command runtime: the program and arguments. codex runtime: optional replacement for `codex exec`. */
  command?: string[];
  workdir?: string;
  /** Claude Code tools the spawned agent may use, in addition to the a2a tools. */
  allowed_tools?: string[];
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

export const configPath = (home: string): string => join(home, "config.yaml");

export function loadConfig(home: string): ClientConfig {
  const path = configPath(home);
  if (!existsSync(path)) throw new Error(`No a2a config at ${path}. Run \`a2a init --server <relay url>\` first.`);
  const raw = parseYaml(readFileSync(path, "utf8")) as Partial<ClientConfig>;
  if (!raw?.server) throw new Error(`${path}: server is required`);
  return { server: raw.server.replace(/\/$/, ""), name: raw.name ?? "a2a-client", relay_public_key: raw.relay_public_key, default_agent: raw.default_agent, agents: raw.agents ?? [] };
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
