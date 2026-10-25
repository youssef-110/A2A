import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { ADDRESS_RE, generateAgentKeyPair } from "@a2a/protocol";
import { configPath, keyPath, loadConfig, saveConfig, writeKey, type AgentConfig, type ClientConfig, type RuntimeKind } from "./config.ts";
import { inviteInfo, registerAgent, relayInfo, RelayError } from "./relay-api.ts";

export interface JoinOptions {
  /** Agent name, the part after agent://<org>/. Defaults to the OS user name. */
  name?: string;
  displayName?: string;
  description?: string;
  runtime?: RuntimeKind;
  workdir?: string;
  allowedTools?: string[];
  /** Replace a config that points at a different relay. Keys are kept. */
  force?: boolean;
}

export interface JoinResult {
  address: string;
  server: string;
  org: string;
  status: string;
}

/** Accepts https://relay.example.com/join/<code> (or the bare origin plus a code). */
export function parseInviteLink(link: string): { server: string; code: string } {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error(`That doesn't look like an invite link: ${link}`);
  }
  // https://host/join/<code> for a single relay, https://host/w/<workspace>/join/<code> for a workspace.
  const m = /^((?:\/w\/[a-z0-9-]+)?)\/join\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!m) throw new Error("Invite links look like https://<relay>/join/<code>.");
  return { server: url.origin + m[1], code: m[2]! };
}

export function defaultAgentName(): string {
  let name = "";
  try {
    name = userInfo().username;
  } catch {
    /* no user info in some containers */
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40);
  return slug || "agent";
}

/**
 * Joins a relay with an invite link: pins the relay's key, creates this agent's key (it never
 * leaves the machine) and registers it. The invite makes the agent active without an admin.
 */
export async function joinNetwork(home: string, link: string, opts: JoinOptions = {}): Promise<JoinResult> {
  const { server, code } = parseInviteLink(link);
  const info = await relayInfo(server);
  const invite = await inviteInfo(server, code);
  if (!invite.valid) throw new Error("This invite link is expired, used up or revoked. Ask for a new one.");

  const name = (opts.name ?? defaultAgentName()).toLowerCase();
  const address = `agent://${info.org}/${name}`;
  if (!ADDRESS_RE.test(address)) throw new Error(`"${name}" can't be an agent name: use lowercase letters, digits, dots, dashes or underscores.`);

  let config: ClientConfig;
  if (existsSync(configPath(home))) {
    config = loadConfig(home);
    if (config.server !== server) {
      if (!opts.force) throw new Error(`This machine is already set up for ${config.server}. Pass force to switch to ${server}.`);
      config = { server, name: config.name, relay_public_key: info.relay_public_key, agents: [] };
    } else if (config.relay_public_key && config.relay_public_key !== info.relay_public_key) {
      throw new Error(`The relay at ${server} presented a different key than the one pinned in ${configPath(home)}. Refusing to continue.`);
    }
  } else {
    config = { server, name: name, relay_public_key: info.relay_public_key, agents: [] };
  }
  config.relay_public_key = info.relay_public_key;

  let entry = config.agents.find((a) => a.address === address);
  let pem: string;
  if (entry && existsSync(keyPath(home, entry))) {
    pem = readFileSync(keyPath(home, entry), "utf8");
  } else {
    pem = generateAgentKeyPair().privateKeyPem;
    entry = { address, key: writeKey(home, name, pem), runtime: opts.runtime ?? "none" };
    config.agents = config.agents.filter((a) => a.address !== address).concat(entry);
  }
  const updated: AgentConfig = {
    ...entry,
    runtime: opts.runtime ?? entry.runtime,
    ...(opts.workdir ? { workdir: opts.workdir } : {}),
    ...(opts.allowedTools?.length ? { allowed_tools: opts.allowedTools } : {}),
    ...(opts.displayName ? { display_name: opts.displayName } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  };
  config.agents = config.agents.map((a) => (a.address === address ? updated : a));
  config.default_agent ??= address;

  let status: string;
  try {
    status = (await registerAgent(server, address, pem, { invite: code, display_name: updated.display_name ?? name, description: updated.description })).status;
  } catch (err) {
    if (err instanceof RelayError && err.code === "key_conflict") throw new Error(`The name "${name}" is already taken on this relay. Pick another name.`);
    throw err;
  }
  saveConfig(home, config);
  return { address, server, org: info.org, status };
}
