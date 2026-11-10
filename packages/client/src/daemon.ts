import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { randomBytes, type KeyObject } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
import {
  agentsFor,
  durationMs,
  ipcInfoPath,
  loadAgentKey,
  loadConfig,
  pickAgent,
  pinRelayKey,
  relayKeyOf,
  saveConfig,
  serverOf,
  serversOf,
  socketPath,
  useTcpIpc,
  type AgentConfig,
  type AutoReplyRule,
  type ClientConfig,
} from "./config.ts";
import { openState, type State } from "./state.ts";
import { RelayError, relayInfo, signedGet, signedSend, submitEnvelope } from "./relay-api.ts";
import { buildPrompt, buildTaskPrompt, runAgent, taskIdOf, toolsFor, type InboundMessage, type TaskPermissions } from "./runtimes.ts";
import { toolById } from "./tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = resolve(here, "cli.ts");

const iso = (): string => new Date().toISOString();
const TERMINAL_FAILURES = new Set(["blocked", "rejected", "expired"]);

/** The headless runtime that answers for an app, when its owner turns auto-reply on. */
export const APP_RUNTIME: Record<string, "claude" | "codex" | "opencode"> = { "claude-code": "claude", codex: "codex", opencode: "opencode" };
const RUNTIME_BIN: Record<string, string> = { claude: "claude", codex: "codex", opencode: "opencode" };
/** Auto-runs one thread may start per hour, whatever the per-agent limits: a guard against loops. */
const THREAD_RUNS_PER_HOUR = 6;

