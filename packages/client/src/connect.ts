import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADDRESS_RE, generateAgentKeyPair } from "@a2a/protocol";
import { configPath, keyPath, loadConfig, pinRelayKey, relayKeyOf, saveConfig, serverOf, serversOf, writeKey, type AgentConfig, type ClientConfig } from "./config.ts";
import { personSlug, type Account } from "./account.ts";
import { inviteInfo, registerAgent, relayInfo, RelayError } from "./relay-api.ts";
import { parseInviteLink } from "./join.ts";
import { installTool, toolById, type McpCommand } from "./tools.ts";

export interface Provisioned {
  address: string;
  tool?: string;
  server: string;
  status: string;
  sessions: string[];
}

/** Exact origin match: "https://site.dev.evil.com" must not pass for "https://site.dev". */
export const sameOrigin = (url: string, origin: string): boolean => {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
};

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Makes sure an app has an agent on a relay, registered to the signed-in person. Reuses the one it
 * has (joining the invite's session with it), adopts a pre-account agent for Claude Code, or creates
 * <person>-<app>. Agents the relay doesn't let in (pending) aren't kept.
 */
export async function ensureAgent(
  home: string,
  config: ClientConfig,
  opts: { server: string; tool?: string; token?: string; invite?: string; person: string },
): Promise<Provisioned> {
  const { server, tool, token, invite } = opts;
  const t = tool ? toolById(tool) : undefined;
  const display = `${capitalize(opts.person)}${tool ? ` (${t?.label ?? tool})` : ""}`;
  const onServer = config.agents.filter((a) => serverOf(config, a) === server);
  let existing = onServer.find((a) => (a.tool ?? undefined) === tool);
  // Agents made before apps had their own: the first one becomes Claude Code's.
  if (!existing && tool === "claude-code") {
    existing = onServer.find((a) => !a.tool);
    if (existing) existing.tool = tool;
  }
  if (existing) {
    const pem = readFileSync(keyPath(home, existing), "utf8");
    const r = await registerAgent(server, existing.address, pem, { token, invite, display_name: existing.display_name ?? display });
    return { address: existing.address, tool, server, status: r.status, sessions: r.sessions.map((s) => s.name) };
  }

  const info = await relayInfo(server);
  if (!relayKeyOf(config, server)) pinRelayKey(config, server, info.relay_public_key, info.name);
  else if (relayKeyOf(config, server) !== info.relay_public_key) throw new Error(`The relay at ${server} presented a different key than the one pinned in ${configPath(home)}. Refusing to continue.`);
  const base = tool ? `${opts.person}-${(t?.suffix ?? tool).toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}` : opts.person;
  const pem = generateAgentKeyPair().privateKeyPem;
  for (let i = 1; i <= 9; i++) {
    const name = i === 1 ? base : `${base}${i}`;
    const address = `agent://${info.org}/${name}`;
    if (!ADDRESS_RE.test(address)) throw new Error(`"${name}" can't be an agent name: use lowercase letters, digits, dots, dashes or underscores.`);
    let r: Awaited<ReturnType<typeof registerAgent>>;
    try {
      r = await registerAgent(server, address, pem, { token, invite, display_name: display });
    } catch (err) {
      if (err instanceof RelayError && err.code === "key_conflict") continue; // someone else has this name here
      throw err;
    }
    if (r.status !== "active") return { address, tool, server, status: r.status, sessions: [] };
    const entry: AgentConfig = {
      address,
      key: writeKey(home, `${info.org}-${name}`, pem),
      ...(server !== config.server ? { server } : {}),
      ...(tool ? { tool } : {}),
      display_name: display,
      runtime: "none",
    };
    config.agents.push(entry);
    config.default_agent ??= address;
    return { address, tool, server, status: r.status, sessions: r.sessions.map((s) => s.name) };
  }
  throw new Error(`Couldn't find a free agent name like ${base} on ${server}.`);
}

/** A config for a computer that has never used A2A: its main relay is the person's own workspace. */
async function newConfig(server: string, person: string): Promise<ClientConfig> {
  const info = await relayInfo(server);
  return { server, name: hostname(), relay_public_key: info.relay_public_key, person, agents: [] };
}

/**
 * Where apps should run a2a from. When this is the bundled single-file client (npx or the plug-in),
 * it copies itself to <home>/bin/a2a.mjs, so app configs keep working after npx cleans its cache.
 */
export function selfInstall(home: string): McpCommand {
  const self = process.env.A2A_CLI ?? fileURLToPath(import.meta.url);
  if (self.endsWith(".ts")) return { command: process.execPath, args: ["--disable-warning=ExperimentalWarning", join(self, "..", "cli.ts"), "mcp"] };
  const dest = join(home, "bin", "a2a.mjs");
  if (self !== dest) {
    mkdirSync(join(home, "bin"), { recursive: true });
    copyFileSync(self, dest);
  }
  return { command: process.execPath, args: ["--disable-warning=ExperimentalWarning", dest, "mcp"] };
}

export interface ConnectResult {
  account: Account;
  agents: Provisioned[];
  installed: { tool: string; ok: boolean; where: string }[];
  session?: string | null;
}

/**
 * The whole setup: the person is signed in (account), every app gets an agent in their own
 * workspace, and with an invite link each app's agent joins that session too. App configs get the
 * a2a MCP server unless install is false.
 */
export async function connectApps(
  home: string,
  account: Account,
  opts: { link?: string; tools: string[]; person?: string; install?: boolean },
): Promise<ConnectResult> {
  const own = `${account.origin}/w/${account.workspace}`;
  let config: ClientConfig;
  const person = opts.person ?? (existsSync(configPath(home)) ? loadConfig(home).person : undefined) ?? personSlug(account.user.name, account.user.email);
  if (existsSync(configPath(home))) {
    config = loadConfig(home);
    config.person ??= person;
  } else config = await newConfig(own, person);

  const agents: Provisioned[] = [];
  const tools = opts.tools.length ? opts.tools : [undefined as unknown as string];
  for (const tool of tools) agents.push(await ensureAgent(home, config, { server: own, tool, token: account.token, person: config.person ?? person }));

  let session: string | null | undefined;
  if (opts.link) {
    const { server, code } = parseInviteLink(opts.link);
    const invite = await inviteInfo(server, code);
    if (!invite.valid) throw new Error("This invite link is expired or the session was deleted. Ask for a new link.");
    session = invite.session ?? null;
    // The sign-in token only ever goes to the site it came from. Another relay gets the invite alone.
    const token = sameOrigin(server, account.origin) ? account.token : undefined;
    if (server !== own) for (const tool of tools) agents.push(await ensureAgent(home, config, { server, tool, token, invite: code, person: config.person ?? person }));
  }
  saveConfig(home, config);

  const installed: ConnectResult["installed"] = [];
  if (opts.install !== false) {
    const mcp = selfInstall(home);
    for (const tool of opts.tools) {
      try {
        installed.push({ tool, ...installTool(tool, mcp) });
      } catch (err) {
        installed.push({ tool, ok: false, where: (err as Error).message });
      }
    }
  }
  return { account, agents, installed, session };
}

/**
 * An app started its MCP server but has no agent yet (installed after `connect`, or a new app):
 * give it one on every relay this computer is in, using the saved sign-in.
 */
export async function provisionTool(home: string, tool: string, account: Account): Promise<Provisioned[]> {
  const config = loadConfig(home);
  const person = config.person ?? personSlug(account.user.name, account.user.email);
  config.person = person;
  const out: Provisioned[] = [];
  for (const server of serversOf(config)) {
    // Only relays on the signed-in site can tell who the person is.
    if (!sameOrigin(server, account.origin)) continue;
    try {
      out.push(await ensureAgent(home, config, { server, tool, token: account.token, person }));
    } catch {
      /* that relay is unreachable or refuses; the others still work */
    }
  }
  saveConfig(home, config);
  return out;
}
