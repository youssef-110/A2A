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
  type LinkRule,
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
  /** A one-off note to a connected agent's client, e.g. that a session it was in was deleted. */
  notice?(address: string, notice: Record<string, unknown>): void;
}

/** The website account behind a request. Only the hosted Worker sets it, after checking the person's sign-in. */
export interface Account {
  id: string;
  email?: string | null;
  name?: string | null;
  /** "owner" when the account owns this workspace: its agents become the owner's agents. */
  role?: "owner" | "member";
}

export const MAX_SESSION_MEMBERS = 50;
const DEFAULT_SESSION_MEMBERS = 10;
const BRIEF_MAX = 8000;
const clampMembers = (v: unknown): number => Math.min(Math.max(Math.floor(Number(v ?? DEFAULT_SESSION_MEMBERS)) || DEFAULT_SESSION_MEMBERS, 2), MAX_SESSION_MEMBERS);

const nullOutbound: Outbound = {
  deliver: () => 0,
  status: () => {},
  isOnline: () => false,
  disconnect: () => {},
  onlineAgents: () => [],
};

export interface RelayEvent {
  type: "message" | "agent" | "policy" | "audit" | "console" | "session";
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
  /** Session invites only work for a signed-in account (the hosted relay). */
  requireAccount?: boolean;
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
  private readonly requireAccount: boolean;
  private readonly queue: string[] = [];
  /** Every message queued or being screened right now, so recover() never screens one twice. */
  private readonly pending = new Set<string>();
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
    this.requireAccount = opts.requireAccount ?? false;
    this.loadPolicy(opts.initialPolicy);
  }

  start(): void {
    this.recover();
    this.sweepTimer = setInterval(() => this.sweep(), 5000);
    this.sweepTimer.unref();
  }

  /**
   * Crash recovery: anything left mid-screening is screened again. Durable Objects call this on every wake-up,
   * including alarms that fire while a slow judge call is still running, so messages this instance is already
   * screening are skipped.
   */
  recover(): void {
    const stuck = this.db.prepare("SELECT id FROM messages WHERE state = 'screening' ORDER BY received_at").all() as { id: string }[];
    for (const { id } of stuck) this.enqueue(id);
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

  createInvite(input: { note?: unknown; max_uses?: unknown; ttl_hours?: unknown; session_id?: unknown; owner?: unknown }, actor: string): InviteRow {
    const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
    if (sessionId && !this.getSession(sessionId)) throw new Error("unknown session");
    const code = randomBytes(12).toString("base64url");
    const maxUses = Math.min(Math.max(Math.floor(Number(input.max_uses ?? 1)) || 1, 1), 100);
    const ttlHours = Math.min(Math.max(Number(input.ttl_hours ?? 168) || 168, 1), 24 * 90);
    const now = Date.now();
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 120) : null;
    this.db
      .prepare("INSERT INTO invites (code, note, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)")
      .run(code, note, actor, iso(now), iso(now + ttlHours * 3600_000), maxUses);
    if (sessionId || input.owner === true) this.db.prepare("INSERT INTO invite_targets (code, session_id, owner) VALUES (?, ?, ?)").run(code, sessionId, input.owner === true ? 1 : 0);
    this.audit(actor, "invite.create", code.slice(0, 6), { note, max_uses: maxUses, ttl_hours: ttlHours, session: sessionId, owner: input.owner === true });
    return this.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as InviteRow;
  }

  listInvites(sessionId?: string): (InviteRow & { valid: boolean; session_id: string | null; owner: boolean })[] {
    const rows = this.db
      .prepare(`SELECT i.*, t.session_id, COALESCE(t.owner, 0) AS owner FROM invites i LEFT JOIN invite_targets t ON t.code = i.code ${sessionId ? "WHERE t.session_id = ?" : ""} ORDER BY i.created_at DESC LIMIT 100`)
      .all(...(sessionId ? [sessionId] : [])) as (InviteRow & { session_id: string | null; owner: number })[];
    return rows.map((r) => ({ ...r, owner: !!r.owner, valid: this.inviteUsable(r, r.session_id) }));
  }

  // ---------------------------------------------------------------- sessions

  private getSession(id: string): { id: string; name: string; created_at: string; archived: number } | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as never;
  }

  isOwnerAgent(address: string): boolean {
    return address === this.consoleAddress || !!this.db.prepare("SELECT 1 FROM owner_agents WHERE address = ?").get(address);
  }

  private inAnySession(address: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM session_members m JOIN sessions s ON s.id = m.session_id WHERE m.address = ? AND s.archived = 0 LIMIT 1").get(address);
  }

  private shareSession(a: string, b: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM session_members x JOIN session_members y ON x.session_id = y.session_id JOIN sessions s ON s.id = x.session_id WHERE x.address = ? AND y.address = ? AND s.archived = 0 LIMIT 1")
      .get(a, b);
  }

  /** In sessions mode: the owner's agents reach anyone in a session; guests reach only people they share a session with. */
  canTalk(a: string, b: string): boolean {
    const ownerA = this.isOwnerAgent(a);
    const ownerB = this.isOwnerAgent(b);
    if (ownerA && ownerB) return true;
    if (ownerA) return this.inAnySession(b);
    if (ownerB) return this.inAnySession(a);
    return this.shareSession(a, b);
  }

  createSession(input: { name?: unknown; max_members?: unknown; brief?: unknown }, actor: string): { id: string; name: string; max_members: number } {
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : "New session";
    const id = `ses_${randomBytes(9).toString("base64url")}`;
    const max = clampMembers(input.max_members);
    const brief = typeof input.brief === "string" && input.brief.trim() ? input.brief.trim().slice(0, BRIEF_MAX) : null;
    const now = iso();
    tx(this.db, () => {
      this.db.prepare("INSERT INTO sessions (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run(id, name, actor, now);
      this.db.prepare("INSERT INTO session_settings (session_id, max_members, brief, brief_updated_by, brief_updated_at) VALUES (?, ?, ?, ?, ?)").run(id, max, brief, brief ? actor : null, brief ? now : null);
    });
    this.audit(actor, "session.create", id, { name, max_members: max });
    return { id, name, max_members: max };
  }

  /** Changes a session's name, size or brief. */
  updateSession(id: string, input: { name?: unknown; max_members?: unknown; brief?: unknown }, actor: string): boolean {
    const s = this.getSession(id);
    if (!s || s.archived) return false;
    this.ensureSettings(id);
    const changed: Record<string, unknown> = {};
    if (typeof input.name === "string" && input.name.trim()) {
      changed.name = input.name.trim().slice(0, 80);
      this.db.prepare("UPDATE sessions SET name = ? WHERE id = ?").run(changed.name as string, id);
    }
    if (input.max_members !== undefined) {
      changed.max_members = clampMembers(input.max_members);
      this.db.prepare("UPDATE session_settings SET max_members = ? WHERE session_id = ?").run(changed.max_members as number, id);
      // Session links let in as many people as the session has room for.
      this.db.prepare("UPDATE invites SET max_uses = ? WHERE code IN (SELECT code FROM invite_targets WHERE session_id = ?) AND revoked = 0").run(changed.max_members as number, id);
    }
    if (typeof input.brief === "string") this.setBrief(id, input.brief, actor);
    if (Object.keys(changed).length) {
      this.audit(actor, "session.update", id, changed);
      this.emitEvent("session", { id });
    }
    return true;
  }

  private ensureSettings(id: string): void {
    this.db.prepare("INSERT OR IGNORE INTO session_settings (session_id, max_members) VALUES (?, ?)").run(id, DEFAULT_SESSION_MEMBERS);
  }

  private settings(id: string): { max_members: number; brief: string | null; brief_updated_by: string | null; brief_updated_at: string | null } {
    return (
      (this.db.prepare("SELECT max_members, brief, brief_updated_by, brief_updated_at FROM session_settings WHERE session_id = ?").get(id) as never) ?? {
        max_members: DEFAULT_SESSION_MEMBERS,
        brief: null,
        brief_updated_by: null,
        brief_updated_at: null,
      }
    );
  }

  /** The shared brief: what the session is about, who does what, decisions so far. Every member's agent reads it. */
  setBrief(id: string, text: string, actor: string): boolean {
    const s = this.getSession(id);
    if (!s || s.archived) return false;
    this.ensureSettings(id);
    const brief = text.trim().slice(0, BRIEF_MAX) || null;
    this.db.prepare("UPDATE session_settings SET brief = ?, brief_updated_by = ?, brief_updated_at = ? WHERE session_id = ?").run(brief, actor, iso(), id);
    this.audit(actor, "session.brief", id, { chars: brief?.length ?? 0 });
    this.emitEvent("session", { id });
    return true;
  }

  accountOf(address: string): { account_id: string; email: string | null; name: string | null } | undefined {
    return this.db.prepare("SELECT account_id, email, name FROM agent_accounts WHERE address = ?").get(address) as never;
  }

  /** People in a session: agents of the same account count once. */
  private peopleIn(id: string): Set<string> {
    const rows = this.db
      .prepare("SELECT COALESCE(a.account_id, m.address) AS who FROM session_members m LEFT JOIN agent_accounts a ON a.address = m.address WHERE m.session_id = ?")
      .all(id) as { who: string }[];
    return new Set(rows.map((r) => r.who));
  }

  private sessionMembers(id: string): string[] {
    const guests = this.guestsOf(id);
    const owners = (this.db.prepare("SELECT address FROM owner_agents ORDER BY added_at").all() as { address: string }[]).map((r) => r.address);
    return [...new Set([this.consoleAddress, ...owners, ...guests])];
  }

  private guestsOf(id: string): string[] {
    return (this.db.prepare("SELECT address FROM session_members WHERE session_id = ? ORDER BY joined_at").all(id) as { address: string }[]).map((r) => r.address);
  }

  private memberView(a: string, guests: string[]): Record<string, unknown> {
    const acct = this.accountOf(a);
    return {
      address: a,
      display_name: this.getAgent(a)?.display_name ?? null,
      person: acct?.name ?? null,
      email: acct?.email ?? null,
      account_id: acct?.account_id ?? null,
      online: this.isOnline(a),
      role: guests.includes(a) ? "guest" : "owner",
    };
  }

  /**
   * Messages between this session's members that involve at least one guest. Someone in two of the
   * owner's sessions shows up in both, so this is the owner's view; guests get viewerMessages instead.
   */
  private sessionMessages(id: string, limit: number): MessageRow[] {
    const guests = this.guestsOf(id);
    const members = this.sessionMembers(id);
    const marks = members.map(() => "?").join(",");
    const gm = guests.map(() => "?").join(",") || "''";
    return this.db
      .prepare(`SELECT * FROM messages WHERE from_addr IN (${marks}) AND to_addr IN (${marks}) AND (from_addr IN (${gm}) OR to_addr IN (${gm})) ORDER BY received_at DESC LIMIT ${Math.floor(limit)}`)
      .all(...members, ...members, ...guests, ...guests) as unknown as MessageRow[];
  }

  accountInSession(account: string, id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM session_members m JOIN agent_accounts a ON a.address = m.address WHERE m.session_id = ? AND a.account_id = ? LIMIT 1").get(id, account);
  }

  /** Every session, or (for a guest's "shared with me" view) only those the account is in. */
  listSessions(filter?: { account?: string }): Record<string, unknown>[] {
    let rows = this.db.prepare("SELECT * FROM sessions WHERE archived = 0 ORDER BY created_at DESC").all() as { id: string; name: string; created_at: string }[];
    if (filter?.account) rows = rows.filter((s) => this.accountInSession(filter.account!, s.id));
    return rows.map((s) => {
      const guests = this.guestsOf(s.id);
      const last = (filter?.account ? this.viewerMessages(s.id, filter.account) : this.sessionMessages(s.id, 1))[0];
      const st = this.settings(s.id);
      return {
        id: s.id,
        name: s.name,
        created_at: s.created_at,
        max_members: st.max_members,
        people: this.peopleIn(s.id).size,
        guests: guests.map((a) => this.memberView(a, guests)),
        last_message_at: last?.received_at ?? null,
        last_preview: last?.preview ?? null,
      };
    });
  }

  /** viewer: a guest's account. Guests see only conversations their own agents took part in. */
  sessionDetail(id: string, viewer?: string): Record<string, unknown> | null {
    const s = this.getSession(id);
    if (!s || s.archived) return null;
    const guests = this.guestsOf(id);
    const st = this.settings(id);
    return {
      id: s.id,
      name: s.name,
      created_at: s.created_at,
      max_members: st.max_members,
      people: this.peopleIn(id).size,
      brief: st.brief,
      brief_updated_by: st.brief_updated_by,
      brief_updated_at: st.brief_updated_at,
      members: this.sessionMembers(id).map((a) => this.memberView(a, guests)),
      invites: this.listInvites(id),
      messages: (viewer ? this.viewerMessages(id, viewer) : this.sessionMessages(id, 300)).reverse().map((r) => ({ ...this.summary(r), text: r.delivered_text })),
    };
  }

  private viewerMessages(id: string, account: string): MessageRow[] {
    const mine = (this.db.prepare("SELECT address FROM agent_accounts WHERE account_id = ?").all(account) as { address: string }[]).map((r) => r.address);
    const members = new Set(this.sessionMembers(id));
    if (!mine.length) return [];
    const marks = mine.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM messages WHERE from_addr IN (${marks}) OR to_addr IN (${marks}) ORDER BY received_at DESC LIMIT 300`).all(...mine, ...mine) as unknown as MessageRow[]).filter(
      (r) => members.has(r.from_addr) && members.has(r.to_addr),
    );
  }

  /**
   * Deletes a session for everyone: its links stop working, its guests lose access to its people,
   * and connected guests are told. Messages stay in the activity log and audit trail.
   */
  deleteSession(id: string, actor: string): boolean {
    const s = this.getSession(id);
    if (!s || s.archived) return false;
    const guests = this.guestsOf(id);
    tx(this.db, () => {
      this.db.prepare("UPDATE invites SET revoked = 1 WHERE code IN (SELECT code FROM invite_targets WHERE session_id = ?)").run(id);
      this.db.prepare("DELETE FROM session_members WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM session_settings WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
    this.audit(actor, "session.delete", id, { name: s.name, guests: guests.length });
    for (const a of guests) this.out.notice?.(a, { kind: "session_deleted", session: { id, name: s.name } });
    this.emitEvent("session", { id, deleted: true });
    return true;
  }

  removeSessionMember(id: string, address: string, actor: string): boolean {
    // Removing a person removes every agent of theirs from the session.
    const acct = this.accountOf(address);
    const addresses = acct
      ? (this.db.prepare("SELECT m.address FROM session_members m JOIN agent_accounts a ON a.address = m.address WHERE m.session_id = ? AND a.account_id = ?").all(id, acct.account_id) as { address: string }[]).map((r) => r.address)
      : [address];
    let n = 0;
    for (const a of addresses) n += Number(this.db.prepare("DELETE FROM session_members WHERE session_id = ? AND address = ?").run(id, a).changes);
    if (n) {
      this.audit(actor, "session.remove_member", id, { address, agents: n });
      const name = this.getSession(id)?.name ?? null;
      for (const a of addresses) this.out.notice?.(a, { kind: "session_removed", session: { id, name } });
      this.emitEvent("session", { id });
    }
    return n > 0;
  }

  /** A person leaves (or is removed from) a session with all of their agents. */
  removeAccountFromSession(id: string, accountId: string, actor: string): boolean {
    const one = this.db.prepare("SELECT m.address FROM session_members m JOIN agent_accounts a ON a.address = m.address WHERE m.session_id = ? AND a.account_id = ? LIMIT 1").get(id, accountId) as { address: string } | undefined;
    return !!one && this.removeSessionMember(id, one.address, actor);
  }

  // ---------------------------------------------------------------- agent-facing sessions

  /** The sessions an agent is in, with the brief and the people in each. Owner agents see every session. */
  sessionsFor(address: string): Record<string, unknown>[] {
    const rows = (
      this.isOwnerAgent(address)
        ? this.db.prepare("SELECT * FROM sessions WHERE archived = 0 ORDER BY created_at DESC").all()
        : this.db.prepare("SELECT s.* FROM sessions s JOIN session_members m ON m.session_id = s.id WHERE m.address = ? AND s.archived = 0 ORDER BY s.created_at DESC").all(address)
    ) as { id: string; name: string }[];
    return rows.map((s) => {
      const guests = this.guestsOf(s.id);
      const st = this.settings(s.id);
      return {
        id: s.id,
        name: s.name,
        brief: st.brief,
        brief_updated_at: st.brief_updated_at,
        max_members: st.max_members,
        // Emails are for the owner's dashboard, not for every agent in the session.
        members: this.sessionMembers(s.id)
          .filter((a) => a !== this.consoleAddress && a !== address)
          .map((a) => {
            const { email: _e, account_id: _i, ...v } = this.memberView(a, guests);
            return v;
          }),
      };
    });
  }

  /** Members may rewrite the brief of a session they are in. */
  agentSetBrief(address: string, id: string, text: string): boolean {
    if (!this.sessionsFor(address).some((s) => s.id === id)) return false;
    return this.setBrief(id, text, address);
  }

  revokeInvite(code: string, actor: string): boolean {
    const r = this.db.prepare("UPDATE invites SET revoked = 1 WHERE code = ?").run(code);
    if (Number(r.changes)) this.audit(actor, "invite.revoke", code.slice(0, 6));
    return Number(r.changes) > 0;
  }

  /** Session links are limited by the session's size rather than a use count, so a place frees up when someone leaves. */
  private inviteUsable(r: InviteRow | undefined, sessionId?: string | null): boolean {
    return !!r && !r.revoked && (!!sessionId || r.uses < r.max_uses) && Date.parse(r.expires_at) > Date.now();
  }

  /** Public view of an invite, for the join page. Says nothing about other invites or agents. */
  inviteInfo(code: string): Record<string, unknown> {
    const r = this.db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as InviteRow | undefined;
    const target = r ? (this.db.prepare("SELECT t.owner, t.session_id, s.name FROM invite_targets t LEFT JOIN sessions s ON s.id = t.session_id WHERE t.code = ?").get(code) as { owner: number; session_id: string | null; name: string | null } | undefined) : undefined;
    const room = target?.session_id && target.name !== null ? { people: this.peopleIn(target.session_id).size, max_members: this.settings(target.session_id).max_members } : {};
    return {
      valid: this.inviteUsable(r, target?.session_id) && (!target?.session_id || target.name !== null),
      org: this.policy.org,
      note: r?.note ?? null,
      expires_at: r?.expires_at ?? null,
      session: target?.name ?? null,
      owner: !!target?.owner,
      sign_in_required: !!target?.session_id && this.requireAccount,
      ...room,
    };
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
    account?: Account,
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
    let target: { session_id: string | null; owner: number } | undefined;
    if (typeof input.invite === "string" && input.invite) {
      invite = this.db.prepare("SELECT * FROM invites WHERE code = ?").get(input.invite) as InviteRow | undefined;
      target = invite ? (this.db.prepare("SELECT session_id, owner FROM invite_targets WHERE code = ?").get(invite.code) as typeof target) : undefined;
      if (!this.inviteUsable(invite, target?.session_id)) return { status: 403, body: { error: "invalid_invite", detail: "this invite link is expired, used up or revoked" } };
    }
    if (target?.session_id && this.requireAccount && !account) {
      return { status: 401, body: { error: "sign_in_required", detail: "Sessions need a signed-in account. Run: npx -y <relay>/a2a.tgz connect <invite link>" } };
    }
    const bound = this.accountOf(address);
    if (bound && account && bound.account_id !== account.id) return { status: 409, body: { error: "key_conflict", detail: "this agent name belongs to someone else; pick another name" } };
    if (target?.session_id && !this.hasRoom(target.session_id, account?.id ?? address)) {
      return { status: 403, body: { error: "session_full", detail: "this session is full; ask its owner to make room" } };
    }

    // A signed-in person needs no invite for what they already have: the workspace owner gets owner
    // agents, and someone already in sessions here brings each new agent of theirs into the same sessions.
    const ownerAccount = account?.role === "owner";
    const accountSessions = account ? this.accountSessionIds(account.id) : [];
    const activate = admin || !!invite || ownerAccount || accountSessions.length > 0 || this.policy.registration === "open";

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
      this.audit(admin ? "admin" : address, admin ? "agent.register" : invite ? "agent.join" : activate ? "agent.register_open" : "agent.request", address, {
        ...(invite ? { invite: invite.code.slice(0, 6) } : {}),
        ...(account?.email ? { account: account.email } : {}),
      });
    }
    const disabled = existing?.status === "disabled";
    if (account && !disabled) {
      this.db
        .prepare("INSERT INTO agent_accounts (address, account_id, email, name) VALUES (?, ?, ?, ?) ON CONFLICT (address) DO UPDATE SET email = excluded.email, name = excluded.name")
        .run(address, account.id, str(account.email, 200), str(account.name, 80));
      if (ownerAccount) this.db.prepare("INSERT OR IGNORE INTO owner_agents (address, added_at) VALUES (?, ?)").run(address, now);
      for (const sid of accountSessions) this.db.prepare("INSERT OR IGNORE INTO session_members (session_id, address, joined_at) VALUES (?, ?, ?)").run(sid, address, now);
    }
    if (invite) {
      // What the invite was for: one session, or the owner's own agents. Whatever it grants costs a use,
      // so an agent that is already registered can't replay a link to collect memberships for free.
      // A person already in the session doesn't use up a place again with another agent.
      const grants = !!target && !disabled;
      const alreadyIn = !!target?.session_id && !!account && this.accountInSession(account.id, target.session_id);
      if (!alreadyIn && (grants || !existing || existing.status === "pending")) this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?").run(invite.code);
      if (grants && target!.owner) this.db.prepare("INSERT OR IGNORE INTO owner_agents (address, added_at) VALUES (?, ?)").run(address, now);
      if (grants && target!.session_id) {
        // Every agent the person already has here joins with them.
        const theirs = account ? (this.db.prepare("SELECT address FROM agent_accounts WHERE account_id = ?").all(account.id) as { address: string }[]).map((r) => r.address) : [address];
        for (const a of new Set([address, ...theirs])) this.db.prepare("INSERT OR IGNORE INTO session_members (session_id, address, joined_at) VALUES (?, ?, ?)").run(target!.session_id, a, now);
        this.emitEvent("session", { id: target!.session_id });
      }
    }
    const agent = this.getAgent(address)!;
    this.emitEvent("agent", this.agentView(agent));
    const sessions = agent.status === "active" ? this.sessionsFor(address).map((s) => ({ id: s.id, name: s.name })) : [];
    return { status: existing ? 200 : 201, body: { address, status: agent.status, relay_public_key: this.relayPublicKey, sessions } };
  }

  /** Sessions any agent of this account is in. */
  private accountSessionIds(accountId: string): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT m.session_id FROM session_members m JOIN agent_accounts a ON a.address = m.address JOIN sessions s ON s.id = m.session_id WHERE a.account_id = ? AND s.archived = 0")
        .all(accountId) as { session_id: string }[]
    ).map((r) => r.session_id);
  }

  /** Whether a person (account id, or the address for agents without one) fits in a session. */
  private hasRoom(sessionId: string, who: string): boolean {
    const people = this.peopleIn(sessionId);
    return people.has(who) || people.size < this.settings(sessionId).max_members;
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
      account: this.accountOf(a.address) ?? null,
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
    // The console (the admin) may message anyone. Agents reach the console only by replying or through a policy link.
    const consoleLink = env.from === this.consoleAddress;
    // In sessions mode, sharing a session takes the place of link rules (and allows any topic).
    const sessionLink = p.isolation === "sessions" && this.canTalk(env.from, env.to) ? { from: env.from, to: env.to, scopes: ["*"] } : undefined;
    const wildcardLink = sessionLink ?? (p.isolation === "sessions" ? undefined : linksBetween(p, env.from, env.to).find((l) => l.scopes.includes("*")));
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
    const link: LinkRule | undefined = consoleLink ? { from: env.from, to: env.to, scopes: ["*"] } : p.isolation === "sessions" ? sessionLink : (linkFor(p, env.from, env.to, env.scope) ?? wildcardLink);
    if (!link && !impliedReply) {
      if (p.isolation === "sessions") return block("not_in_session", `${env.from} and ${env.to} don't share a session.`, hop);
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
    if (this.pending.has(id)) return;
    this.pending.add(id);
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
          this.pending.delete(id);
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
    // Only the first verdict for a message counts. A later one (the message was screened twice) changes nothing.
    const applied = tx(this.db, () => {
      const r = this.db
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
      if (!Number(r.changes)) return false;
      for (const s of v.stages) this.insertStage(row.id, s, ts);
      if (state === "queued") this.addParticipant(row.thread_id, row.to_addr);
      return true;
    });
    if (!applied) return;
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
      owner: this.isOwnerAgent(a.address),
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
        const links = this.policy.isolation === "sessions" ? (this.canTalk(address, a.address) ? [{ scopes: ["*"] }] : []) : linksBetween(this.policy, address, a.address);
        const scopes = [...new Set(links.flatMap((l) => (l.scopes.includes("*") ? Object.keys(this.policy.scopes) : l.scopes)))];
        return { address: a.address, display_name: a.display_name, description: a.description, person: this.accountOf(a.address)?.name ?? null, online: this.isOnline(a.address), scopes };
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