/** Whether a program can be started: on PATH (with Windows extensions), or an existing path. */
function onPath(bin: string): boolean {
  if (/[\\/]/.test(bin)) return existsSync(bin);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat("") : [""];
  return (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").some((dir) => dir && exts.some((e) => existsSync(join(dir, bin + e.toLowerCase())) || existsSync(join(dir, bin + e))));
}

type AutoDecision = { run: true; rule?: AutoReplyRule; board?: boolean } | { run: false; why: string };

/** One relay connection. A computer can be in several workspaces (its own, and sessions others invited it into). */
interface Link {
  server: string;
  ws?: WebSocket;
  connected: boolean;
  accepted: string[];
  rejected: { address: string; reason: string }[];
  backoffMs: number;
  timer?: NodeJS.Timeout;
}

type DirectoryEntry = { address: string; display_name: string | null; description: string | null; person?: string | null; online: boolean; scopes: { name: string; description: string }[] };

export interface SendOptions {
  from?: string;
  /** The AI app sending (claude-code, antigravity, ...): picks which of this computer's agents speaks. */
  tool?: string;
  to: string;
  text: string;
  scope?: string;
  thread_id?: string;
  in_reply_to?: string;
  kind?: MessageKind;
  expects_reply?: boolean;
  /** Files to send along, e.g. a context capsule. Base64 data; the relay limits the whole message size. */
  attachments?: { name: string; mime: string; data: string }[];
  /** The session this is for: an id, or a name of a session the sending agent is in. Replies keep the parent's. */
  session?: string;
  /** Written by an agent on its own (an auto-reply run), not at a person's request. */
  auto?: boolean;
  /** Sent from inside a headless run: marks it automated and keeps the run's session. */
  run_id?: string;
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
  /** Called when a local client asks this daemon to stop (POST /stop), e.g. to restart after joining a network. */
  onStopRequest?: () => void;
}

/** `a2a run`: the one long-running process per machine. */
export class Daemon {
  readonly home: string;
  config!: ClientConfig;
  private state!: State;
  private readonly keys = new Map<string, KeyObject>();
  private readonly log: (msg: string) => void;
  private readonly links = new Map<string, Link>();
  private stopping = false;
  private flushTimer?: NodeJS.Timeout;
  private ipc?: Server;
  private ipcToken = "";
  private readonly replyWaiters = new Map<string, Set<(r: WaitResult) => void>>();
  private readonly statusWaiters = new Map<string, Set<() => void>>();
  private readonly inboxWaiters = new Map<string, ((m: InboundMessage) => void)[]>();
  private readonly senderKeys = new Map<string, string>();
  private readonly running = new Map<string, number>();
  private readonly backlog = new Map<string, InboundMessage[]>();
  private readonly activeRuns = new Set<Promise<void>>();
  private flushing = false;
  private readonly directoryCache = new Map<string, { at: number; agents: DirectoryEntry[] }>();
  private readonly onStopRequest?: () => void;

  constructor(opts: DaemonOptions) {
    this.home = opts.home;
    this.onStopRequest = opts.onStopRequest;
    this.log = opts.log ?? ((m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`));
  }

  async start(): Promise<void> {
    this.config = loadConfig(this.home);
    if (this.config.agents.length === 0) throw new Error("No agents configured. Add one with `a2a agents add agent://<org>/<name>`.");
    mkdirSync(join(this.home, "run"), { recursive: true, mode: 0o700 });
    for (const a of this.config.agents) this.keys.set(a.address, loadAgentKey(this.home, a));
    this.state = openState(this.home);
    await this.pinKeys();

    await this.startIpc();
    for (const server of serversOf(this.config)) this.connect(server);
    // No timer runs while idle: the outbox is flushed when something is sent, and retried only while it holds messages.
    this.scheduleFlush();

    // Auto-runs that were accepted but never finished (the client stopped mid-run) start again, if still allowed.
    // Messages that were left for the owner stay in the inbox, even if auto-reply has been turned on since.
    this.state.prepare("UPDATE runs SET status = 'failed', ended_at = ?, error = 'the client stopped during this run' WHERE status = 'running'").run(iso());
    this.state.prepare("UPDATE inbox SET handled = 1 WHERE handled = 0 AND auto = 1 AND id IN (SELECT message_id FROM runs WHERE replied = 1)").run();
    const pending = this.state.prepare("SELECT delivery FROM inbox WHERE handled = 0 AND auto = 1 ORDER BY received_at").all() as { delivery: string }[];
    for (const p of pending) {
      const m = JSON.parse(p.delivery) as InboundMessage;
      const agent = this.agent(m.to);
      if (agent) this.dispatch(agent, m);
    }
  }

  /** Relays without a pinned key get theirs fetched once; after that a different key is refused. */
  private async pinKeys(): Promise<void> {
    let changed = false;
    for (const server of serversOf(this.config)) {
      if (relayKeyOf(this.config, server)) continue;
      try {
        pinRelayKey(this.config, server, (await relayInfo(server)).relay_public_key);
        changed = true;
        this.log(`pinned relay key for ${server}`);
      } catch (err) {
        this.log(`could not reach ${server} to pin its key: ${(err as Error).message}`);
      }
    }
    if (changed) saveConfig(this.home, this.config);
  }

  /**
   * Picks up config changes (a new app connected, a new session joined) without dropping in-flight
   * waits: new keys load, new relays connect, and relays with new agents reconnect to say hello again.
   */
  async reload(): Promise<void> {
    const before = new Map([...this.links.values()].map((l) => [l.server, this.agentsOn(l.server).map((a) => a.address).join(",")]));
    this.config = loadConfig(this.home);
    for (const a of this.config.agents) if (!this.keys.has(a.address)) this.keys.set(a.address, loadAgentKey(this.home, a));
    await this.pinKeys();
    this.directoryCache.clear();
    for (const server of serversOf(this.config)) {
      const link = this.links.get(server);
      if (!link || !link.ws) this.connect(server);
      else if (before.get(server) !== this.agentsOn(server).map((a) => a.address).join(",")) link.ws?.close(4000, "reload");
    }
    // Auto-reply may have been turned on or off: tell each relay, so the session pages show it.
    for (const link of this.links.values()) if (link.connected && link.ws?.readyState === link.ws?.OPEN) this.reportListening(link);
    this.log(`reloaded config: ${this.config.agents.length} agent(s) on ${serversOf(this.config).length} relay(s)`);
  }

  private agentsOn(server: string): AgentConfig[] {
    return this.config.agents.filter((a) => serverOf(this.config, a) === server);
  }

  /** The relay an agent of this computer lives on. */
  private serverFor(address: string): string {
    const a = this.agent(address);
    if (!a) throw new ClientError(400, `${address} is not an agent on this computer`);
    return serverOf(this.config, a);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.flushTimer);
    for (const l of this.links.values()) {
      clearTimeout(l.timer);
      l.ws?.close();
    }
    await new Promise<void>((r) => (this.ipc ? this.ipc.close(() => r()) : r()));
    try {
      unlinkSync(useTcpIpc ? ipcInfoPath(this.home) : socketPath(this.home));
    } catch {
      /* already gone */
    }
    await Promise.allSettled([...this.activeRuns]);
    this.state?.close();
  }

  private agent(address: string): AgentConfig | undefined {
    return this.config.agents.find((a) => a.address === address);
  }

  // ------------------------------------------------------------ relay connections

  private connect(server: string): void {
    if (this.stopping) return;
    let link = this.links.get(server);
    if (!link) this.links.set(server, (link = { server, connected: false, accepted: [], rejected: [], backoffMs: 500 }));
    const l = link;
    if (!this.agentsOn(server).length) return; // nothing to say hello with yet
    const ws = new WebSocket(`${server.replace(/^http/, "ws")}/v1/stream`, { handshakeTimeout: 10_000 });
    l.ws = ws;
    // App-level keepalive: a hibernating Cloudflare relay answers this without waking up, and proxies see traffic.
    const keepalive = setInterval(() => ws.readyState === ws.OPEN && ws.send('{"type":"ping"}'), 30_000);
    keepalive.unref();
    ws.on("message", (data) => {
      try {
        void this.onFrame(l, ws, JSON.parse(data.toString()));
      } catch (err) {
        this.log(`bad frame from relay: ${(err as Error).message}`);
      }
    });
    ws.on("close", (code, reason) => {
      clearInterval(keepalive);
      if (l.ws !== ws) return;
      const was = l.connected;
      l.connected = false;
      if (this.stopping) return;
      if (code === 4000) l.backoffMs = 100; // our own reload: reconnect right away
      else if (was) this.log(`disconnected from ${server} (${code}${reason.length ? ` ${reason}` : ""}), reconnecting`);
      l.timer = setTimeout(() => this.connect(server), l.backoffMs);
      l.backoffMs = Math.min(l.backoffMs * 2, 15_000);
    });
    ws.on("error", (err) => {
      if (l.backoffMs <= 1000) this.log(`relay connection error (${server}): ${err.message}`);
    });
  }

  /** True when at least one relay accepted at least one agent. */
  private get connected(): boolean {
    return [...this.links.values()].some((l) => l.connected);
  }

  private isAccepted(address: string): boolean {
    return [...this.links.values()].some((l) => l.accepted.includes(address));
  }

  /** Status updates are pushed only while connected, so after (re)connecting, ask for any we may have missed. */
  private async reconcile(link: Link): Promise<void> {
    const open = this.state.prepare("SELECT id, from_addr FROM sent WHERE state IN ('screening', 'held', 'queued') AND created_at > ? LIMIT 200").all(new Date(Date.now() - 86_400_000).toISOString()) as { id: string; from_addr: string }[];
    for (const m of open) {
      if (this.stopping) return;
      const agent = this.agent(m.from_addr);
      if (!agent || serverOf(this.config, agent) !== link.server) continue;
      try {
        const r = await signedGet(link.server, m.from_addr, this.keys.get(m.from_addr)!, `/v1/messages/${encodeURIComponent(m.id)}`);
        const row = this.state.prepare("SELECT state FROM sent WHERE id = ?").get(m.id) as { state: string };
        if (r.state !== row.state) this.onStatus({ id: m.id, state: String(r.state), reason_code: (r.reason_code as string | null) ?? null });
      } catch {
        /* relay unreachable again; the next connect retries */
      }
    }
  }

  private async onFrame(link: Link, ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    if (this.stopping) return;
    if (msg.type === "challenge") {
      if (msg.relay_public_key !== relayKeyOf(this.config, link.server)) {
        this.log(`${link.server}: relay key does not match the pinned key in config.yaml; refusing to authenticate`);
        ws.close(4010, "relay key mismatch");
        return;
      }
      const nonce = String(msg.nonce);
      const agents = this.agentsOn(link.server).map((a) => ({ address: a.address, sig: signString(helloSigningString(nonce, a.address), this.keys.get(a.address)!) }));
      ws.send(JSON.stringify({ type: "hello", client: this.config.name, agents }));
    } else if (msg.type === "welcome") {
      link.accepted = (msg.accepted as string[]) ?? [];
      link.rejected = (msg.rejected as { address: string; reason: string }[]) ?? [];
      link.connected = link.accepted.length > 0;
      link.backoffMs = 500;
      this.log(`connected to ${link.server} as ${link.accepted.join(", ") || "(no agents)"}`);
      for (const r of link.rejected) this.log(`  ${r.address} not accepted: ${r.reason}${r.reason === "agent_pending" ? " (approve it in the relay console)" : ""}`);
      void this.flushOutbox();
      void this.reconcile(link);
      this.reportListening(link);
    } else if (msg.type === "deliver") {
      await this.onDeliver(link, ws, msg.message as DeliveryPayload);
    } else if (msg.type === "status") {
      this.onStatus(msg as { id: string; state: string; reason_code: string | null });
    } else if (msg.type === "notice") {
      this.onNotice(link, msg);
    }
  }

  /** Something happened to a session this computer is in, e.g. its owner deleted it. */
  private onNotice(link: Link, msg: Record<string, unknown>): void {
    const address = typeof msg.address === "string" ? msg.address : "";
    if (!this.agent(address) || serverOf(this.config, this.agent(address)!) !== link.server) return;
    const session = (msg.session ?? {}) as { id?: string; name?: string | null };
    // The owner flipped the switch on their own signed-in page (the relay only passes it on for the
    // agent's own account). This computer still decides: a config can turn website switches off.
    if (msg.kind === "auto_reply" && session.id) {
      if (this.config.web_controls === false) {
        this.log(`ignored a website request to change auto-reply for ${address} (web_controls: false)`);
        this.reportListening(link);
        return;
      }
      void this.setAutoReply({ action: msg.on === true ? "on" : "off", session: session.id, agents: [address] })
        .then(() => this.log(`auto-reply ${msg.on === true ? "on" : "off"} for ${address} in "${session.name ?? session.id}" (from your website)`))
        .catch((err) => {
          this.log(`could not change auto-reply for ${address}: ${(err as Error).message}`);
          this.reportListening(link);
        });
      return;
    }
    const text =
      msg.kind === "session_deleted"
        ? `The session "${session.name ?? session.id}" was deleted by its owner. You can no longer reach the people in it.`
        : msg.kind === "session_removed"
          ? `You were removed from the session "${session.name ?? session.id}".`
          : `Notice from the relay: ${String(msg.kind)}`;
    this.state.prepare("INSERT INTO notices (address, kind, text, created_at) VALUES (?, ?, ?, ?)").run(address, String(msg.kind), text, iso());
    this.directoryCache.clear();
    this.log(`ℹ ${address}: ${text}`);
  }

  private async senderKey(sender: string, asAgent: string): Promise<string | undefined> {
    const server = this.serverFor(asAgent);
    const cacheKey = `${server} ${sender}`;
    const cached = this.senderKeys.get(cacheKey);
    if (cached) return cached;
    try {
      const r = await signedGet(server, asAgent, this.keys.get(asAgent)!, `/v1/keys/${encodeURIComponent(sender)}`);
      this.senderKeys.set(cacheKey, String(r.public_key));
      return String(r.public_key);
    } catch {
      return undefined;
    }
  }

  private async onDeliver(link: Link, ws: WebSocket, d: DeliveryPayload): Promise<void> {
    const { relay_sig, ...signed } = d;
    if (!verifyString(canonicalize(signed), relay_sig, relayKeyOf(this.config, link.server)!)) {
      this.log(`dropped ${d.id}: relay signature invalid`);
      return;
    }
    const agent = this.agent(d.to);
    // A relay may only deliver to agents that live on it.
    if (!agent || serverOf(this.config, agent) !== link.server) return;
    // A relay serves one org, so a real sender is always in the recipient's org. Another workspace's relay
    // must not be able to pose as someone from this one.
    if (d.from.split("/")[2] !== d.to.split("/")[2]) {
      this.log(`dropped ${d.id}: ${link.server} delivered a message claiming to be from ${d.from}`);
      return;
    }
    let senderVerified = false;
    if (d.envelope) {
      const key = await this.senderKey(d.from, d.to);
      senderVerified =
        !!key &&
        verifyEnvelope(d.envelope, key) &&
        d.envelope.id === d.id &&
        d.envelope.body.text === d.text &&
        d.envelope.from === d.from &&
        // Files are covered by the sender's signature too, not only by the relay's.
        canonicalize(d.envelope.body.attachments ?? null) === canonicalize(d.attachments ?? null);
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
      files: this.saveAttachments(d.id, d.attachments as { name: string; mime: string; data: string }[] | undefined),
      ...(d.session !== undefined ? { session: (d.session as { id: string; name: string } | null) ?? null } : {}),
      ...(d.auto === true ? { automated: true } : {}),
      sent_at: d.created_at,
      received_at: iso(),
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
    const decision = this.autoDecision(agent, m);
    if (!decision.run) {
      if (agent.runtime !== "none") this.log(`· ${m.id} left in the inbox for ${agent.address}: ${decision.why}`);
      const queue = this.inboxWaiters.get(agent.address);
      const next = queue?.shift();
      if (next) {
        this.markHandled(m.id);
        next(m);
      }
      return;
    }
    this.state.prepare("UPDATE inbox SET auto = 1 WHERE id = ?").run(m.id);
    this.dispatch(agent, m);
  }

  // ------------------------------------------------------------ auto-reply

  /**
   * Whether a delivered message starts a headless run. Everything here is this computer's decision: the
   * agent is its owner's, the owner turned it on for this exact session, the message is a new request,
   * and the local limits allow it. Anything else stays in the inbox for the owner.
   */
  autoDecision(agent: AgentConfig, m: InboundMessage): AutoDecision {
    const no = (why: string): AutoDecision => ({ run: false, why });
    if (agent.runtime === "none") return no("auto-reply is off");
    // The task board's notes are autopilot's, a separate switch the owner turns on with the autopilot tool.
    const fromBoard = m.from.endsWith("/console") && m.sender_verified !== false && /^\[a2a-(task \S+|mission)\]/.test(m.text);
    if (fromBoard) return agent.autopilot ? { run: true, board: true } : no("autopilot is off");
    if (m.session === null) return no("the message isn't tied to one session (the sender shares several with this agent and named none)");
    const key = m.session === undefined ? "workspace" : m.session.id;
    const rule = (agent.auto_reply ?? []).find((r) => r.session === key);
    if (!rule) return no(`auto-reply is off ${m.session ? `in "${m.session.name}"` : "on this relay"}`);
    if (m.kind !== "request") return no(`a ${m.kind} never starts an auto-reply`);
    if (m.automated) return no("loop guard: another agent's automated request never starts an auto-reply");

    const count = (sql: string, ...args: (string | number)[]): number => Number((this.state.prepare(sql).get(...args) as { n: number | null }).n ?? 0);
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    if (count("SELECT COUNT(*) AS n FROM runs WHERE auto = 1 AND thread_id = ? AND started_at > ?", m.thread_id, hourAgo) >= THREAD_RUNS_PER_HOUR) return no(`thread limit: ${THREAD_RUNS_PER_HOUR} auto-replies in this thread in the last hour`);
    const inScope = "auto = 1 AND agent = ? AND COALESCE(session_id, 'workspace') = ?";
    if (count(`SELECT COUNT(*) AS n FROM runs WHERE ${inScope} AND started_at > ?`, agent.address, key, hourAgo) >= (rule.max_per_hour ?? 20)) return no(`rate limit: ${rule.max_per_hour ?? 20} auto-replies per hour`);
    // Even a sender that leaves out the automated mark can't take the whole hourly budget.
    const perSender = Math.max(2, Math.ceil((rule.max_per_hour ?? 20) / 2));
    if (count("SELECT COUNT(*) AS n FROM runs r JOIN inbox i ON i.id = r.message_id WHERE r.auto = 1 AND r.agent = ? AND i.from_addr = ? AND r.started_at > ?", agent.address, m.from, hourAgo) >= perSender) {
      return no(`per-sender limit: ${perSender} auto-replies per hour to ${m.from.split("/").pop()}`);
    }
    if (rule.cooldown_s) {
      const since = new Date(Date.now() - rule.cooldown_s * 1000).toISOString();
      if (count(`SELECT COUNT(*) AS n FROM runs WHERE ${inScope} AND started_at > ?`, agent.address, key, since) > 0) return no(`cooling down for ${rule.cooldown_s}s after the last auto-reply`);
    }
    const today = new Date().toISOString().slice(0, 10);
    if (rule.daily_usd !== undefined && count("SELECT SUM(cost_usd) AS n FROM runs WHERE auto = 1 AND agent = ? AND started_at >= ?", agent.address, today) >= rule.daily_usd) return no(`daily spend cap of $${rule.daily_usd} reached`);
    if (rule.daily_tokens !== undefined && count("SELECT SUM(tokens) AS n FROM runs WHERE auto = 1 AND agent = ? AND started_at >= ?", agent.address, today) >= rule.daily_tokens) return no(`daily token cap of ${rule.daily_tokens} reached`);
    return { run: true, rule };
  }

  /** Tells a relay which sessions this computer's agents there answer in on their own, so its pages can show it. */
  private reportListening(link: Link): void {
    const agents = this.agentsOn(link.server)
      .filter((a) => link.accepted.includes(a.address))
      .map((a) => ({
        address: a.address,
        sessions: a.runtime === "none" ? [] : (a.auto_reply ?? []).map((r) => r.session).filter((s) => s !== "workspace"),
        runtime: a.runtime === "none" ? null : a.runtime,
        tasks: a.runtime !== "none" && !!a.autopilot,
        capable: a.runtime !== "none" || !!(a.tool && APP_RUNTIME[a.tool]),
        ready: this.runtimeReady(a.runtime === "none" && a.tool && APP_RUNTIME[a.tool] ? { ...a, runtime: APP_RUNTIME[a.tool]! } : a),
      }));
    if (agents.length && link.ws && link.ws.readyState === link.ws.OPEN) link.ws.send(JSON.stringify({ type: "listening", agents }));
  }

  /** Whether an agent's runtime can actually start on this computer. */
  runtimeReady(a: AgentConfig): boolean {
    if (a.runtime === "none") return false;
    if (a.runtime === "command") return !!a.command?.length && onPath(a.command[0]!);
    if (a.runtime === "claude" && process.env.A2A_CLAUDE_BIN) return onPath(process.env.A2A_CLAUDE_BIN);
    return onPath(RUNTIME_BIN[a.runtime] ?? a.runtime);
  }

  /**
   * The auto-reply matrix: every session each of this computer's agents is in, whether it answers there
   * on its own, with what, and within which limits. Relays without sessions show one "workspace" row.
   */
  async autoReplyMatrix(): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (const a of this.config.agents) {
      const r = await signedGet(this.serverFor(a.address), a.address, this.keys.get(a.address)!, "/v1/sessions").catch(() => null);
      const sessions = ((r?.sessions as { id: string; name: string }[] | undefined) ?? []).map((s) => ({ id: s.id, name: s.name }));
      if (r && !sessions.length && (a.auto_reply ?? []).some((x) => x.session === "workspace")) sessions.push({ id: "workspace", name: "Whole workspace (no sessions)" });
      for (const s of sessions) {
        const rule = (a.auto_reply ?? []).find((x) => x.session === s.id);
        const recent = this.state
          .prepare("SELECT AVG(delivery_ms) AS delivery_ms, AVG(start_ms) AS start_ms, AVG(model_ms) AS model_ms, COUNT(*) AS runs FROM (SELECT * FROM runs WHERE auto = 1 AND agent = ? AND COALESCE(session_id, 'workspace') = ? ORDER BY started_at DESC LIMIT 20)")
          .get(a.address, s.id) as { delivery_ms: number | null; start_ms: number | null; model_ms: number | null; runs: number };
        rows.push({
          session_id: s.id,
          session: s.name,
          agent: a.address,
          app: a.tool ? (toolById(a.tool)?.label ?? a.tool) : (a.display_name ?? a.address.split("/").pop()),
          enabled: !!rule && a.runtime !== "none",
          runtime: a.runtime,
          runtime_ready: this.runtimeReady(a),
          workdir: a.workdir ?? null,
          tools: a.allowed_tools ?? [],
          model: a.model ?? null,
          limits: rule
            ? { max_concurrent: rule.max_concurrent ?? 1, cooldown_s: rule.cooldown_s ?? 0, max_per_hour: rule.max_per_hour ?? 20, max_tokens: rule.max_tokens ?? null, timeout: rule.timeout ?? "15m", daily_usd: rule.daily_usd ?? null, daily_tokens: rule.daily_tokens ?? null }
            : null,
          autopilot: a.runtime !== "none" && !!a.autopilot,
          running: this.running.get(a.address) ?? 0,
          recent: recent.runs ? { runs: recent.runs, avg_delivery_ms: Math.round(recent.delivery_ms ?? 0), avg_start_ms: Math.round(recent.start_ms ?? 0), avg_model_ms: Math.round(recent.model_ms ?? 0) } : null,
        });
      }
    }
    return rows;
  }

  /**
   * Turns auto-reply on for some of this computer's agents in one session, or off for one agent, one
   * session or everything. Only reachable from this computer (the local socket, with its token).
   */
  async setAutoReply(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (body.run_id) throw new ClientError(403, "An auto-reply run can't change auto-reply settings. Only the owner can, from their own app or terminal.");
    const action = body.action === "on" ? "on" : body.action === "off" ? "off" : null;
    if (!action) throw new ClientError(400, 'action must be "on" or "off"');
    const config = this.config;
    const wanted = Array.isArray(body.agents) ? (body.agents as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : [];
    const tool = typeof body.tool === "string" && body.tool ? body.tool : undefined;
    const apps = Array.isArray(body.apps) ? (body.apps as unknown[]).filter((x): x is string => typeof x === "string") : [];
    let targets = wanted.length
      ? wanted.map((w) => pickAgent(config, w))
      : apps.length
        ? config.agents.filter((a) => a.tool && apps.includes(a.tool))
        : tool
          ? config.agents.filter((a) => a.tool === tool)
          : action === "off"
            ? config.agents
            : [];
    if (!targets.length) throw new ClientError(400, action === "on" ? "Name the agents to turn on (for example claude-code or robin-codex)." : "No agents match.");

    let session: { id: string; name: string } | null = null;
    const sessionArg = typeof body.session === "string" ? body.session.trim() : "";
    const local = sessionArg ? config.agents.flatMap((a) => a.auto_reply ?? []).find((r) => r.session === sessionArg || r.name?.toLowerCase() === sessionArg.toLowerCase()) : undefined;
    if (action === "off" && local) session = { id: local.session, name: local.name ?? local.session };
    else if (sessionArg) {
      const rows = await this.autoReplyMatrix();
      const match = rows.find((r) => r.session_id === sessionArg) ?? rows.find((r) => String(r.session).toLowerCase() === sessionArg.toLowerCase());
      if (match) session = { id: String(match.session_id), name: String(match.session) };
      else if (sessionArg === "workspace") session = { id: "workspace", name: "Whole workspace (no sessions)" };
      else throw new ClientError(404, `None of your agents is in a session called "${sessionArg}".`);
    }

    const changed: string[] = [];
    if (action === "on") {
      if (!session) throw new ClientError(400, "Name the session to turn auto-reply on in. There is no switch for every session at once.");
      const sessionId = session.id;
      if (sessionId !== "workspace") {
        const rows = await this.autoReplyMatrix();
        targets = targets.filter((a) => rows.some((r) => r.agent === a.address && r.session_id === sessionId));
        if (!targets.length) throw new ClientError(400, `None of those agents is in "${session.name}".`);
      }
      const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
      for (const a of targets) {
        if (a.runtime === "none") {
          const runtime = a.tool ? APP_RUNTIME[a.tool] : undefined;
          if (!runtime) throw new ClientError(400, `${a.tool ? (toolById(a.tool)?.label ?? a.tool) : a.address} can't run headless, so it can't answer on its own. Claude Code, Codex and OpenCode can.`);
          a.runtime = runtime;
        }
        if (typeof body.workdir === "string" && body.workdir) a.workdir = body.workdir;
        else a.workdir ??= homedir();
        if (Array.isArray(body.tools) && body.tools.length) a.allowed_tools = (body.tools as unknown[]).filter((t): t is string => typeof t === "string");
        else a.allowed_tools = a.allowed_tools?.length ? a.allowed_tools : ["Read", "Grep", "Glob"];
        if (typeof body.model === "string" && body.model) a.model = body.model;
        const rule: AutoReplyRule = {
          session: sessionId,
          name: session.name,
          set_at: iso(),
          ...Object.fromEntries(
            (["max_concurrent", "cooldown_s", "max_per_hour", "max_tokens", "daily_usd", "daily_tokens"] as const).flatMap((k) => (num(body[k]) !== undefined ? [[k, num(body[k])]] : [])),
          ),
          ...(typeof body.timeout === "string" && body.timeout ? { timeout: body.timeout } : {}),
        };
        a.auto_reply = [...(a.auto_reply ?? []).filter((r) => r.session !== sessionId), rule];
        changed.push(a.address);
      }
    } else {
      for (const a of targets) {
        const before = a.auto_reply?.length ?? 0;
        a.auto_reply = body.all === true || !session ? [] : (a.auto_reply ?? []).filter((r) => r.session !== session!.id);
        if ((a.auto_reply?.length ?? 0) !== before) changed.push(a.address);
      }
    }
    saveConfig(this.home, config);
    await this.reload();
    return { ok: true, action, session, changed, matrix: await this.autoReplyMatrix() };
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
        const t = await signedGet(this.serverFor(from), from, this.keys.get(from)!, `/v1/threads/${threadId}`);
        return String(t.scope);
      } catch {
        /* new thread id chosen by the caller */
      }
    }
    // Someone may have joined since the cached copy: look once more before giving up.
    const target = (await this.directory(from, true)).find((a) => a.address === to) ?? (await this.directory(from)).find((a) => a.address === to);
    // Several scopes: prefer "general", else the first. The relay still decides.
    const names = target?.scopes.map((s) => s.name) ?? [];
    return names.includes("general") ? "general" : names[0];
  }

  /** Writes a message's attachments under <home>/files/<id>/, so agents get paths instead of megabytes of base64. */
  private saveAttachments(id: string, attachments: { name: string; mime: string; data: string }[] | undefined): InboundMessage["files"] {
    if (!attachments?.length) return undefined;
    const dir = join(this.home, "files", id.replace(/[^A-Za-z0-9_]/g, ""));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return attachments.map((a, i) => {
      const name = basename(a.name).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[.]+/, "").slice(0, 120) || `file-${i + 1}`;
      const data = Buffer.from(a.data, "base64");
      const path = join(dir, name);
      writeFileSync(path, data, { mode: 0o600 });
      return { name, path, bytes: data.length, mime: a.mime };
    });
  }

  /**
   * Lets people say "guest-theo" or "theo" instead of agent://acme/guest-theo. Only the address's
   * own name counts: display names are chosen by each agent, so matching them would let anyone pose
   * as "Theo". "theo" also finds theo-claude or theo-antigravity (preferring the one online).
   * Looks through every agent this app speaks as, so it reaches people in any of its workspaces.
   */
  private async resolveRoute(candidates: string[], name: string): Promise<{ from: string; to: string }> {
    const want = name.trim().replace(/^@/, "").toLowerCase();
    const norm = (s: string): string => s.toLowerCase().replace(/[\s_.-]+/g, "");
    const short = (a: { address: string }): string => a.address.split("/").pop()!;
    type Hit = DirectoryEntry & { via: string };
    const find = (d: Hit[]): Hit[] => {
      const exact = d.filter((a) => short(a) === want);
      if (exact.length) return exact;
      const loose = d.filter((a) => norm(short(a)) === norm(want));
      if (loose.length) return loose;
      const prefix = d.filter((a) => short(a).startsWith(`${want}-`));
      const online = prefix.filter((a) => a.online);
      return online.length ? online : prefix;
    };
    const gather = async (cached: boolean): Promise<Hit[]> =>
      (await Promise.all(candidates.map(async (c) => (await this.directory(c, cached).catch(() => [])).map((a) => ({ ...a, via: c }))))).flat();
    let dir = await gather(true);
    let matches = find(dir);
    // Someone may have joined since the cached copy: look once more before giving up.
    if (!matches.length) matches = find((dir = await gather(false)));
    const unique = [...new Map(matches.map((m) => [m.address, m])).values()];
    if (unique.length === 1) return { from: unique[0]!.via, to: unique[0]!.address };
    const known = [...new Set(dir.map((a) => `${a.address}${a.person ? ` (${a.person})` : a.display_name ? ` (${a.display_name})` : ""}`))].join(", ") || "none";
    if (!unique.length) throw new ClientError(404, `No agent called "${name}". Agents you can reach: ${known}`);
    throw new ClientError(400, `"${name}" matches several agents: ${unique.map((a) => a.address).join(", ")}. Use the full address.`);
  }

  /** The agents this agent can reach. Sends use a copy up to 30 s old, which saves a relay round trip per message. */
  async directory(agent: string, cached = false): Promise<DirectoryEntry[]> {
    const hit = this.directoryCache.get(agent);
    if (cached && hit && Date.now() - hit.at < 30_000) return hit.agents;
    const r = await signedGet(this.serverFor(agent), agent, this.keys.get(agent)!, "/v1/directory");
    this.directoryCache.set(agent, { at: Date.now(), agents: r.agents as never });
    return r.agents as never;
  }

  /** Who this app can reach across all of its workspaces, each with the agent it would send as. */
  async reachable(tool?: string): Promise<(DirectoryEntry & { via: string })[]> {
    const lists = await Promise.all(this.speakers(tool).map(async (a) => (await this.directory(a.address).catch(() => [])).map((d) => ({ ...d, via: a.address }))));
    return lists.flat();
  }

  /** The agents an app speaks as: its own (one per relay), or the default agent and its namesakes. */
  speakers(tool?: string): AgentConfig[] {
    const own = agentsFor(this.config, tool);
    if (own.length || !tool) return own;
    return agentsFor(this.config);
  }

  /** The sessions this app's agents are in, with each session's shared brief and people. */
  async sessions(tool?: string): Promise<Record<string, unknown>[]> {
    const lists = await Promise.all(
      this.speakers(tool).map(async (a) => {
        const r = await signedGet(this.serverFor(a.address), a.address, this.keys.get(a.address)!, "/v1/sessions").catch(() => ({ sessions: [] }));
        return ((r.sessions as Record<string, unknown>[]) ?? []).map((s) => ({ ...s, you: a.address, workspace: a.address.split("/")[2] }));
      }),
    );
    return lists.flat();
  }

  async setBrief(tool: string | undefined, sessionId: string, text: string): Promise<void> {
    for (const s of await this.sessions(tool)) {
      if (s.id !== sessionId) continue;
      const you = String(s.you);
      await signedSend(this.serverFor(you), you, this.keys.get(you)!, "PUT", `/v1/sessions/${encodeURIComponent(sessionId)}/brief`, { text });
      return;
    }
    throw new ClientError(404, `You're not in a session with id ${sessionId}. list_sessions shows yours.`);
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
    if (!o.text?.trim()) throw new ClientError(400, "message text is empty");
    let agent: AgentConfig;
    if (o.from) {
      agent = pickAgent(this.config, o.from);
      // Headless runs send as a fixed agent; a short name ("juno", "juno-claude") still needs resolving.
      if (!ADDRESS_RE.test(o.to)) o = { ...o, to: (await this.resolveRoute([agent.address], o.to)).to };
    } else {
      const speakers = this.speakers(o.tool);
      if (!speakers.length) throw new ClientError(400, "No agent is set up for this app yet. Run `a2a connect`.");
      // Continue a thread as the agent that is already in it; reach a full address from its own workspace.
      const inThread = o.thread_id
        ? (this.state.prepare("SELECT from_addr AS a FROM sent WHERE thread_id = ? UNION SELECT to_addr AS a FROM inbox WHERE thread_id = ?").all(o.thread_id, o.thread_id) as { a: string }[]).map((r) => r.a)
        : [];
      const org = (address: string): string => address.split("/")[2] ?? "";
      if (ADDRESS_RE.test(o.to)) agent = speakers.find((s) => inThread.includes(s.address)) ?? speakers.find((s) => org(s.address) === org(o.to)) ?? speakers[0]!;
      else {
        const pool = speakers.filter((s) => inThread.includes(s.address));
        const route = await this.resolveRoute((pool.length ? pool : speakers).map((s) => s.address), o.to);
        agent = this.agent(route.from)!;
        o = { ...o, to: route.to };
      }
    }

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

    // Messages from inside an auto-reply run are marked as automated and stay in that run's session.
    let auto = !!o.auto;
    let session = o.session?.trim() || undefined;
    if (o.run_id) {
      const run = this.state.prepare("SELECT auto, session_id FROM runs WHERE id = ?").get(o.run_id) as { auto: number; session_id: string | null } | undefined;
      if (run?.auto) auto = true;
      if (!session && run?.session_id && run.session_id !== "workspace") session = run.session_id;
    }
    if (!session && inReplyTo) {
      const parent = this.state.prepare("SELECT delivery FROM inbox WHERE id = ?").get(inReplyTo) as { delivery: string } | undefined;
      const s = parent ? (JSON.parse(parent.delivery) as InboundMessage).session : undefined;
      if (s) session = s.id;
    }
    if (session && !session.startsWith("ses_")) {
      const r = await signedGet(this.serverFor(agent.address), agent.address, this.keys.get(agent.address)!, "/v1/sessions").catch(() => ({ sessions: [] }));
      const found = ((r.sessions as { id: string; name: string }[]) ?? []).find((s) => s.name.toLowerCase() === session!.toLowerCase());
      if (!found) throw new ClientError(404, `${agent.address} isn't in a session called "${session}".`);
      session = found.id;
    }

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
        body: o.attachments?.length ? { text: o.text, attachments: o.attachments } : { text: o.text },
        expects_reply: o.expects_reply ?? kind === "request",
        created_at: iso(),
        ...(session ? { session } : {}),
        ...(auto ? { auto: true as const } : {}),
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
    this.scheduleFlush();
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
      const envelope = JSON.parse(row.envelope) as Envelope;
      const r = await submitEnvelope(this.serverFor(envelope.from), envelope);
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
      this.scheduleFlush();
    }
  }

  /** One timer, set only while the outbox holds messages, for the next retry. Nothing ticks while idle. */
  private scheduleFlush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.stopping) return;
    const { at } = this.state.prepare("SELECT MIN(next_at) AS at FROM outbox").get() as { at: number | null };
    if (at === null) return;
    this.flushTimer = setTimeout(() => void this.flushOutbox(), Math.max(250, at - Date.now()));
    this.flushTimer.unref();
  }

  // ------------------------------------------------------------ running agents

  private dispatch(configured: AgentConfig, m: InboundMessage): void {
    // The current config decides, so turning auto-reply off also stops runs that were waiting their turn.
    const agent = this.agent(configured.address) ?? configured;
    const decision = this.autoDecision(agent, m);
    if (!decision.run) {
      this.state.prepare("UPDATE inbox SET auto = 0 WHERE id = ?").run(m.id);
      this.log(`· ${m.id} left in the inbox for ${agent.address}: ${decision.why}`);
      return;
    }
    const max = decision.rule?.max_concurrent ?? agent.max_concurrent ?? 1;
    if ((this.running.get(agent.address) ?? 0) >= max) {
      const q = this.backlog.get(agent.address) ?? [];
      q.push(m);
      this.backlog.set(agent.address, q);
      return;
    }
    this.running.set(agent.address, (this.running.get(agent.address) ?? 0) + 1);
    const p = this.processRun(agent, m, decision.rule)
      .catch((err) => this.log(`run for ${m.id} failed: ${(err as Error).stack ?? err}`))
      .finally(() => {
        this.activeRuns.delete(p);
        this.running.set(agent.address, (this.running.get(agent.address) ?? 1) - 1);
        const next = this.backlog.get(agent.address)?.shift();
        if (next && !this.stopping) this.dispatch(agent, next);
      });
    this.activeRuns.add(p);
  }

  private async processRun(configured: AgentConfig, m: InboundMessage, rule?: AutoReplyRule): Promise<void> {
    const runId = newRunId();
    // Notes from the relay's task board: the worker keeps one session per task and, on autopilot,
    // gets the tools the session's permissions allow.
    const fromBoard = m.from.endsWith("/console") && m.sender_verified !== false;
    const taskId = fromBoard ? taskIdOf(m.text) : null;
    const mission = fromBoard && m.text.startsWith("[a2a-mission]");
    let agent = configured;
    let perms: TaskPermissions | undefined;
    if (taskId || mission) {
      if (taskId) perms = await this.taskPermissions(agent.address, taskId);
      if (agent.autopilot && perms) agent = { ...agent, ...toolsFor(perms, agent.autopilot_max ?? "standard") };
    }
    const sessionKey = taskId ? `task:${taskId}` : m.thread_id;
    const useSessions = agent.session !== "none" && (agent.runtime === "claude" || agent.runtime === "opencode");
    const session = useSessions
      ? (this.state.prepare("SELECT session_id FROM sessions WHERE agent = ? AND thread_id = ?").get(agent.address, sessionKey) as { session_id: string } | undefined)
      : undefined;
    const env: Record<string, string> = {
      A2A_HOME: this.home,
      A2A_AGENT: agent.address,
      A2A_THREAD: m.thread_id,
      A2A_MESSAGE_ID: m.id,
      A2A_RUN_ID: runId,
      A2A_SOCKET: socketPath(this.home),
      ...(rule?.max_tokens && agent.runtime === "claude" ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(rule.max_tokens) } : {}),
    };
    const mcpConfigPath = join(this.home, "run", `${runId}.mcp.json`);
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { a2a: { type: "stdio", command: process.execPath, args: ["--disable-warning=ExperimentalWarning", CLI_PATH, "mcp"], env } } }, null, 2),
      { mode: 0o600 },
    );
    const auto = !!rule;
    const sessionKey_ = rule ? (m.session?.id ?? "workspace") : null;
    this.state
      .prepare("INSERT INTO runs (id, agent, thread_id, message_id, runtime, status, started_at, auto, session_id, delivery_ms) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)")
      .run(runId, agent.address, m.thread_id, m.id, agent.runtime, iso(), auto ? 1 : 0, sessionKey_, m.sent_at && m.received_at ? Math.max(0, Date.parse(m.received_at) - Date.parse(m.sent_at)) : null);
    this.log(`⚙ ${runId} starting ${agent.runtime} for ${agent.address}${session ? " (resuming thread session)" : ""}`);

    const t0 = Date.now();
    const owner = this.config.person ?? this.config.name;
    const app = agent.tool ? (toolById(agent.tool)?.label ?? agent.tool) : (agent.display_name ?? agent.address.split("/").pop()!);
    const result = await runAgent({
      agent,
      message: m,
      prompt:
        taskId || mission
          ? buildTaskPrompt(m, randomBytes(6).toString("hex"), perms, agent.autopilot ? agent.allowed_tools : undefined)
          : buildPrompt(m, randomBytes(6).toString("hex"), auto ? { owner, app, session: m.session?.name } : undefined),
      sessionId: session?.session_id,
      env,
      mcpConfigPath,
      timeoutMs: durationMs(rule?.timeout ?? agent.timeout, taskId || mission ? 45 * 60_000 : 15 * 60_000),
    });
    const startMs = m.received_at ? Math.max(0, t0 - Date.parse(m.received_at)) : null;
    rmSync(mcpConfigPath, { force: true });

    this.state
      .prepare("UPDATE runs SET status = ?, ended_at = ?, error = ?, output = ?, cost_usd = ?, tokens = ?, start_ms = ?, model_ms = ? WHERE id = ?")
      .run(result.error ? "failed" : "succeeded", iso(), result.error ?? null, result.output.slice(0, 20_000), result.costUsd ?? null, result.tokens ?? null, startMs, Date.now() - t0, runId);
    if (useSessions && result.sessionId) {
      this.state
        .prepare("INSERT INTO sessions (agent, thread_id, runtime, session_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (agent, thread_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at")
        .run(agent.address, sessionKey, agent.runtime, result.sessionId, iso());
    }
    this.markHandled(m.id);
    // A task run that failed would otherwise leave its part silently stuck until a check-in.
    if (taskId && result.error) {
      await this.taskCall([agent.address], taskId, "update", { status: "blocked", note: `Autopilot run failed on ${agent.address.split("/").pop()}: ${result.error.slice(0, 300)}` }).catch(() => {});
    }
    this.log(`${result.error ? "✕" : "✓"} ${runId} ${agent.runtime} finished in ${((Date.now() - t0) / 1000).toFixed(1)}s${result.error ? `: ${result.error}` : ""}`);

    const { replied } = this.state.prepare("SELECT replied FROM runs WHERE id = ?").get(runId) as { replied: number };
    if (m.expects_reply && !replied) {
      const text = result.error ? `[a2a] ${agent.address} could not handle this message: ${result.error}` : result.output;
      if (text) await this.send({ from: agent.address, to: m.from, text, thread_id: m.thread_id, in_reply_to: m.id, kind: "reply", expects_reply: false, scope: m.scope, auto, session: m.session?.id }, 0, 0);
    }
  }

  /** A task's permissions, read as one of our agents that takes part in it. */
  private async taskPermissions(agent: string, taskId: string): Promise<TaskPermissions | undefined> {
    try {
      const t = await signedGet(this.serverFor(agent), agent, this.keys.get(agent)!, `/v1/tasks/${encodeURIComponent(taskId)}`);
      return t.permissions as TaskPermissions;
    } catch (err) {
      this.log(`could not read task ${taskId}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Tasks this app's agents coordinate or work on, across workspaces. */
  async tasks(agents: string[]): Promise<Record<string, unknown>[]> {
    const lists = await Promise.all(
      agents.map(async (a) => {
        const r = await signedGet(this.serverFor(a), a, this.keys.get(a)!, "/v1/tasks").catch(() => ({ tasks: [] }));
        return ((r.tasks as Record<string, unknown>[]) ?? []).map((t) => ({ ...t, you: a }));
      }),
    );
    return lists.flat();
  }

  /** Creates a task as the first of our agents that can reach every assignee. */
  async createTask(agents: string[], body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let last: unknown;
    for (const a of agents) {
      try {
        return { ...(await signedSend(this.serverFor(a), a, this.keys.get(a)!, "POST", "/v1/tasks", body)), you: a };
      } catch (err) {
        last = err;
        // Another workspace may know these people; anything else is a real error.
        if (!(err instanceof RelayError) || !["unknown_agent", "not_reachable", "unknown_session"].includes(err.code)) break;
      }
    }
    const e = last as RelayError;
    throw new ClientError(e?.status ?? 500, e?.message ?? "could not create the task");
  }

  /** Reads or acts on a task as whichever of our agents takes part in it. */
  async taskCall(agents: string[], taskId: string, action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = `/v1/tasks/${encodeURIComponent(taskId)}`;
    let last: unknown;
    for (const a of agents) {
      try {
        const r = action === "detail" ? await signedGet(this.serverFor(a), a, this.keys.get(a)!, path) : await signedSend(this.serverFor(a), a, this.keys.get(a)!, "POST", `${path}/${action}`, body);
        return { ...r, you: a };
      } catch (err) {
        last = err;
        if (!(err instanceof RelayError) || err.status !== 404) break;
      }
    }
    const e = last as RelayError;
    throw new ClientError(e?.status ?? 404, (e?.status === 404 ? `No task ${taskId} that this app takes part in.` : (e?.message ?? "task call failed")));
  }

  /** Called through the MCP reply tool: replies to the message a run was started for. */
  async replyFromRun(runId: string, text: string, expectsReply = false): Promise<SendResult> {
    const run = this.state.prepare("SELECT agent, message_id, auto, session_id FROM runs WHERE id = ?").get(runId) as { agent: string; message_id: string; auto: number; session_id: string | null } | undefined;
    if (!run) throw new ClientError(404, `unknown run ${runId}`);
    const m = this.state.prepare("SELECT from_addr, thread_id, scope FROM inbox WHERE id = ?").get(run.message_id) as { from_addr: string; thread_id: string; scope: string };
    const session = run.session_id && run.session_id !== "workspace" ? run.session_id : undefined;
    const r = await this.send({ from: run.agent, to: m.from_addr, text, thread_id: m.thread_id, in_reply_to: run.message_id, kind: "reply", expects_reply: expectsReply, scope: m.scope, auto: !!run.auto, session });
    this.state.prepare("UPDATE runs SET replied = 1 WHERE id = ?").run(runId);
    return r;
  }

  /** The next unread message for any of these agents (one app's agents across its workspaces). */
  async nextInbox(agents: string[], waitMs: number): Promise<InboundMessage | null> {
    const marks = agents.map(() => "?").join(",");
    const row = agents.length
      ? (this.state.prepare(`SELECT delivery FROM inbox WHERE to_addr IN (${marks}) AND handled = 0 ORDER BY received_at LIMIT 1`).get(...agents) as { delivery: string } | undefined)
      : undefined;
    if (row) {
      const m = JSON.parse(row.delivery) as InboundMessage;
      this.markHandled(m.id);
      return m;
    }
    if (waitMs <= 0 || !agents.length) return null;
    return new Promise((resolve) => {
      // One waiter listens on every address; whichever fires first removes it from all of them.
      const remove = (): void => {
        for (const a of agents) this.inboxWaiters.set(a, (this.inboxWaiters.get(a) ?? []).filter((w) => w !== waiter));
      };
      const waiter = (m: InboundMessage): void => {
        clearTimeout(timer);
        remove();
        resolve(m);
      };
      for (const a of agents) this.inboxWaiters.set(a, [...(this.inboxWaiters.get(a) ?? []), waiter]);
      const timer = setTimeout(() => {
        remove();
        resolve(null);
      }, waitMs);
    });
  }

  /** Notes from relays (a session was deleted, you were removed) not yet shown to these agents' app. */
  takeNotices(agents: string[]): { address: string; kind: string; text: string; created_at: string }[] {
    if (!agents.length) return [];
    const marks = agents.map(() => "?").join(",");
    const rows = this.state.prepare(`SELECT id, address, kind, text, created_at FROM notices WHERE seen = 0 AND address IN (${marks}) ORDER BY id`).all(...agents) as { id: number; address: string; kind: string; text: string; created_at: string }[];
    for (const r of rows) this.state.prepare("UPDATE notices SET seen = 1 WHERE id = ?").run(r.id);
    return rows.map(({ id: _id, ...r }) => r);
  }

  info(): Record<string, unknown> {
    const { n: outbox } = this.state.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
    return {
      name: this.config.name,
      server: this.config.server,
      connected: this.connected,
      relays: [...this.links.values()].map((l) => ({ server: l.server, connected: l.connected })),
      agents: this.config.agents.map((a) => {
        const link = this.links.get(serverOf(this.config, a));
        return {
          address: a.address,
          tool: a.tool ?? null,
          server: serverOf(this.config, a),
          runtime: a.runtime,
          online: this.isAccepted(a.address),
          rejected: link?.rejected.find((r) => r.address === a.address)?.reason ?? null,
          running: this.running.get(a.address) ?? 0,
          queued: this.backlog.get(a.address)?.length ?? 0,
        };
      }),
      outbox_pending: outbox,
    };
  }

  // ------------------------------------------------------------ local socket API

  private async startIpc(): Promise<void> {
    if (useTcpIpc) return this.startTcpIpc();
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

  /** Windows: loopback TCP on a random port. The token in run/ipc.json stops other local pages and processes from calling it. */
  private async startTcpIpc(): Promise<void> {
    const info = ipcInfoPath(this.home);
    if (existsSync(info)) {
      const { port } = JSON.parse(readFileSync(info, "utf8")) as { port: number };
      const alive = await new Promise<boolean>((res) => {
        const s = connect({ host: "127.0.0.1", port });
        s.once("connect", () => {
          s.end();
          res(true);
        });
        s.once("error", () => res(false));
      });
      if (alive) throw new Error(`Another \`a2a run\` is already using ${this.home}.`);
      unlinkSync(info);
    }
    this.ipcToken = randomBytes(24).toString("hex");
    this.ipc = createServer((req, res) => void this.handleIpc(req, res));
    await new Promise<void>((res, rej) => {
      this.ipc!.once("error", rej);
      this.ipc!.listen(0, "127.0.0.1", () => res());
    });
    const { port } = this.ipc.address() as AddressInfo;
    writeFileSync(info, JSON.stringify({ port, token: this.ipcToken }), { mode: 0o600 });
  }

  private async handleIpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://a2a.local");
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (useTcpIpc && req.headers["x-a2a-token"] !== this.ipcToken) return reply(401, { error: "unauthorized" });
    try {
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      }
      const q = url.searchParams;
      const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
      const agentParam = (v: unknown): string => pickAgent(this.config, str(v)).address;
      /** Which agents a request speaks for: one named agent, or every agent of the calling app. */
      const mine = (agent: unknown, tool: unknown): string[] => (str(agent) ? [agentParam(agent)] : this.speakers(str(tool)).map((a) => a.address));
      const waitMs = (v: unknown, dflt: number): number => Math.min(Math.max(Number(v ?? dflt) || 0, 0), 3600) * 1000;

      switch (`${req.method} ${url.pathname}`) {
        case "GET /info":
          return reply(200, this.info());
        case "POST /stop":
          if (!this.onStopRequest) return reply(409, { error: "this client cannot be stopped remotely" });
          setTimeout(() => this.onStopRequest?.(), 50);
          return reply(200, { ok: true });
        case "POST /reload":
          await this.reload();
          return reply(200, this.info());
        case "POST /send":
          return reply(200, await this.send(body as unknown as SendOptions, waitMs(body.wait_seconds, 0)));
        case "GET /auto-reply":
          return reply(200, { matrix: await this.autoReplyMatrix() });
        case "POST /auto-reply":
          return reply(200, await this.setAutoReply(body));
        case "POST /reply": {
          if (typeof body.text !== "string") throw new ClientError(400, "text is required");
          if (typeof body.run_id === "string" && body.run_id) return reply(200, await this.replyFromRun(body.run_id, body.text, Boolean(body.expects_reply)));
          const ours = mine(body.from, body.tool);
          let inReplyTo = str(body.in_reply_to);
          if (!inReplyTo && typeof body.thread_id === "string" && ours.length) {
            const last = this.state
              .prepare(`SELECT id FROM inbox WHERE thread_id = ? AND to_addr IN (${ours.map(() => "?").join(",")}) ORDER BY received_at DESC LIMIT 1`)
              .get(body.thread_id, ...ours) as { id: string } | undefined;
            inReplyTo = last?.id;
          }
          if (!inReplyTo) throw new ClientError(400, "nothing to reply to: pass in_reply_to or a thread with a received message");
          const parent = this.state.prepare("SELECT from_addr, to_addr FROM inbox WHERE id = ?").get(inReplyTo) as { from_addr: string; to_addr: string } | undefined;
          if (!parent) throw new ClientError(404, `no received message ${inReplyTo}`);
          // Answer as the agent the message was sent to.
          return reply(200, await this.send({ from: parent.to_addr, to: parent.from_addr, text: body.text, in_reply_to: inReplyTo, kind: "reply", expects_reply: Boolean(body.expects_reply) }));
        }
        case "GET /status": {
          const id = q.get("id") ?? "";
          const local = this.state.prepare("SELECT * FROM sent WHERE id = ?").get(id) as Record<string, unknown> | undefined;
          const from = (local?.from_addr as string | undefined) ?? mine(q.get("agent"), q.get("tool"))[0];
          let remote: Record<string, unknown> | null = null;
          try {
            if (from) remote = await signedGet(this.serverFor(from), from, this.keys.get(from)!, `/v1/messages/${encodeURIComponent(id)}`);
          } catch {
            /* offline or unknown */
          }
          if (!local && !remote) throw new ClientError(404, `unknown message ${id}`);
          return reply(200, { local: local ?? null, relay: remote });
        }
        case "GET /thread": {
          const id = q.get("id") ?? "";
          // Read it as whichever of our agents took part.
          const local = this.state.prepare("SELECT from_addr AS a FROM sent WHERE thread_id = ? UNION SELECT to_addr AS a FROM inbox WHERE thread_id = ?").all(id, id) as { a: string }[];
          const ours = mine(q.get("agent"), q.get("tool"));
          const agent = ours.find((a) => local.some((r) => r.a === a)) ?? local.find((r) => this.agent(r.a))?.a ?? ours[0];
          if (!agent) throw new ClientError(404, `unknown thread ${id}`);
          return reply(200, await signedGet(this.serverFor(agent), agent, this.keys.get(agent)!, `/v1/threads/${encodeURIComponent(id)}`));
        }
        case "GET /directory":
          if (q.get("agent")) return reply(200, { agents: await this.directory(agentParam(q.get("agent"))) });
          return reply(200, { agents: await this.reachable(str(q.get("tool"))) });
        case "GET /sessions":
          return reply(200, { sessions: await this.sessions(str(q.get("tool"))) });
        case "POST /sessions/brief":
          if (typeof body.session_id !== "string" || typeof body.text !== "string") throw new ClientError(400, "session_id and text are required");
          await this.setBrief(str(body.tool), body.session_id, body.text);
          return reply(200, { ok: true });
        case "GET /inbox": {
          const ours = q.get("agent") || q.get("tool") ? mine(q.get("agent"), q.get("tool")) : null;
          const where = ours ? `WHERE to_addr IN (${ours.map(() => "?").join(",") || "''"})` : "";
          const rows = this.state.prepare(`SELECT id, thread_id, from_addr AS "from", to_addr AS "to", kind, text, redacted, handled, received_at FROM inbox ${where} ORDER BY received_at DESC LIMIT 50`).all(...(ours ?? []));
          return reply(200, { messages: rows });
        }
        case "POST /inbox/next":
          return reply(200, { message: await this.nextInbox(mine(body.agent, body.tool), waitMs(body.wait_seconds, 0)), notices: this.takeNotices(mine(body.agent, body.tool)) });
        case "POST /notices":
          return reply(200, { notices: this.takeNotices(mine(body.agent, body.tool)) });
        case "GET /tasks":
          return reply(200, { tasks: await this.tasks(mine(q.get("agent"), q.get("tool"))) });
        case "POST /tasks/create":
          return reply(200, await this.createTask(mine(body.agent, body.tool), (body.task ?? {}) as Record<string, unknown>));
        case "POST /tasks/call": {
          const action = str(body.action) ?? "detail";
          if (!["detail", "update", "report", "vote", "parts"].includes(action)) throw new ClientError(400, `unknown task action ${action}`);
          if (typeof body.task_id !== "string") throw new ClientError(400, "task_id is required");
          return reply(200, await this.taskCall(mine(body.agent, body.tool), body.task_id, action, (body.input ?? {}) as Record<string, unknown>));
        }
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
