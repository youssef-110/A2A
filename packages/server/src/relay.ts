import { EventEmitter } from "node:events";
import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import {
  ADDRESS_RE,
  canonicalize,
  newMessageId,
  newThreadId,
  orgOf,
  registerSigningString,
  sha256Hex,
  signEnvelope,
  signString,
  validateEnvelope,
  verifyEnvelope,
  verifyString,
  type Envelope,
  type Decision,
} from "@a2a/protocol";
import {
  applyRedactions,
  HeuristicJudge,
  linkFor,
  linksBetween,
  normalize,
  parsePolicy,
  scan,
  screen,
  type JudgeMode,
  type JudgeSet,
  type Policy,
  type StageResult,
  type Verdict,
} from "@a2a/guard/core";
import { tx, type AgentRow, type Db, type InviteRow, type MessageRow, type ThreadRow } from "./db.ts";

export const RELAY_VERSION = "0.1.0";
const FUTURE_SKEW_MS = 5 * 60_000;
const REDELIVER_AFTER_MS = 30_000;

/** What the relay pushes to a recipient. Signed by the relay so the client can trust the normalized text. */
export interface Delivery {
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
  attachments?: Envelope["body"]["attachments"];
  redacted: boolean;
  /** True when the guard changed the text (normalization or redaction). The original envelope is then withheld. */
  modified: boolean;
  verdict: { decision: string; categories: string[] };
  /** The sender's signed envelope, included only when the delivered text is byte-identical to it. */
  envelope?: Envelope;
  body_sha256: string;
  relay_sig: string;
}

export interface StatusUpdate {
  id: string;
  thread_id: string;
  state: string;
  reason_code: string | null;
}

/** The delivery transport (the WebSocket hub). Kept behind an interface so the relay logic is testable. */
export interface Outbound {
  deliver(address: string, delivery: Delivery): number;
  status(address: string, update: StatusUpdate): void;
  isOnline(address: string): boolean;
  disconnect(address: string): void;
  onlineAgents(): string[];
}

const nullOutbound: Outbound = {
  deliver: () => 0,
  status: () => {},
  isOnline: () => false,
  disconnect: () => {},
  onlineAgents: () => [],
};

export interface RelayEvent {
  type: "message" | "agent" | "policy" | "audit" | "console";
  data: unknown;
}

export interface RelayOptions {
  db: Db;
  relayKeyPem: string;
  /** Policy YAML loaded when the database has no policy yet. */
  initialPolicy?: string;
  /** Overrides policy.guard.judge, e.g. from --judge or A2A_JUDGE. */
  judgeOverride?: JudgeMode;
  /** For tests: inject judges directly. */
  judges?: JudgeSet | null;
  /** Builds the judges for a policy's guard.judge mode. Node passes the full factory from @a2a/guard (which can use the claude CLI). */
  createJudges?: (mode: JudgeMode) => JudgeSet | null;
  log?: (msg: string) => void;
  concurrency?: number;
}

interface SubmitResult {
  status: number;
  body: Record<string, unknown>;
}

const iso = (ms = Date.now()): string => new Date(ms).toISOString();
const portableJudges = (mode: JudgeMode): JudgeSet | null => (mode === "off" ? null : { fast: new HeuristicJudge() });
const SENSITIVE = new Set(["secret_detected", "payment_card", "pii"]);

