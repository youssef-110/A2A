import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generateAgentKeyPair } from "@a2a/protocol";
import type { JudgeMode, JudgeSet } from "@a2a/guard";
import { openDb } from "./db.ts";
import { Relay } from "./relay.ts";
import { Hub } from "./hub.ts";
import { createRelayServer } from "./http.ts";

export { Relay, safePreview, type Delivery } from "./relay.ts";
export { Hub } from "./hub.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const CONSOLE_DIR = resolve(here, "../../console/public");
export const DEFAULT_POLICY = resolve(here, "../../../examples/policy.yaml");

export interface StartRelayOptions {
  dataDir: string;
  port?: number;
  host?: string;
  policyPath?: string;
  judge?: JudgeMode;
  judges?: JudgeSet | null;
  adminToken?: string;
  name?: string;
  log?: (msg: string) => void;
}

export interface RunningRelay {
  relay: Relay;
  hub: Hub;
  server: Server;
  url: string;
  adminToken: string;
  close(): Promise<void>;
}

function readOrCreate(path: string, create: () => string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const value = create();
  writeFileSync(path, value + "\n", { mode: 0o600 });
  return value;
}

export async function startRelay(opts: StartRelayOptions): Promise<RunningRelay> {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const adminToken = opts.adminToken ?? process.env.A2A_ADMIN_TOKEN ?? readOrCreate(join(opts.dataDir, "admin-token"), () => randomBytes(24).toString("base64url"));
  const relayKeyPem = readOrCreate(join(opts.dataDir, "relay-key.pem"), () => generateAgentKeyPair().privateKeyPem.trim());
  const db = openDb(join(opts.dataDir, "relay.db"));
  const relay = new Relay({
    db,
    relayKeyPem,
    initialPolicy: readFileSync(opts.policyPath ?? DEFAULT_POLICY, "utf8"),
    judgeOverride: opts.judge,
    judges: opts.judges,
    log: opts.log,
  });
  const hub = new Hub(relay);
  relay.out = hub;
  const server = createRelayServer({ relay, hub, adminToken, consoleDir: CONSOLE_DIR, name: opts.name ?? "a2a-relay" });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(opts.port ?? 7700, opts.host ?? "127.0.0.1", () => res());
  });
  relay.start();
  const addr = server.address() as AddressInfo;
  const url = `http://${addr.address.includes(":") ? `[${addr.address}]` : addr.address}:${addr.port}`;
  return {
    relay,
    hub,
    server,
    url,
    adminToken,
    async close() {
      relay.stop();
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await relay.idle();
      db.close();
    },
  };
}
