import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { randomBytes, type KeyObject } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  ADDRESS_RE,
  canonicalize,
  helloSigningString,
  newMessageId,
  newRunId,
  newThreadId,
  PROTOCOL_VERSION,
  signEnvelope,
  signString,
  verifyEnvelope,
  verifyString,
  type Envelope,
  type MessageKind,
} from "@a2a/protocol";
import { durationMs, loadAgentKey, loadConfig, pickAgent, saveConfig, socketPath, type AgentConfig, type ClientConfig } from "./config.ts";
import { openState, type State } from "./state.ts";
import { relayInfo, signedGet, submitEnvelope } from "./relay-api.ts";
import { buildPrompt, runAgent, type InboundMessage } from "./runtimes.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = resolve(here, "cli.ts");

const iso = (): string => new Date().toISOString();
const TERMINAL_FAILURES = new Set(["blocked", "rejected", "expired"]);

export interface SendOptions {
  from?: string;
  to: string;
  text: string;
  scope?: string;
  thread_id?: string;
  in_reply_to?: string;
  kind?: MessageKind;
  expects_reply?: boolean;
}

export interface SendResult {
  id: string;
  thread_id: string;
  scope: string;
  state: string;
  reason_code: string | null;
  reply?: InboundMessage;
  timed_out?: boolean;
}

interface WaitResult {
  reply?: InboundMessage;
  state?: string;
  reason_code?: string | null;
}

interface DeliveryPayload {
  id: string;
  thread_id: string;
  in_reply_to: string | null;
  from: string;
  to: string;
  scope: string;
  kind: string;
  expects_reply: boolean;
  hop: number;
  created_at: string;
  text: string;
  redacted: boolean;
  modified: boolean;
  envelope?: Envelope;
  relay_sig: string;
  [k: string]: unknown;
}

export class ClientError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DaemonOptions {
  home: string;
  log?: (msg: string) => void;
}

/** `a2a run`: the one long-running process per machine. */
export class Daemon {
  readonly home: string;
  config!: ClientConfig;
  private state!: State;
  private readonly keys = new Map<string, KeyObject>();
  private readonly log: (msg: string) => void;
  private ws?: WebSocket;
  private connected = false;
  private accepted: string[] = [];
  private rejected: { address: string; reason: string }[] = [];
  private stopping = false;
  private backoffMs = 500;
  private reconnectTimer?: NodeJS.Timeout;
  private outboxTimer?: NodeJS.Timeout;
  private ipc?: Server;
  private readonly replyWaiters = new Map<string, Set<(r: WaitResult) => void>>();
  private readonly statusWaiters = new Map<string, Set<() => void>>();
  private readonly inboxWaiters = new Map<string, ((m: InboundMessage) => void)[]>();
  private readonly senderKeys = new Map<string, string>();
  private readonly running = new Map<string, number>();
  private readonly backlog = new Map<string, InboundMessage[]>();
  private readonly activeRuns = new Set<Promise<void>>();
  private flushing = false;

