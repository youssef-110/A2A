import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateAgentKeyPair, newMessageId, newThreadId, signEnvelope, type Envelope, type UnsignedEnvelope } from "@a2a/protocol";
import { HeuristicJudge, type JudgeSet } from "@a2a/guard";
import { startRelay, type RunningRelay } from "../packages/server/src/index.ts";
import { Daemon } from "../packages/client/src/daemon.ts";
import { registerAgent, relayInfo } from "../packages/client/src/relay-api.ts";
import { saveConfig, writeKey, type AgentConfig } from "../packages/client/src/config.ts";

export const ROOT = resolve(import.meta.dirname, "..");
export const ECHO_AGENT = join(ROOT, "examples/agents/echo-agent.mjs");
export const ADMIN = "test-admin-token";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `a2a-${prefix}-`));
}

export async function relay(opts: { dataDir?: string; judges?: JudgeSet | null; policyPath?: string } = {}): Promise<RunningRelay & { dataDir: string }> {
  const dataDir = opts.dataDir ?? tempDir("relay");
  const r = await startRelay({
    dataDir,
    port: 0,
    adminToken: ADMIN,
    judges: opts.judges === undefined ? { fast: new HeuristicJudge() } : opts.judges,
    policyPath: opts.policyPath,
  });
  return Object.assign(r, { dataDir });
}

export interface TestClient {
  home: string;
  daemon: Daemon;
  logs: string[];
  stop(): Promise<void>;
  restart(): Promise<void>;
}

/** Creates a client home with keys registered (as active) on the relay, and starts `a2a run` in-process. */
export async function client(server: string, name: string, agents: Omit<AgentConfig, "key">[], opts: { start?: boolean; home?: string } = {}): Promise<TestClient> {
  const home = opts.home ?? tempDir(name);
  const info = await relayInfo(server);
  const configured: AgentConfig[] = [];
  for (const a of agents) {
    const { privateKeyPem } = generateAgentKeyPair();
    configured.push({ ...a, key: writeKey(home, a.address.split("/").pop()!, privateKeyPem) });
    await registerAgent(server, a.address, privateKeyPem, { adminToken: ADMIN, display_name: a.address.split("/").pop() });
  }
  saveConfig(home, { server, name, relay_public_key: info.relay_public_key, default_agent: agents[0]?.address, agents: configured });

  const logs: string[] = [];
  const c: TestClient = {
    home,
    logs,
    daemon: new Daemon({ home, log: (m) => logs.push(m) }),
    async stop() {
      await c.daemon.stop();
    },
    async restart() {
      c.daemon = new Daemon({ home, log: (m) => logs.push(m) });
      await c.daemon.start();
      await waitFor(() => (c.daemon.info().connected as boolean) === true, 5000, "client reconnect");
    },
  };
  if (opts.start !== false) {
    await c.daemon.start();
    await waitFor(() => (c.daemon.info().connected as boolean) === true, 5000, `${name} connect`);
  }
  return c;
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000, what = "condition"): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

/** A signed envelope built outside any client, for relay-level tests. */
export function envelope(privateKeyPem: string, fields: Partial<UnsignedEnvelope> & Pick<UnsignedEnvelope, "from" | "to">): Envelope {
  return signEnvelope(
    {
      v: 1,
      id: newMessageId(),
      thread_id: newThreadId(),
      in_reply_to: null,
      scope: "customer-support",
      kind: "request",
      body: { text: "Customer #48213 asks about a refund for a double charge." },
      expects_reply: true,
      created_at: new Date().toISOString(),
      ...fields,
    },
    privateKeyPem,
  );
}

export async function adminFetch(server: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(server + path, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