/** A preview for lists and the console that never shows secrets, card numbers or SSNs. */
export function safePreview(text: string, max = 180): string {
  const n = normalize(text);
  const spans = scan(n)
    .filter((f) => SENSITIVE.has(f.category) && f.start !== undefined)
    .map((f) => ({ start: f.start!, end: f.end!, category: f.category, detail: f.detail }));
  const masked = applyRedactions(n.text, spans, () => "[•••]").replace(/\s+/g, " ").trim();
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

export class Relay extends EventEmitter {
  readonly db: Db;
  readonly relayPublicKey: string;
  policy!: Policy;
  policyVersion = 0;
  judges: JudgeSet | null = null;
  out: Outbound = nullOutbound;

  private readonly relayKey: KeyObject;
  private readonly judgeOverride?: JudgeMode;
  private readonly fixedJudges?: JudgeSet | null;
  private readonly makeJudges: (mode: JudgeMode) => JudgeSet | null;
  private readonly log: (msg: string) => void;
  private readonly concurrency: number;
  private readonly queue: string[] = [];
  private active = 0;
  private sweepTimer?: NodeJS.Timeout;

  constructor(opts: RelayOptions) {
    super();
    this.setMaxListeners(100);
    this.db = opts.db;
    this.relayKey = createPrivateKey(opts.relayKeyPem);
    this.relayPublicKey = createPublicKey(this.relayKey).export({ type: "spki", format: "der" }).toString("base64");
    this.judgeOverride = opts.judgeOverride;
    this.fixedJudges = opts.judges;
    this.makeJudges = opts.createJudges ?? portableJudges;
    this.log = opts.log ?? (() => {});
    this.concurrency = opts.concurrency ?? 4;
    this.loadPolicy(opts.initialPolicy);
  }

  start(): void {
    this.recover();
    this.sweepTimer = setInterval(() => this.sweep(), 5000);
    this.sweepTimer.unref();
  }

  /** Crash recovery: anything left mid-screening is screened again. Durable Objects call this on every wake-up. */
  recover(): void {
    const stuck = this.db.prepare("SELECT id FROM messages WHERE state = 'screening' ORDER BY received_at").all() as { id: string }[];
    for (const { id } of stuck) if (!this.queue.includes(id)) this.enqueue(id);
  }

  /** True while messages wait for delivery or screening, so a Durable Object knows to keep its sweep alarm. */
  hasPendingWork(): boolean {
    return this.active > 0 || this.queue.length > 0 || !!this.db.prepare("SELECT 1 FROM messages WHERE state IN ('queued', 'screening') LIMIT 1").get();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Resolves once the screening queue is empty. Used by tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.active > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 10));
  }

  private emitEvent(type: RelayEvent["type"], data: unknown): void {
    this.emit("event", { type, data } satisfies RelayEvent);
  }

  audit(actor: string, action: string, target: string | null, detail?: unknown): void {
    const row = { at: iso(), actor, action, target, detail: detail === undefined ? null : JSON.stringify(detail) };
    this.db.prepare("INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)").run(row.at, row.actor, row.action, row.target, row.detail);
    this.emitEvent("audit", row);
  }

  // ---------------------------------------------------------------- policy

  private loadPolicy(initial?: string): void {
    let row = this.db.prepare("SELECT version, yaml FROM policies ORDER BY version DESC LIMIT 1").get() as { version: number; yaml: string } | undefined;
    if (!row) {
      if (!initial) throw new Error("no policy in the database and no initial policy given");
      const { errors } = parsePolicy(initial);
      if (errors.length) throw new Error(`initial policy is invalid:\n  ${errors.join("\n  ")}`);
      this.db.prepare("INSERT INTO policies (yaml, created_by, created_at, note) VALUES (?, ?, ?, ?)").run(initial, "system", iso(), "initial policy");
      row = this.db.prepare("SELECT version, yaml FROM policies ORDER BY version DESC LIMIT 1").get() as { version: number; yaml: string };
    }
    const { policy, errors } = parsePolicy(row.yaml);
    if (!policy) throw new Error(`stored policy v${row.version} is invalid: ${errors.join("; ")}`);
    this.applyPolicy(policy, row.version);
  }

  private applyPolicy(policy: Policy, version: number): void {
    const judgeChanged = !this.policy || this.policy.guard.judge !== policy.guard.judge;
    this.policy = policy;
    this.policyVersion = version;
    if (this.fixedJudges !== undefined) this.judges = this.fixedJudges;
    else if (judgeChanged) this.judges = this.makeJudges(this.judgeOverride ?? policy.guard.judge);
    this.ensureConsoleAgent();
  }

  // ---------------------------------------------------------------- console agent

  /** The relay's own agent. The admin console and voice desk talk to other agents through it, signed with the relay key. */
  get consoleAddress(): string {
    return `agent://${this.policy.org}/console`;
  }

  private ensureConsoleAgent(): void {
    const now = iso();
    this.db
      .prepare(
        `INSERT INTO agents (address, public_key, display_name, description, host, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT (address) DO UPDATE SET public_key = excluded.public_key, status = 'active', updated_at = excluded.updated_at`,
      )
      .run(this.consoleAddress, this.relayPublicKey, "Console", "The relay's voice and text desk, operated by the admin.", "relay", now, now);
  }

  isOnline(address: string): boolean {
    return address === this.consoleAddress || this.out.isOnline(address);
  }

  /** Sends a message from the console agent. Goes through the same checks and guard as any other message. */
  consoleSend(input: { to?: unknown; text?: unknown; thread_id?: unknown; in_reply_to?: unknown; scope?: unknown }, actor: string): SubmitResult {
    if (typeof input.to !== "string" || !ADDRESS_RE.test(input.to)) return { status: 400, body: { error: "invalid_recipient" } };
    if (typeof input.text !== "string" || !input.text.trim()) return { status: 400, body: { error: "empty_message" } };
    const threadId = typeof input.thread_id === "string" && input.thread_id ? input.thread_id : newThreadId();
    const thread = this.getThread(threadId);
    const scope = typeof input.scope === "string" && input.scope ? input.scope : (thread?.scope ?? this.defaultScope(this.consoleAddress, input.to));
    const inReplyTo = typeof input.in_reply_to === "string" && input.in_reply_to ? input.in_reply_to : null;
    const env = signEnvelope(
      {
        v: 1,
        id: newMessageId(),
        thread_id: threadId,
        in_reply_to: inReplyTo,
        from: this.consoleAddress,
        to: input.to,
        scope,
        kind: inReplyTo ? "reply" : "request",
        body: { text: input.text.trim() },
        expects_reply: !inReplyTo,
        created_at: iso(),
      },
      this.relayKey,
    );
    this.audit(actor, "console.send", env.id, { to: env.to });
    return this.submit(env);
  }

  /** A scope two agents can use: "general" when it exists, otherwise the first scope their link allows. */
  defaultScope(from: string, to: string): string {
    const allowed = linksBetween(this.policy, from, to).flatMap((l) => (l.scopes.includes("*") ? Object.keys(this.policy.scopes) : l.scopes));
    const pool = allowed.length ? allowed : Object.keys(this.policy.scopes);
    return pool.includes("general") ? "general" : (pool[0] ?? "general");
  }

  // ---------------------------------------------------------------- invites

  createInvite(input: { note?: unknown; max_uses?: unknown; ttl_hours?: unknown }, actor: string): InviteRow {
    const code = randomBytes(12).toString("base64url");
    const maxUses = Math.min(Math.max(Math.floor(Number(input.max_uses ?? 1)) || 1, 1), 100);
    const ttlHours = Math.min(Math.max(Number(input.ttl_hours ?? 168) || 168, 1), 24 * 90);
    const now = Date.now();
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 120) : null;
    this.db
      .prepare("INSERT INTO invites (code, note, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)")
      .run(code, note, actor, iso(now), iso(now + ttlHours * 3600_000), maxUses);
    this.audit(actor, "invite.create", code.slice(0, 6), { note, max_uses: maxUses, ttl_hours: ttlHours });
    return this.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as InviteRow;
  }

  listInvites(): (InviteRow & { valid: boolean })[] {
    const rows = this.db.prepare("SELECT * FROM invites ORDER BY created_at DESC LIMIT 100").all() as InviteRow[];
    return rows.map((r) => ({ ...r, valid: this.inviteUsable(r) }));
  }

  revokeInvite(code: string, actor: string): boolean {
    const r = this.db.prepare("UPDATE invites SET revoked = 1 WHERE code = ?").run(code);
    if (Number(r.changes)) this.audit(actor, "invite.revoke", code.slice(0, 6));
    return Number(r.changes) > 0;
  }

  private inviteUsable(r: InviteRow | undefined): boolean {
    return !!r && !r.revoked && r.uses < r.max_uses && Date.parse(r.expires_at) > Date.now();
  }

  /** Public view of an invite, for the join page. Says nothing about other invites or agents. */
  inviteInfo(code: string): Record<string, unknown> {
    const r = this.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as InviteRow | undefined;
    return { valid: this.inviteUsable(r), org: this.policy.org, note: r?.note ?? null, expires_at: r?.expires_at ?? null };
  }

  setPolicy(yaml: string, actor: string, note?: string): { ok: boolean; version?: number; errors?: string[] } {
    const { policy, errors } = parsePolicy(yaml);
    if (!policy) return { ok: false, errors };
    const r = this.db.prepare("INSERT INTO policies (yaml, created_by, created_at, note) VALUES (?, ?, ?, ?)").run(yaml, actor, iso(), note ?? null);
    const version = Number(r.lastInsertRowid);
    this.applyPolicy(policy, version);
    this.audit(actor, "policy.update", `v${version}`, { note });
    this.emitEvent("policy", { version });
    return { ok: true, version };
  }

  judgeInfo(): { kind: string; fast: string; strong: string | null } {
    if (!this.judges) return { kind: "off", fast: "none", strong: null };
    return { kind: this.judges.fast.kind, fast: this.judges.fast.model, strong: this.judges.strong?.model ?? null };
  }

  // ---------------------------------------------------------------- agents

  getAgent(address: string): AgentRow | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE address = ?").get(address) as AgentRow | undefined;
  }

  register(
    input: { address?: unknown; public_key?: unknown; display_name?: unknown; description?: unknown; host?: unknown; timestamp?: unknown; proof?: unknown; invite?: unknown },
    admin: boolean,
  ): SubmitResult {
    const { address, public_key, timestamp, proof } = input;
    if (typeof address !== "string" || !ADDRESS_RE.test(address)) return { status: 400, body: { error: "invalid_address", detail: "address must look like agent://<org>/<name>" } };
    if (orgOf(address) !== this.policy.org) return { status: 400, body: { error: "wrong_org", detail: `this relay serves agent://${this.policy.org}/*` } };
    if (typeof public_key !== "string" || typeof timestamp !== "string" || typeof proof !== "string") return { status: 400, body: { error: "invalid_request", detail: "public_key, timestamp and proof are required" } };
    if (Math.abs(Date.now() - Date.parse(timestamp)) > FUTURE_SKEW_MS) return { status: 400, body: { error: "stale_timestamp" } };
    if (!verifyString(registerSigningString(address, public_key, timestamp), proof, public_key)) return { status: 401, body: { error: "bad_proof", detail: "proof must be signed with the key being registered" } };
    if (address === this.consoleAddress) return { status: 409, body: { error: "reserved_address", detail: "this address belongs to the relay" } };

    // An invite or open registration activates the agent like the admin token would, but never replaces an existing key.
    let invite: InviteRow | undefined;
    if (typeof input.invite === "string" && input.invite) {
      invite = this.db.prepare("SELECT * FROM invites WHERE code = ?").get(input.invite) as InviteRow | undefined;
      if (!this.inviteUsable(invite)) return { status: 403, body: { error: "invalid_invite", detail: "this invite link is expired, used up or revoked" } };
    }
    const activate = admin || !!invite || this.policy.registration === "open";

    const str = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
    const now = iso();
    const existing = this.getAgent(address);
    if (existing) {
      if (existing.public_key !== public_key && !admin) return { status: 409, body: { error: "key_conflict", detail: "this address is registered with a different key; pick another name or ask an admin to approve the new key" } };
      // Admins can re-enable a disabled agent; invites and open registration cannot.
      this.db
        .prepare("UPDATE agents SET public_key = ?, display_name = COALESCE(?, display_name), description = COALESCE(?, description), host = COALESCE(?, host), status = CASE WHEN ? THEN 'active' WHEN ? AND status <> 'disabled' THEN 'active' ELSE status END, updated_at = ? WHERE address = ?")
        .run(public_key, str(input.display_name, 80), str(input.description, 400), str(input.host, 120), admin ? 1 : 0, activate ? 1 : 0, now, address);
      if (existing.public_key !== public_key) this.audit(admin ? "admin" : address, "agent.rotate_key", address);
    } else {
      this.db
        .prepare("INSERT INTO agents (address, public_key, display_name, description, host, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(address, public_key, str(input.display_name, 80), str(input.description, 400), str(input.host, 120), activate ? "active" : "pending", now, now);
      this.audit(admin ? "admin" : address, admin ? "agent.register" : invite ? "agent.join" : activate ? "agent.register_open" : "agent.request", address, invite ? { invite: invite.code.slice(0, 6) } : undefined);
    }
    if (invite && (!existing || existing.status === "pending")) this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?").run(invite.code);
    const agent = this.getAgent(address)!;
    this.emitEvent("agent", this.agentView(agent));
    return { status: existing ? 200 : 201, body: { address, status: agent.status, relay_public_key: this.relayPublicKey } };
  }

  setAgentStatus(address: string, status: "active" | "disabled", actor: string): boolean {
    const r = this.db.prepare("UPDATE agents SET status = ?, updated_at = ? WHERE address = ?").run(status, iso(), address);
    if (!r.changes) return false;
    if (status === "disabled") this.out.disconnect(address);
    this.audit(actor, status === "active" ? "agent.approve" : "agent.disable", address);
    this.emitEvent("agent", this.agentView(this.getAgent(address)!));
    return true;
  }

  agentView(a: AgentRow): Record<string, unknown> {
    return {
      address: a.address,
      display_name: a.display_name,
      description: a.description,
      host: a.host,
      status: a.status,
      online: this.isOnline(a.address),
      created_at: a.created_at,
      last_seen_at: a.last_seen_at,
      key_fingerprint: sha256Hex(a.public_key).slice(0, 16),
    };
  }

  onAgentOnline(address: string): void {
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE address = ?").run(iso(), address);
    this.emitEvent("agent", this.agentView(this.getAgent(address)!));
    const queued = this.db.prepare("SELECT id FROM messages WHERE to_addr = ? AND state = 'queued' ORDER BY received_at").all(address) as { id: string }[];
    for (const { id } of queued) this.tryDeliver(id);
  }

  onAgentOffline(address: string): void {
    const a = this.getAgent(address);
    if (a) this.emitEvent("agent", this.agentView(a));
  }

  // ---------------------------------------------------------------- messages

  getMessage(id: string): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  }

  private getThread(id: string): ThreadRow | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
  }

  /** A recipient joins a thread only once a message to it is actually deliverable. */
  private addParticipant(threadId: string, address: string): void {
    this.db.prepare("INSERT OR IGNORE INTO thread_participants (thread_id, address) VALUES (?, ?)").run(threadId, address);
  }

  private isParticipant(threadId: string, address: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM thread_participants WHERE thread_id = ? AND address = ?").get(threadId, address);
  }

  /** Stage 1: deterministic checks on the envelope, its thread and the link policy. */
  private envelopeChecks(env: Envelope, now: number): { stage: StageResult; hop: number } {
    const t0 = performance.now();
    const p = this.policy;
    const block = (category: string, reason: string, hop = 1): { stage: StageResult; hop: number } => ({
      stage: { stage: "envelope", decision: "block", categories: [category], reason, latency_ms: Math.round(performance.now() - t0) },
      hop,
    });

    const recipient = this.getAgent(env.to);
    if (!recipient) return block("unknown_recipient", `${env.to} is not registered on this relay.`);
    if (recipient.status !== "active") return block("recipient_inactive", `${env.to} is ${recipient.status}.`);
    if (orgOf(env.from) !== p.org || orgOf(env.to) !== p.org) return block("cross_org", "Messaging between organizations is not enabled.");
    const consoleLink = env.from === this.consoleAddress || env.to === this.consoleAddress;
    const wildcardLink = linksBetween(p, env.from, env.to).find((l) => l.scopes.includes("*"));
    // A wildcard link means "anything goes", so free-form scopes are accepted too.
    if (!p.scopes[env.scope] && !consoleLink && !wildcardLink) return block("unknown_scope", `Scope "${env.scope}" is not defined in policy.`);

    const thread = this.getThread(env.thread_id);
    let parent: MessageRow | undefined;
    if (env.in_reply_to) {
      parent = this.getMessage(env.in_reply_to);
      if (!parent || parent.thread_id !== env.thread_id) return block("bad_reply_reference", "in_reply_to does not name a message in this thread.");
    }
    if (thread) {
      if (thread.scope !== env.scope) return block("scope_mismatch", `This thread's scope is "${thread.scope}".`);
      if (!this.isParticipant(thread.id, env.from)) return block("not_participant", "The sender is not part of this thread.");
    }
    const hop = parent ? parent.hop + 1 : thread ? thread.max_hop + 1 : 1;

    // A reply to a message that actually reached the replier is allowed without a reverse link.
    const impliedReply = !!parent && parent.from_addr === env.to && parent.to_addr === env.from && (parent.state === "queued" || parent.state === "delivered");
    const link = consoleLink ? { from: env.from, to: env.to, scopes: ["*"] } : (linkFor(p, env.from, env.to, env.scope) ?? wildcardLink);
    if (!link && !impliedReply) {
      return linksBetween(p, env.from, env.to).length
        ? block("scope_not_allowed", `${env.from} may message ${env.to}, but not under scope "${env.scope}".`, hop)
        : block("link_not_allowed", `Policy has no link from ${env.from} to ${env.to}.`, hop);
    }
    if (link?.rate && !impliedReply) {
      const since = iso(now - link.rate.windowMs);
      const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_addr = ? AND to_addr = ? AND received_at > ?").get(env.from, env.to, since) as { n: number };
      if (n >= link.rate.count) return block("rate_limited", `Link rate limit of ${link.rate.text} reached.`, hop);
    }
    if (hop > p.limits.max_hops_per_thread) return block("hop_limit", `Thread reached ${p.limits.max_hops_per_thread} hops. This usually means two agents are looping.`, hop);
    if (thread && thread.message_count >= p.limits.max_messages_per_thread) return block("thread_limit", `Thread reached ${p.limits.max_messages_per_thread} messages.`, hop);
    const sha = sha256Hex(canonicalize(env.body));
    const { dup } = this.db.prepare("SELECT COUNT(*) AS dup FROM messages WHERE thread_id = ? AND from_addr = ? AND body_sha256 = ?").get(env.thread_id, env.from, sha) as { dup: number };
    if (dup >= 2) return block("loop_detected", "The sender already sent this exact message twice in this thread.", hop);

    return { stage: { stage: "envelope", decision: "allow", categories: [], reason: "Envelope, link and thread checks passed.", latency_ms: Math.round(performance.now() - t0) }, hop };
  }

  submit(raw: unknown, now = Date.now()): SubmitResult {
    const invalid = validateEnvelope(raw);
    if (invalid) return { status: 400, body: { error: "invalid_envelope", detail: invalid } };
    const env = raw as Envelope;

    const size = Buffer.byteLength(JSON.stringify(env));
    if (size > this.policy.limits.max_body_bytes) return { status: 413, body: { error: "too_large", detail: `envelope is ${size} bytes; limit is ${this.policy.limits.max_body_bytes}` } };

    const sender = this.getAgent(env.from);
    if (!sender) return { status: 403, body: { error: "unknown_sender" } };
    if (sender.status !== "active") return { status: 403, body: { error: sender.status === "pending" ? "agent_pending" : "agent_disabled" } };
    if (!verifyEnvelope(env, sender.public_key)) return { status: 401, body: { error: "bad_signature" } };

    const created = Date.parse(env.created_at);
    if (created - now > FUTURE_SKEW_MS) return { status: 400, body: { error: "future_timestamp" } };
    if (now - created > this.policy.limits.message_ttl_ms) return { status: 400, body: { error: "expired_before_submit" } };

    const existing = this.getMessage(env.id);
    if (existing) {
      const prior = JSON.parse(existing.envelope) as Envelope;
      if (prior.sig === env.sig) return { status: 200, body: { id: env.id, thread_id: env.thread_id, state: existing.state, reason_code: existing.reason_code, duplicate: true } };
      return { status: 409, body: { error: "id_conflict", detail: "a different message with this id already exists" } };
    }

    const { n: recentBlocks } = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE from_addr = ? AND state = 'blocked' AND received_at > ?")
      .get(env.from, iso(now - 3600_000)) as { n: number };
    if (recentBlocks >= this.policy.limits.max_blocks_per_hour) {
      this.audit("relay", "agent.throttled", env.from, { recent_blocks: recentBlocks });
      return { status: 429, body: { error: "throttled", detail: "too many blocked messages in the last hour; an admin has been notified" } };
    }

    const { stage, hop } = this.envelopeChecks(env, now);
    const passed = stage.decision === "allow";
    const ts = iso(now);
    const preview = safePreview(env.body.text);

    tx(this.db, () => {
      const thread = this.getThread(env.thread_id);
      if (!thread) {
        this.db.prepare("INSERT INTO threads (id, scope, created_by, created_at, updated_at, message_count, max_hop) VALUES (?, ?, ?, ?, ?, 1, ?)").run(env.thread_id, env.scope, env.from, ts, ts, hop);
        this.db.prepare("INSERT OR IGNORE INTO thread_participants (thread_id, address) VALUES (?, ?)").run(env.thread_id, env.from);
      } else {
        this.db.prepare("UPDATE threads SET message_count = message_count + 1, max_hop = MAX(max_hop, ?), updated_at = ? WHERE id = ?").run(hop, ts, env.thread_id);
      }

      this.db
        .prepare(
          `INSERT INTO messages (id, thread_id, in_reply_to, from_addr, to_addr, scope, kind, expects_reply, hop, envelope, body_sha256, preview,
            state, decision, reason_code, reason, categories, policy_version, created_at, received_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          env.id, env.thread_id, env.in_reply_to, env.from, env.to, env.scope, env.kind, env.expects_reply ? 1 : 0, hop,
          JSON.stringify(env), sha256Hex(canonicalize(env.body)), preview,
          passed ? "screening" : "blocked",
          passed ? null : "block",
          passed ? null : stage.categories[0]!,
          passed ? null : stage.reason,
          passed ? null : JSON.stringify(stage.categories),
          this.policyVersion, env.created_at, ts, ts,
        );
      this.insertStage(env.id, stage, ts);
    });

    const row = this.getMessage(env.id)!;
    if (passed) {
      this.emitEvent("message", this.summary(row));
      this.enqueue(env.id);
    } else {
      this.notify(row);
    }
    return { status: 202, body: { id: env.id, thread_id: env.thread_id, state: row.state, reason_code: row.reason_code } };
  }

  private insertStage(messageId: string, s: StageResult, at: string): void {
    this.db
      .prepare("INSERT INTO verdict_stages (message_id, stage, decision, categories, confidence, model, reason, latency_ms, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(messageId, s.stage, s.decision, JSON.stringify(s.categories), s.confidence ?? null, s.model ?? null, s.reason, s.latency_ms, s.error ? 1 : 0, at);
  }

  private enqueue(id: string): void {
    this.queue.push(id);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.active++;
      this.screenMessage(id)
        .catch((err) => this.log(`screening ${id} failed: ${(err as Error).stack ?? err}`))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private async screenMessage(id: string): Promise<void> {
    const row = this.getMessage(id);
    if (!row || row.state !== "screening") return;
    const env = JSON.parse(row.envelope) as Envelope;
    const thread = (
      this.db
        .prepare("SELECT from_addr, delivered_text FROM messages WHERE thread_id = ? AND id <> ? AND state IN ('queued', 'delivered') ORDER BY received_at DESC LIMIT 6")
        .all(row.thread_id, id) as { from_addr: string; delivered_text: string }[]
    )
      .reverse()
      .map((m) => ({ from: m.from_addr, text: m.delivered_text }));

    const policyVersion = this.policyVersion;
    const verdict = await screen({
      from: env.from,
      to: env.to,
      kind: env.kind,
      scope: env.scope,
      text: env.body.text,
      attachments: env.body.attachments,
      thread,
      policy: this.policy,
      judges: this.judges,
    });
    this.applyVerdict(row, verdict, policyVersion);
  }

  private applyVerdict(row: MessageRow, v: Verdict, policyVersion: number): void {
    const now = Date.now();
    const ts = iso(now);
    const state = v.decision === "allow" || v.decision === "redact" ? "queued" : v.decision === "hold" ? "held" : "blocked";
    const guardMs = v.stages.reduce((n, s) => n + s.latency_ms, 0);
    tx(this.db, () => {
      for (const s of v.stages) this.insertStage(row.id, s, ts);
      if (state === "queued") this.addParticipant(row.thread_id, row.to_addr);
      this.db
        .prepare(
          `UPDATE messages SET state = ?, decision = ?, reason_code = ?, reason = ?, categories = ?, findings = ?, delivered_text = ?, redacted = ?,
             preview = ?, policy_version = ?, guard_ms = ?, updated_at = ?, expires_at = ? WHERE id = ? AND state = 'screening'`,
        )
        .run(
          state, v.decision, v.reason_code, v.reason, JSON.stringify(v.categories),
          JSON.stringify(v.findings.map(({ category, detail, source }) => ({ category, detail, source }))),
          state === "blocked" ? null : v.delivered_text, v.redactions.length ? 1 : 0,
          safePreview(v.delivered_text), policyVersion, guardMs, ts,
          state === "queued" ? iso(now + this.policy.limits.message_ttl_ms) : null,
          row.id,
        );
    });
    const updated = this.getMessage(row.id)!;
    this.log(`${updated.id} ${updated.from_addr} -> ${updated.to_addr} ${v.decision}${v.reason_code ? ` (${v.reason_code})` : ""} ${guardMs}ms`);
    this.notify(updated);
    if (updated.state === "queued") this.tryDeliver(updated.id);
  }

  private notify(row: MessageRow): void {
    this.out.status(row.from_addr, { id: row.id, thread_id: row.thread_id, state: row.state, reason_code: row.reason_code });
    this.emitEvent("message", this.summary(row));
  }

  private buildDelivery(row: MessageRow): Delivery {
    const env = JSON.parse(row.envelope) as Envelope;
    const text = row.delivered_text ?? "";
    const modified = text !== env.body.text;
    const d: Omit<Delivery, "relay_sig"> = {
      id: row.id,
      thread_id: row.thread_id,
      in_reply_to: row.in_reply_to,
      from: row.from_addr,
      to: row.to_addr,
      scope: row.scope,
      kind: row.kind,
      expects_reply: !!row.expects_reply,
      hop: row.hop,
      created_at: env.created_at,
      text,
      attachments: env.body.attachments,
      redacted: !!row.redacted,
      modified,
      verdict: { decision: row.decision ?? "allow", categories: JSON.parse(row.categories ?? "[]") },
      envelope: modified ? undefined : env,
      body_sha256: row.body_sha256,
    };
    return { ...d, relay_sig: signString(canonicalize(d), this.relayKey) };
  }

  tryDeliver(id: string): boolean {
    const row = this.getMessage(id);
    if (!row || row.state !== "queued") return false;
    if (row.to_addr === this.consoleAddress) {
      // The console has no socket: delivery means it is stored and pushed to open dashboards.
      const ts = iso();
      this.db.prepare("UPDATE messages SET state = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'").run(ts, ts, id);
      const delivered = this.getMessage(id)!;
      this.notify(delivered);
      this.emitEvent("console", { ...this.summary(delivered), text: delivered.delivered_text });
      return true;
    }
    if (!this.out.isOnline(row.to_addr)) return false;
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE message_id = ?").get(id) as { n: number };
    this.db.prepare("INSERT INTO deliveries (message_id, attempt, sent_at) VALUES (?, ?, ?)").run(id, n + 1, iso());
    return this.out.deliver(row.to_addr, this.buildDelivery(row)) > 0;
  }

  /** The recipient's client confirms it stored the message. Only the recipient can ack. */
  ack(id: string, owned: ReadonlySet<string>): void {
    const row = this.getMessage(id);
    if (!row || !owned.has(row.to_addr) || row.state !== "queued") return;
    const ts = iso();
    tx(this.db, () => {
      this.db.prepare("UPDATE messages SET state = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ? AND state = 'queued'").run(ts, ts, id);
      this.db.prepare("UPDATE deliveries SET acked_at = ? WHERE message_id = ? AND acked_at IS NULL").run(ts, id);
    });
    this.notify(this.getMessage(id)!);
  }

  sweep(now = Date.now()): void {
    const expired = this.db.prepare("SELECT id FROM messages WHERE state = 'queued' AND expires_at < ?").all(iso(now)) as { id: string }[];
    for (const { id } of expired) {
      this.db.prepare("UPDATE messages SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'queued'").run(iso(now), id);
      this.notify(this.getMessage(id)!);
    }
    const stale = this.db
      .prepare(
        `SELECT m.id, m.to_addr FROM messages m WHERE m.state = 'queued'
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.sent_at > ?)`,
      )
      .all(iso(now - REDELIVER_AFTER_MS)) as { id: string; to_addr: string }[];
    for (const m of stale) if (this.out.isOnline(m.to_addr)) this.tryDeliver(m.id);
  }

  review(id: string, decision: "release" | "reject", reviewer: string, note?: string): SubmitResult {
    const row = this.getMessage(id);
    if (!row) return { status: 404, body: { error: "not_found" } };
    if (row.state !== "held") return { status: 409, body: { error: "not_held", detail: `message is ${row.state}` } };
    const ts = iso();
    tx(this.db, () => {
      this.db.prepare("INSERT INTO reviews (message_id, reviewer, decision, note, decided_at) VALUES (?, ?, ?, ?, ?)").run(id, reviewer, decision, note ?? null, ts);
      if (decision === "release") {
        this.addParticipant(row.thread_id, row.to_addr);
        this.db.prepare("UPDATE messages SET state = 'queued', updated_at = ?, expires_at = ? WHERE id = ?").run(ts, iso(Date.now() + this.policy.limits.message_ttl_ms), id);
      } else {
        this.db.prepare("UPDATE messages SET state = 'blocked', reason_code = 'rejected_by_reviewer', delivered_text = NULL, updated_at = ? WHERE id = ?").run(ts, id);
      }
    });
    this.audit(reviewer, decision === "release" ? "message.release" : "message.reject", id, { note });
    const updated = this.getMessage(id)!;
    this.notify(updated);
    if (updated.state === "queued") this.tryDeliver(id);
    return { status: 200, body: { id, state: updated.state } };
  }

  /** Playground: run stage 1 link checks and the guard without storing or delivering anything. */
  async dryRun(input: { from: string; to: string; scope: string; kind?: string; text: string }): Promise<Record<string, unknown>> {
    const t0 = performance.now();
    const p = this.policy;
    const stage1: StageResult = { stage: "envelope", decision: "allow", categories: [], reason: "Link and scope checks passed.", latency_ms: 0 };
    const deny = (c: string, r: string): void => {
      stage1.decision = "block";
      stage1.categories = [c];
      stage1.reason = r;
    };
    if (!this.getAgent(input.from)) deny("unknown_sender", `${input.from} is not registered.`);
    else if (!this.getAgent(input.to)) deny("unknown_recipient", `${input.to} is not registered.`);
    else if (!p.scopes[input.scope] && !linksBetween(p, input.from, input.to).some((l) => l.scopes.includes("*"))) deny("unknown_scope", `Scope "${input.scope}" is not defined.`);
    else if (!linkFor(p, input.from, input.to, input.scope) && !linksBetween(p, input.from, input.to).some((l) => l.scopes.includes("*"))) deny("link_not_allowed", `Policy has no link from ${input.from} to ${input.to} for "${input.scope}".`);
    stage1.latency_ms = Math.round(performance.now() - t0);

    if (stage1.decision === "block") {
      return { decision: "block", reason_code: stage1.categories[0], reason: stage1.reason, stages: [stage1], findings: [], delivered_text: null, policy_version: this.policyVersion };
    }
    const v = await screen({ from: input.from, to: input.to, kind: input.kind ?? "request", scope: input.scope, text: input.text, policy: p, judges: this.judges }, [stage1]);
    return { ...v, policy_version: this.policyVersion };
  }

  // ---------------------------------------------------------------- views

  summary(row: MessageRow): Record<string, unknown> {
    return {
      id: row.id,
      thread_id: row.thread_id,
      in_reply_to: row.in_reply_to,
      from: row.from_addr,
      to: row.to_addr,
      scope: row.scope,
      kind: row.kind,
      hop: row.hop,
      state: row.state,
      decision: row.decision,
      reason_code: row.reason_code,
      categories: JSON.parse(row.categories ?? "[]"),
      preview: row.preview,
      redacted: !!row.redacted,
      guard_ms: row.guard_ms,
      received_at: row.received_at,
      updated_at: row.updated_at,
    };
  }

  listMessages(opts: { state?: string; limit?: number; before?: string; agent?: string }): Record<string, unknown>[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.state) {
      where.push("state = ?");
      args.push(opts.state);
    }
    if (opts.before) {
      where.push("received_at < ?");
      args.push(opts.before);
    }
    if (opts.agent) {
      where.push("(from_addr = ? OR to_addr = ?)");
      args.push(opts.agent, opts.agent);
    }
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(`SELECT * FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC, id DESC LIMIT ${limit}`)
      .all(...args) as unknown as MessageRow[];
    return rows.map((r) => this.summary(r));
  }

  messageDetail(id: string, actor: string): Record<string, unknown> | null {
    const row = this.getMessage(id);
    if (!row) return null;
    this.audit(actor, "message.read", id);
    const env = JSON.parse(row.envelope) as Envelope;
    const stages = (this.db.prepare("SELECT * FROM verdict_stages WHERE message_id = ? ORDER BY id").all(id) as Record<string, unknown>[]).map((s) => ({
      ...s,
      categories: JSON.parse(s.categories as string),
      error: !!s.error,
    }));
    return {
      ...this.summary(row),
      reason: row.reason,
      expects_reply: !!row.expects_reply,
      created_at: row.created_at,
      delivered_at: row.delivered_at,
      expires_at: row.expires_at,
      policy_version: row.policy_version,
      original_text: env.body.text,
      delivered_text: row.delivered_text,
      attachments: (env.body.attachments ?? []).map((a) => ({ name: a.name, mime: a.mime, bytes: Buffer.from(a.data, "base64").length })),
      findings: JSON.parse(row.findings ?? "[]"),
      signature: env.sig.slice(0, 24) + "…",
      stages,
      deliveries: this.db.prepare("SELECT attempt, sent_at, acked_at FROM deliveries WHERE message_id = ? ORDER BY id").all(id),
      reviews: this.db.prepare("SELECT reviewer, decision, note, decided_at FROM reviews WHERE message_id = ? ORDER BY id").all(id),
    };
  }

  threadDetail(id: string): Record<string, unknown> | null {
    const t = this.getThread(id);
    if (!t) return null;
    const rows = this.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at, id").all(id) as unknown as MessageRow[];
    const participants = (this.db.prepare("SELECT address FROM thread_participants WHERE thread_id = ?").all(id) as { address: string }[]).map((p) => p.address);
    return { ...t, participants, messages: rows.map((r) => ({ ...this.summary(r), text: r.delivered_text ?? null })) };
  }

  listAgents(): Record<string, unknown>[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY status = 'pending' DESC, address").all() as unknown as AgentRow[];
    return rows.map((a) => ({
      ...this.agentView(a),
      can_message: this.directory(a.address).map((d) => d.address),
    }));
  }

  stats(): Record<string, unknown> {
    const since = iso(Date.now() - 24 * 3600_000);
    const byState = Object.fromEntries(
      (this.db.prepare("SELECT state, COUNT(*) AS n FROM messages WHERE received_at > ? GROUP BY state").all(since) as { state: string; n: number }[]).map((r) => [r.state, r.n]),
    );
    const { redacted } = this.db.prepare("SELECT COUNT(*) AS redacted FROM messages WHERE redacted = 1 AND received_at > ?").get(since) as { redacted: number };
    const lat = this.db
      .prepare("SELECT guard_ms FROM messages WHERE guard_ms IS NOT NULL AND received_at > ? ORDER BY guard_ms")
      .all(since) as { guard_ms: number }[];
    const pct = (q: number): number | null => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]!.guard_ms : null);
    const agents = this.db.prepare("SELECT status, COUNT(*) AS n FROM agents GROUP BY status").all() as { status: string; n: number }[];
    return {
      window: "24h",
      by_state: byState,
      redacted,
      guard_p50_ms: pct(0.5),
      guard_p95_ms: pct(0.95),
      agents: Object.fromEntries(agents.map((a) => [a.status, a.n])),
      online: this.out.onlineAgents().length,
      invites: (this.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE revoked = 0 AND uses < max_uses AND expires_at > ?").get(iso()) as { n: number }).n,
      held: (this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE state = 'held'").get() as { n: number }).n,
    };
  }

  // ---------------------------------------------------------------- agent-facing reads

  directory(address: string): Record<string, unknown>[] {
    const agents = this.db.prepare("SELECT * FROM agents WHERE status = 'active' AND address <> ? ORDER BY address").all(address) as unknown as AgentRow[];
    return agents
      .map((a) => {
        const links = a.address === this.consoleAddress ? [{ scopes: ["*"] }] : linksBetween(this.policy, address, a.address);
        const scopes = [...new Set(links.flatMap((l) => (l.scopes.includes("*") ? Object.keys(this.policy.scopes) : l.scopes)))];
        return { address: a.address, display_name: a.display_name, description: a.description, online: this.isOnline(a.address), scopes };
      })
      .filter((a) => a.scopes.length > 0)
      .map((a) => ({ ...a, scopes: a.scopes.map((s) => ({ name: s, description: this.policy.scopes[s]?.description ?? "" })) }));
  }

  messageStatusFor(address: string, id: string): Record<string, unknown> | null {
    const row = this.getMessage(id);
    if (!row || (row.from_addr !== address && row.to_addr !== address)) return null;
    if (row.to_addr === address && row.from_addr !== address && !["queued", "delivered"].includes(row.state)) return null;
    return { id: row.id, thread_id: row.thread_id, state: row.state, reason_code: row.from_addr === address ? row.reason_code : null, received_at: row.received_at, updated_at: row.updated_at };
  }

  threadFor(address: string, id: string): Record<string, unknown> | null {
    const t = this.getThread(id);
    if (!t || !this.isParticipant(id, address)) return null;
    const rows = this.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at, id").all(id) as unknown as MessageRow[];
    const visible = rows
      .filter((r) => r.from_addr === address || ["queued", "delivered"].includes(r.state))
      .map((r) => {
        const own = r.from_addr === address;
        const env = JSON.parse(r.envelope) as Envelope;
        return {
          id: r.id,
          from: r.from_addr,
          to: r.to_addr,
          kind: r.kind,
          in_reply_to: r.in_reply_to,
          state: own ? r.state : "delivered",
          reason_code: own ? r.reason_code : null,
          text: own ? env.body.text : r.delivered_text,
          created_at: env.created_at,
        };
      });
    return { id: t.id, scope: t.scope, created_by: t.created_by, messages: visible };
  }

  agentKey(address: string): Record<string, unknown> | null {
    const a = this.getAgent(address);
    return a ? { address: a.address, public_key: a.public_key, status: a.status } : null;
  }
}

export type { Decision };