  constructor(opts: DaemonOptions) {
    this.home = opts.home;
    this.log = opts.log ?? ((m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`));
  }

  async start(): Promise<void> {
    this.config = loadConfig(this.home);
    if (this.config.agents.length === 0) throw new Error("No agents configured. Add one with `a2a agents add agent://<org>/<name>`.");
    mkdirSync(join(this.home, "run"), { recursive: true, mode: 0o700 });
    for (const a of this.config.agents) this.keys.set(a.address, loadAgentKey(this.home, a));
    this.state = openState(this.home);

    if (!this.config.relay_public_key) {
      const info = await relayInfo(this.config.server);
      this.config.relay_public_key = info.relay_public_key;
      saveConfig(this.home, this.config);
      this.log(`pinned relay key for ${this.config.server}`);
    }

    await this.startIpc();
    this.connect();
    this.outboxTimer = setInterval(() => void this.flushOutbox(), 2000);
    this.outboxTimer.unref();

    // Messages that were stored but never handled (e.g. the client stopped mid-run) are dispatched again.
    const pending = this.state.prepare("SELECT delivery FROM inbox WHERE handled = 0 ORDER BY received_at").all() as { delivery: string }[];
    for (const p of pending) {
      const m = JSON.parse(p.delivery) as InboundMessage;
      const agent = this.agent(m.to);
      if (agent && agent.runtime !== "none") this.dispatch(agent, m);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.outboxTimer);
    this.ws?.close();
    await new Promise<void>((r) => (this.ipc ? this.ipc.close(() => r()) : r()));
    try {
      unlinkSync(socketPath(this.home));
    } catch {
      /* already gone */
    }
    await Promise.allSettled([...this.activeRuns]);
    this.state?.close();
  }

  private agent(address: string): AgentConfig | undefined {
    return this.config.agents.find((a) => a.address === address);
  }

  // ------------------------------------------------------------ relay connection

  private connect(): void {
    if (this.stopping) return;
    const url = `${this.config.server.replace(/^http/, "ws")}/v1/stream`;
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on("message", (data) => {
      try {
        void this.onFrame(ws, JSON.parse(data.toString()));
      } catch (err) {
        this.log(`bad frame from relay: ${(err as Error).message}`);
      }
    });
    ws.on("close", (code, reason) => {
      const was = this.connected;
      this.connected = false;
      if (this.stopping) return;
      if (was) this.log(`disconnected from relay (${code}${reason.length ? ` ${reason}` : ""}), reconnecting`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    });
    ws.on("error", (err) => {
      if (this.backoffMs <= 1000) this.log(`relay connection error: ${err.message}`);
    });
  }

  /** Status updates are pushed only while connected, so after (re)connecting, ask for any we may have missed. */
  private async reconcile(): Promise<void> {
    const open = this.state.prepare("SELECT id, from_addr FROM sent WHERE state IN ('screening', 'held', 'queued') AND created_at > ? LIMIT 200").all(new Date(Date.now() - 86_400_000).toISOString()) as { id: string; from_addr: string }[];
    for (const m of open) {
      if (this.stopping) return;
      try {
        const r = await signedGet(this.config.server, m.from_addr, this.keys.get(m.from_addr)!, `/v1/messages/${encodeURIComponent(m.id)}`);
        const row = this.state.prepare("SELECT state FROM sent WHERE id = ?").get(m.id) as { state: string };
        if (r.state !== row.state) this.onStatus({ id: m.id, state: String(r.state), reason_code: (r.reason_code as string | null) ?? null });
      } catch {
        /* relay unreachable again; the next connect retries */
      }
    }
  }

  private async onFrame(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    if (this.stopping) return;
    if (msg.type === "challenge") {
      if (msg.relay_public_key !== this.config.relay_public_key) {
        this.log("relay key does not match the pinned key in config.yaml; refusing to authenticate");
        ws.close(4010, "relay key mismatch");
        return;
      }
      const nonce = String(msg.nonce);
      const agents = this.config.agents.map((a) => ({ address: a.address, sig: signString(helloSigningString(nonce, a.address), this.keys.get(a.address)!) }));
      ws.send(JSON.stringify({ type: "hello", client: this.config.name, agents }));
    } else if (msg.type === "welcome") {
      this.accepted = (msg.accepted as string[]) ?? [];
      this.rejected = (msg.rejected as { address: string; reason: string }[]) ?? [];
      this.connected = this.accepted.length > 0;
      this.backoffMs = 500;
      this.log(`connected to ${this.config.server} as ${this.accepted.join(", ") || "(no agents)"}`);
      for (const r of this.rejected) this.log(`  ${r.address} not accepted: ${r.reason}${r.reason === "agent_pending" ? " (approve it in the relay console)" : ""}`);
      void this.flushOutbox();
      void this.reconcile();
    } else if (msg.type === "deliver") {
      await this.onDeliver(ws, msg.message as DeliveryPayload);
    } else if (msg.type === "status") {
      this.onStatus(msg as { id: string; state: string; reason_code: string | null });
    }
  }

  private async senderKey(sender: string, asAgent: string): Promise<string | undefined> {
    const cached = this.senderKeys.get(sender);
    if (cached) return cached;
    try {
      const r = await signedGet(this.config.server, asAgent, this.keys.get(asAgent)!, `/v1/keys/${encodeURIComponent(sender)}`);
      this.senderKeys.set(sender, String(r.public_key));
      return String(r.public_key);
    } catch {
      return undefined;
    }
  }

  private async onDeliver(ws: WebSocket, d: DeliveryPayload): Promise<void> {
    const { relay_sig, ...signed } = d;
    if (!verifyString(canonicalize(signed), relay_sig, this.config.relay_public_key!)) {
      this.log(`dropped ${d.id}: relay signature invalid`);
      return;
    }
    const agent = this.agent(d.to);
    if (!agent) return;

    let senderVerified = false;
    if (d.envelope) {
      const key = await this.senderKey(d.from, d.to);
      senderVerified = !!key && verifyEnvelope(d.envelope, key) && d.envelope.id === d.id && d.envelope.body.text === d.text && d.envelope.from === d.from;
      if (!senderVerified) {
        this.log(`dropped ${d.id}: sender signature did not verify`);
        return;
      }
    }

    const m: InboundMessage = {
      id: d.id,
      thread_id: d.thread_id,
      in_reply_to: d.in_reply_to,
      from: d.from,
      to: d.to,
      scope: d.scope,
      kind: d.kind,
      expects_reply: d.expects_reply,
      hop: d.hop,
      text: d.text,
      redacted: d.redacted,
      modified: d.modified,
      sender_verified: senderVerified,
    };

    const fresh = this.state.prepare("INSERT OR IGNORE INTO seen (id, received_at) VALUES (?, ?)").run(d.id, iso()).changes === 1;
    if (fresh) {
      this.state
        .prepare("INSERT OR IGNORE INTO inbox (id, thread_id, scope, from_addr, to_addr, kind, in_reply_to, expects_reply, text, redacted, delivery, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(m.id, m.thread_id, m.scope, m.from, m.to, m.kind, m.in_reply_to, m.expects_reply ? 1 : 0, m.text, m.redacted ? 1 : 0, JSON.stringify(m), iso());
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ack", id: d.id }));
    if (!fresh) return;

    this.log(`◀ ${m.id} ${m.from} -> ${m.to} (${m.kind}${m.redacted ? ", redacted" : ""})`);

    // A reply someone is waiting on goes to the waiter instead of starting the agent again.
    const waiters = m.in_reply_to ? this.replyWaiters.get(m.in_reply_to) : undefined;
    if (waiters?.size) {
      for (const w of waiters) w({ reply: m });
      this.replyWaiters.delete(m.in_reply_to!);
      this.markHandled(m.id);
      return;
    }
    if (agent.runtime === "none") {
      const queue = this.inboxWaiters.get(agent.address);
      const next = queue?.shift();
      if (next) {
        this.markHandled(m.id);
        next(m);
      }
      return;
    }
    this.dispatch(agent, m);
  }

  private onStatus(u: { id: string; state: string; reason_code: string | null }): void {
    if (this.stopping) return;
    this.state.prepare("UPDATE sent SET state = ?, reason_code = ?, updated_at = ? WHERE id = ?").run(u.state, u.reason_code, iso(), u.id);
    if (u.state !== "screening" && u.state !== "pending") {
      for (const w of this.statusWaiters.get(u.id) ?? []) w();
      this.statusWaiters.delete(u.id);
    }
    if (TERMINAL_FAILURES.has(u.state)) {
      this.log(`✕ ${u.id} ${u.state}${u.reason_code ? ` (${u.reason_code})` : ""}`);
      const waiters = this.replyWaiters.get(u.id);
      if (waiters) {
        for (const w of waiters) w({ state: u.state, reason_code: u.reason_code });
        this.replyWaiters.delete(u.id);
      }
    } else if (u.state === "held") {
      this.log(`⏸ ${u.id} held for review by the relay`);
    }
  }

  private markHandled(id: string): void {
    this.state.prepare("UPDATE inbox SET handled = 1 WHERE id = ?").run(id);
  }

  // ------------------------------------------------------------ sending

  private async resolveScope(from: string, to: string, threadId?: string): Promise<string | undefined> {
    if (threadId) {
      const local = this.state.prepare("SELECT scope FROM sent WHERE thread_id = ? UNION SELECT scope FROM inbox WHERE thread_id = ? LIMIT 1").get(threadId, threadId) as { scope: string } | undefined;
      if (local) return local.scope;
      try {
        const t = await signedGet(this.config.server, from, this.keys.get(from)!, `/v1/threads/${threadId}`);
        return String(t.scope);
      } catch {
        /* new thread id chosen by the caller */
      }
    }
    const dir = await this.directory(from);
    const target = dir.find((a) => a.address === to);
    if (target?.scopes.length === 1) return target.scopes[0]!.name;
    if (target && target.scopes.length > 1) throw new ClientError(400, `${from} can message ${to} under several scopes (${target.scopes.map((s) => s.name).join(", ")}); pass a scope.`);
    return undefined;
  }

  async directory(agent: string): Promise<{ address: string; display_name: string | null; description: string | null; online: boolean; scopes: { name: string; description: string }[] }[]> {
    const r = await signedGet(this.config.server, agent, this.keys.get(agent)!, "/v1/directory");
    return r.agents as never;
  }

  private waitFor(id: string, timeoutMs: number): { promise: Promise<WaitResult & { timed_out?: boolean }>; cancel: () => void } {
    let done: (r: WaitResult & { timed_out?: boolean }) => void = () => {};
    const promise = new Promise<WaitResult & { timed_out?: boolean }>((res) => (done = res));
    const waiter = (r: WaitResult): void => {
      clearTimeout(timer);
      done(r);
    };
    let set = this.replyWaiters.get(id);
    if (!set) this.replyWaiters.set(id, (set = new Set()));
    set.add(waiter);
    const cancel = (): void => {
      clearTimeout(timer);
      this.replyWaiters.get(id)?.delete(waiter);
    };
    const timer = setTimeout(() => {
      cancel();
      const row = this.state.prepare("SELECT state, reason_code FROM sent WHERE id = ?").get(id) as { state: string; reason_code: string | null } | undefined;
      done({ state: row?.state, reason_code: row?.reason_code, timed_out: true });
    }, timeoutMs);
    return { promise, cancel };
  }

  /** Resolves on the first status update past screening (or after the timeout). */
  private waitVerdict(id: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let set = this.statusWaiters.get(id);
      if (!set) this.statusWaiters.set(id, (set = new Set()));
      const done = (): void => {
        clearTimeout(timer);
        this.statusWaiters.get(id)?.delete(done);
        resolve();
      };
      set.add(done);
      const timer = setTimeout(done, timeoutMs);
    });
  }

  /**
   * Sends a message. Always waits (up to verdictMs) for the guard's verdict so the caller learns
   * whether it was delivered, held or blocked; with waitMs > 0 it also waits for the reply.
   */
  async send(o: SendOptions, waitMs = 0, verdictMs = 60_000): Promise<SendResult> {
    const agent = pickAgent(this.config, o.from);
    if (!ADDRESS_RE.test(o.to)) throw new ClientError(400, `"${o.to}" is not an agent address (agent://<org>/<name>)`);
    if (!o.text?.trim()) throw new ClientError(400, "message text is empty");

    let threadId = o.thread_id;
    let inReplyTo = o.in_reply_to ?? null;
    if (inReplyTo && !threadId) {
      const parent = this.state.prepare("SELECT thread_id FROM inbox WHERE id = ? UNION SELECT thread_id FROM sent WHERE id = ? LIMIT 1").get(inReplyTo, inReplyTo) as { thread_id: string } | undefined;
      if (!parent) throw new ClientError(400, `unknown message ${inReplyTo}`);
      threadId = parent.thread_id;
    }
    const scope = o.scope ?? (await this.resolveScope(agent.address, o.to, threadId));
    if (!scope) throw new ClientError(400, `${agent.address} has no link to ${o.to} in the relay policy. Pass --scope to send anyway (the relay will decide).`);
    threadId ??= newThreadId();
    const kind: MessageKind = o.kind ?? (inReplyTo ? "reply" : "request");
    if (kind === "reply" && !inReplyTo) throw new ClientError(400, "a reply needs in_reply_to");

    const env = signEnvelope(
      {
        v: PROTOCOL_VERSION,
        id: newMessageId(),
        thread_id: threadId,
        in_reply_to: inReplyTo,
        from: agent.address,
        to: o.to,
        scope,
        kind,
        body: { text: o.text },
        expects_reply: o.expects_reply ?? kind === "request",
        created_at: iso(),
      },
      this.keys.get(agent.address)!,
    );

    const wait = waitMs > 0 && env.expects_reply ? this.waitFor(env.id, waitMs) : undefined;
    const verdict = verdictMs > 0 ? this.waitVerdict(env.id, verdictMs) : undefined;
    const now = iso();
    this.state.prepare("INSERT INTO sent (id, thread_id, scope, from_addr, to_addr, kind, text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)").run(env.id, env.thread_id, scope, env.from, env.to, kind, o.text, now, now);
    this.state.prepare("INSERT INTO outbox (id, envelope, next_at, created_at) VALUES (?, ?, 0, ?)").run(env.id, JSON.stringify(env), now);
    this.log(`▶ ${env.id} ${env.from} -> ${env.to} (${kind}, ${scope})`);
    await this.flushOne(env.id);
    const submitted = this.state.prepare("SELECT state FROM sent WHERE id = ?").get(env.id) as { state: string };
    if (verdict && submitted.state === "screening") await verdict;

    const row = this.state.prepare("SELECT state, reason_code FROM sent WHERE id = ?").get(env.id) as { state: string; reason_code: string | null };
    const base: SendResult = { id: env.id, thread_id: env.thread_id, scope, state: row.state, reason_code: row.reason_code };
    if (!wait) return base;
    if (TERMINAL_FAILURES.has(row.state)) {
      wait.cancel();
      return base;
    }
    const r = await wait.promise;
    const latest = this.state.prepare("SELECT state, reason_code FROM sent WHERE id = ?").get(env.id) as { state: string; reason_code: string | null };
    // Every status update is persisted before waiters run, so the stored row is the freshest state.
    return { ...base, state: latest.state, reason_code: latest.reason_code, reply: r.reply, timed_out: r.timed_out };
  }

  private async flushOne(id: string): Promise<void> {
    const row = this.state.prepare("SELECT envelope, attempts FROM outbox WHERE id = ?").get(id) as { envelope: string; attempts: number } | undefined;
    if (!row) return;
    try {
      const r = await submitEnvelope(this.config.server, JSON.parse(row.envelope));
      if (r.status === 200 || r.status === 202) {
        this.state.prepare("DELETE FROM outbox WHERE id = ?").run(id);
        this.state.prepare("UPDATE sent SET state = ?, reason_code = ?, updated_at = ? WHERE id = ? AND state = 'pending'").run(String(r.body.state), (r.body.reason_code as string | null) ?? null, iso(), id);
        if (r.body.state === "blocked") this.onStatus({ id, state: "blocked", reason_code: (r.body.reason_code as string) ?? null });
      } else if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
        this.state.prepare("DELETE FROM outbox WHERE id = ?").run(id);
        this.log(`relay rejected ${id}: ${r.body.error}${r.body.detail ? ` (${r.body.detail})` : ""}`);
        this.onStatus({ id, state: "rejected", reason_code: String(r.body.error ?? r.status) });
      } else {
        throw new Error(`relay returned ${r.status} ${r.body.error ?? ""}`);
      }
    } catch (err) {
      const attempts = row.attempts + 1;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
      this.state.prepare("UPDATE outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?").run(attempts, Date.now() + delay, (err as Error).message, id);
      this.state.prepare("UPDATE sent SET state = 'pending', updated_at = ? WHERE id = ?").run(iso(), id);
    }
  }

  private async flushOutbox(): Promise<void> {
    if (this.flushing || this.stopping) return;
    this.flushing = true;
    try {
      const due = this.state.prepare("SELECT id FROM outbox WHERE next_at <= ? ORDER BY created_at LIMIT 50").all(Date.now()) as { id: string }[];
      for (const { id } of due) await this.flushOne(id);
    } finally {
      this.flushing = false;
    }
  }

  // ------------------------------------------------------------ running agents

  private dispatch(agent: AgentConfig, m: InboundMessage): void {
    const spawnOn = agent.spawn_on ?? ["request", "notify"];
    if (!spawnOn.includes(m.kind as never)) return;
    const max = agent.max_concurrent ?? 1;
    if ((this.running.get(agent.address) ?? 0) >= max) {
      const q = this.backlog.get(agent.address) ?? [];
      q.push(m);
      this.backlog.set(agent.address, q);
      return;
    }
    this.running.set(agent.address, (this.running.get(agent.address) ?? 0) + 1);
    const p = this.processRun(agent, m)
      .catch((err) => this.log(`run for ${m.id} failed: ${(err as Error).stack ?? err}`))
      .finally(() => {
        this.activeRuns.delete(p);
        this.running.set(agent.address, (this.running.get(agent.address) ?? 1) - 1);
        const next = this.backlog.get(agent.address)?.shift();
        if (next && !this.stopping) this.dispatch(agent, next);
      });
    this.activeRuns.add(p);
  }

  private async processRun(agent: AgentConfig, m: InboundMessage): Promise<void> {
    const runId = newRunId();
    const useSessions = agent.session !== "none" && (agent.runtime === "claude" || agent.runtime === "opencode");
    const session = useSessions
      ? (this.state.prepare("SELECT session_id FROM sessions WHERE agent = ? AND thread_id = ?").get(agent.address, m.thread_id) as { session_id: string } | undefined)
      : undefined;
    const env = {
      A2A_HOME: this.home,
      A2A_AGENT: agent.address,
      A2A_THREAD: m.thread_id,
      A2A_MESSAGE_ID: m.id,
      A2A_RUN_ID: runId,
      A2A_SOCKET: socketPath(this.home),
    };
    const mcpConfigPath = join(this.home, "run", `${runId}.mcp.json`);
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { a2a: { type: "stdio", command: process.execPath, args: ["--disable-warning=ExperimentalWarning", CLI_PATH, "mcp"], env } } }, null, 2),
      { mode: 0o600 },
    );
    this.state.prepare("INSERT INTO runs (id, agent, thread_id, message_id, runtime, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)").run(runId, agent.address, m.thread_id, m.id, agent.runtime, iso());
    this.log(`⚙ ${runId} starting ${agent.runtime} for ${agent.address}${session ? " (resuming thread session)" : ""}`);

    const t0 = Date.now();
    const result = await runAgent({
      agent,
      message: m,
      prompt: buildPrompt(m, randomBytes(6).toString("hex")),
      sessionId: session?.session_id,
      env,
      mcpConfigPath,
      timeoutMs: durationMs(agent.timeout, 15 * 60_000),
    });
    rmSync(mcpConfigPath, { force: true });

    this.state
      .prepare("UPDATE runs SET status = ?, ended_at = ?, error = ?, output = ?, cost_usd = ? WHERE id = ?")
      .run(result.error ? "failed" : "succeeded", iso(), result.error ?? null, result.output.slice(0, 20_000), result.costUsd ?? null, runId);
    if (useSessions && result.sessionId) {
      this.state
        .prepare("INSERT INTO sessions (agent, thread_id, runtime, session_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (agent, thread_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at")
        .run(agent.address, m.thread_id, agent.runtime, result.sessionId, iso());
    }
    this.markHandled(m.id);
    this.log(`${result.error ? "✕" : "✓"} ${runId} ${agent.runtime} finished in ${((Date.now() - t0) / 1000).toFixed(1)}s${result.error ? `: ${result.error}` : ""}`);

    const { replied } = this.state.prepare("SELECT replied FROM runs WHERE id = ?").get(runId) as { replied: number };
    if (m.expects_reply && !replied) {
      const text = result.error ? `[a2a] ${agent.address} could not handle this message: ${result.error}` : result.output;
      if (text) await this.send({ from: agent.address, to: m.from, text, thread_id: m.thread_id, in_reply_to: m.id, kind: "reply", expects_reply: false, scope: m.scope }, 0, 0);
    }
  }

  /** Called through the MCP reply tool: replies to the message a run was started for. */
  async replyFromRun(runId: string, text: string, expectsReply = false): Promise<SendResult> {
    const run = this.state.prepare("SELECT agent, message_id FROM runs WHERE id = ?").get(runId) as { agent: string; message_id: string } | undefined;
    if (!run) throw new ClientError(404, `unknown run ${runId}`);
    const m = this.state.prepare("SELECT from_addr, thread_id, scope FROM inbox WHERE id = ?").get(run.message_id) as { from_addr: string; thread_id: string; scope: string };
    const r = await this.send({ from: run.agent, to: m.from_addr, text, thread_id: m.thread_id, in_reply_to: run.message_id, kind: "reply", expects_reply: expectsReply, scope: m.scope });
    this.state.prepare("UPDATE runs SET replied = 1 WHERE id = ?").run(runId);
    return r;
  }

  async nextInbox(agent: string, waitMs: number): Promise<InboundMessage | null> {
    const row = this.state.prepare("SELECT delivery FROM inbox WHERE to_addr = ? AND handled = 0 ORDER BY received_at LIMIT 1").get(agent) as { delivery: string } | undefined;
    if (row) {
      const m = JSON.parse(row.delivery) as InboundMessage;
      this.markHandled(m.id);
      return m;
    }
    if (waitMs <= 0) return null;
    return new Promise((resolve) => {
      const q = this.inboxWaiters.get(agent) ?? [];
      const waiter = (m: InboundMessage): void => {
        clearTimeout(timer);
        resolve(m);
      };
      q.push(waiter);
      this.inboxWaiters.set(agent, q);
      const timer = setTimeout(() => {
        const list = this.inboxWaiters.get(agent) ?? [];
        this.inboxWaiters.set(agent, list.filter((w) => w !== waiter));
        resolve(null);
      }, waitMs);
    });
  }

  info(): Record<string, unknown> {
    const { n: outbox } = this.state.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
    return {
      name: this.config.name,
      server: this.config.server,
      connected: this.connected,
      agents: this.config.agents.map((a) => ({
        address: a.address,
        runtime: a.runtime,
        online: this.accepted.includes(a.address),
        rejected: this.rejected.find((r) => r.address === a.address)?.reason ?? null,
        running: this.running.get(a.address) ?? 0,
        queued: this.backlog.get(a.address)?.length ?? 0,
      })),
      outbox_pending: outbox,
    };
  }

  // ------------------------------------------------------------ local socket API

  private async startIpc(): Promise<void> {
    const path = socketPath(this.home);
    if (existsSync(path)) {
      const alive = await new Promise<boolean>((res) => {
        const s = connect(path);
        s.once("connect", () => {
          s.end();
          res(true);
        });
        s.once("error", () => res(false));
      });
      if (alive) throw new Error(`Another \`a2a run\` is already using ${this.home}.`);
      unlinkSync(path);
    }
    this.ipc = createServer((req, res) => void this.handleIpc(req, res));
    await new Promise<void>((res, rej) => {
      this.ipc!.once("error", rej);
      this.ipc!.listen(path, () => res());
    });
  }

  private async handleIpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://a2a.local");
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      }
      const q = url.searchParams;
      const agentParam = (v: unknown): string => pickAgent(this.config, typeof v === "string" && v ? v : undefined).address;
      const waitMs = (v: unknown, dflt: number): number => Math.min(Math.max(Number(v ?? dflt) || 0, 0), 3600) * 1000;

      switch (`${req.method} ${url.pathname}`) {
        case "GET /info":
          return reply(200, this.info());
        case "POST /send":
          return reply(200, await this.send(body as unknown as SendOptions, waitMs(body.wait_seconds, 0)));
        case "POST /reply": {
          if (typeof body.text !== "string") throw new ClientError(400, "text is required");
          if (typeof body.run_id === "string" && body.run_id) return reply(200, await this.replyFromRun(body.run_id, body.text, Boolean(body.expects_reply)));
          const from = agentParam(body.from);
          let inReplyTo = typeof body.in_reply_to === "string" ? body.in_reply_to : undefined;
          if (!inReplyTo && typeof body.thread_id === "string") {
            const last = this.state.prepare("SELECT id FROM inbox WHERE thread_id = ? AND to_addr = ? ORDER BY received_at DESC LIMIT 1").get(body.thread_id, from) as { id: string } | undefined;
            inReplyTo = last?.id;
          }
          if (!inReplyTo) throw new ClientError(400, "nothing to reply to: pass in_reply_to or a thread with a received message");
          const parent = this.state.prepare("SELECT from_addr FROM inbox WHERE id = ?").get(inReplyTo) as { from_addr: string } | undefined;
          if (!parent) throw new ClientError(404, `no received message ${inReplyTo}`);
          return reply(200, await this.send({ from, to: parent.from_addr, text: body.text, in_reply_to: inReplyTo, kind: "reply", expects_reply: Boolean(body.expects_reply) }));
        }
        case "GET /status": {
          const id = q.get("id") ?? "";
          const local = this.state.prepare("SELECT * FROM sent WHERE id = ?").get(id) as Record<string, unknown> | undefined;
          const from = (local?.from_addr as string | undefined) ?? agentParam(q.get("agent"));
          let remote: Record<string, unknown> | null = null;
          try {
            remote = await signedGet(this.config.server, from, this.keys.get(from)!, `/v1/messages/${encodeURIComponent(id)}`);
          } catch {
            /* offline or unknown */
          }
          if (!local && !remote) throw new ClientError(404, `unknown message ${id}`);
          return reply(200, { local: local ?? null, relay: remote });
        }
        case "GET /thread": {
          const agent = agentParam(q.get("agent"));
          return reply(200, await signedGet(this.config.server, agent, this.keys.get(agent)!, `/v1/threads/${encodeURIComponent(q.get("id") ?? "")}`));
        }
        case "GET /directory":
          return reply(200, { agents: await this.directory(agentParam(q.get("agent"))) });
        case "GET /inbox": {
          const agent = q.get("agent") ? agentParam(q.get("agent")) : null;
          const rows = this.state
            .prepare(`SELECT id, thread_id, from_addr AS "from", to_addr AS "to", kind, text, redacted, handled, received_at FROM inbox ${agent ? "WHERE to_addr = ?" : ""} ORDER BY received_at DESC LIMIT 50`)
            .all(...(agent ? [agent] : []));
          return reply(200, { messages: rows });
        }
        case "POST /inbox/next":
          return reply(200, { message: await this.nextInbox(agentParam(body.agent), waitMs(body.wait_seconds, 0)) });
        case "GET /runs":
          return reply(200, { runs: this.state.prepare("SELECT id, agent, thread_id, message_id, runtime, status, started_at, ended_at, replied, error, cost_usd FROM runs ORDER BY started_at DESC LIMIT 30").all() });
        default:
          return reply(404, { error: `unknown endpoint ${req.method} ${url.pathname}` });
      }
    } catch (err) {
      const status = err instanceof ClientError ? err.status : 500;
      reply(status, { error: (err as Error).message });
    }
  }
}
