import { randomBytes } from "node:crypto";
import { tx } from "./db.ts";
import type { Relay } from "./relay.ts";

/**
 * Tasks: one agent (the coordinator) splits work into parts and hands each part to another agent.
 * The relay keeps the board, tells each worker what to do, checks in on parts that go quiet, and
 * asks everyone to vote once every part is reported. A task is done only when all of them vote done;
 * then everyone gets the combined report.
 *
 * Every note the board sends starts with "[a2a-task <id>]" so clients can recognise it and run the
 * worker with the task's permissions.
 */

export type PermissionMode = "full" | "standard" | "read_only" | "custom";

export interface Permissions {
  mode: PermissionMode;
  /** Screen messages with the guard. Off means messages are delivered as written. */
  guard: boolean;
  /** Headless workers may edit and create files. */
  worker_edit: boolean;
  /** Headless workers may run shell commands. */
  worker_shell: boolean;
  /** Headless workers may search and fetch the web. */
  worker_web: boolean;
  /** Agents may split work and hand parts to other agents. */
  delegate: boolean;
  /** Messages containing any of these words are held for the owner to review. */
  flag_terms: string[];
  /** How long a part may go without an update before the board checks in. */
  checkin_minutes: number;
}

export const PRESETS: Record<Exclude<PermissionMode, "custom">, Omit<Permissions, "flag_terms" | "checkin_minutes">> = {
  full: { mode: "full", guard: false, worker_edit: true, worker_shell: true, worker_web: true, delegate: true },
  standard: { mode: "standard", guard: true, worker_edit: true, worker_shell: false, worker_web: true, delegate: true },
  read_only: { mode: "read_only", guard: true, worker_edit: false, worker_shell: false, worker_web: false, delegate: false },
};

export const DEFAULT_PERMISSIONS: Permissions = { ...PRESETS.standard, flag_terms: [], checkin_minutes: 10 };

/** Normalises what the dashboard sends: a preset fills the switches; "custom" keeps the ones given. */
export function normalizePermissions(input: Record<string, unknown>, base: Permissions = DEFAULT_PERMISSIONS): Permissions {
  const mode = (["full", "standard", "read_only", "custom"] as const).find((m) => m === input.mode) ?? base.mode;
  const flag = (k: keyof Permissions): boolean => (typeof input[k] === "boolean" ? (input[k] as boolean) : (base[k] as boolean));
  const switches = mode === "custom"
    ? { mode, guard: flag("guard"), worker_edit: flag("worker_edit"), worker_shell: flag("worker_shell"), worker_web: flag("worker_web"), delegate: flag("delegate") }
    : PRESETS[mode];
  const terms = Array.isArray(input.flag_terms) ? input.flag_terms : typeof input.flag_terms === "string" ? input.flag_terms.split(/[,\n]/) : base.flag_terms;
  const flag_terms = [...new Set(terms.map((t) => String(t).trim().toLowerCase()).filter((t) => t.length >= 2))].slice(0, 50).map((t) => t.slice(0, 60));
  const minutes = Number(input.checkin_minutes ?? base.checkin_minutes);
  return { ...switches, flag_terms, checkin_minutes: Number.isFinite(minutes) ? Math.min(Math.max(minutes, 1), 240) : base.checkin_minutes };
}

/** One line a person or an agent can read. */
export function describePermissions(p: Permissions): string {
  const can = [p.worker_edit && "edit files", p.worker_shell && "run commands", p.worker_web && "use the web", p.delegate && "split work"].filter(Boolean);
  const label = { full: "Full access", standard: "Standard", read_only: "Read only", custom: "Custom" }[p.mode];
  return `${label}: workers may ${can.length ? can.join(", ") : "only read"}${p.guard ? "; messages are screened" : "; messages are not screened"}${p.flag_terms.length ? `; messages mentioning ${p.flag_terms.join(", ")} are held for review` : ""}.`;
}

export interface SubtaskInput {
  assignee: string;
  title: string;
  detail?: string;
}

interface TaskRow {
  id: string;
  session_id: string | null;
  title: string;
  goal: string;
  coordinator: string;
  status: "active" | "review" | "done" | "cancelled";
  final_report: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  task_id: string;
  assignee: string;
  title: string;
  detail: string;
  status: "assigned" | "working" | "blocked" | "done";
  progress: string | null;
  report: string | null;
  nudges: number;
  last_nudge_at: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_ITEMS = 20;
const MAX_NUDGES = 3;
const iso = (ms = Date.now()): string => new Date(ms).toISOString();
const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const short = (address: string): string => address.split("/").pop() ?? address;
const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString("base64url")}`;

export class TaskError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, detail?: string) {
    super(detail ?? code);
    this.status = status;
    this.code = code;
  }
}

export class TaskBoard {
  /** Check-in timing; tests shorten it. */
  checkinMs?: number;

  private readonly relay: Relay;

  constructor(relay: Relay) {
    this.relay = relay;
  }

  private get db() {
    return this.relay.db;
  }

  // ------------------------------------------------------------ permissions

  /** Stored permissions for a session, or "workspace" for the default. */
  permissions(scope: string): Permissions {
    const own = this.db.prepare("SELECT json FROM permissions WHERE scope = ?").get(scope) as { json: string } | undefined;
    if (own) return normalizePermissions(JSON.parse(own.json));
    if (scope !== "workspace") return this.permissions("workspace");
    return DEFAULT_PERMISSIONS;
  }

  /** Whether a session has its own permissions or follows the workspace's. */
  hasOwnPermissions(scope: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM permissions WHERE scope = ?").get(scope);
  }

  setPermissions(scope: string, input: Record<string, unknown>, actor: string): Permissions {
    if (input.inherit === true && scope !== "workspace") {
      this.db.prepare("DELETE FROM permissions WHERE scope = ?").run(scope);
      this.relay.audit(actor, "permissions.inherit", scope);
      this.relay.publish("permissions", { scope });
      return this.permissions(scope);
    }
    const p = normalizePermissions(input, this.permissions(scope));
    this.db
      .prepare("INSERT INTO permissions (scope, json, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (scope) DO UPDATE SET json = excluded.json, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .run(scope, JSON.stringify(p), actor, iso());
    this.relay.audit(actor, "permissions.set", scope, p);
    this.relay.publish("permissions", { scope, permissions: p });
    return p;
  }

  /** The sessions a message between two agents belongs to. */
  private sessionsOfPair(a: string, b: string): string[] {
    const of = (x: string): string[] =>
      (this.db.prepare("SELECT m.session_id AS id FROM session_members m JOIN sessions s ON s.id = m.session_id WHERE m.address = ? AND s.archived = 0").all(x) as { id: string }[]).map((r) => r.id);
    const ownerA = this.relay.isOwnerAgent(a);
    const ownerB = this.relay.isOwnerAgent(b);
    if (ownerA && ownerB) return [];
    if (ownerA) return of(b);
    if (ownerB) return of(a);
    const sb = new Set(of(b));
    return of(a).filter((id) => sb.has(id));
  }

  /** The permissions that apply between two agents: their session's, or the workspace's. */
  permissionsBetween(a: string, b: string): Permissions {
    const own = this.sessionsOfPair(a, b).find((id) => this.hasOwnPermissions(id));
    return this.permissions(own ?? "workspace");
  }

  // ------------------------------------------------------------ reading

  private task(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  private items(taskId: string): ItemRow[] {
    return this.db.prepare("SELECT * FROM task_items WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as ItemRow[];
  }

  private participants(t: TaskRow, items = this.items(t.id)): string[] {
    return [...new Set([t.coordinator, ...items.map((i) => i.assignee)])];
  }

  private isParticipant(t: TaskRow, address: string): boolean {
    return this.participants(t).includes(address);
  }

  view(t: TaskRow, opts: { events?: boolean } = {}): Record<string, unknown> {
    const items = this.items(t.id);
    const votes = this.db.prepare("SELECT address, vote, note, at FROM task_votes WHERE task_id = ?").all(t.id) as { address: string; vote: string; note: string | null; at: string }[];
    const done = items.filter((i) => i.status === "done").length;
    return {
      id: t.id,
      session_id: t.session_id,
      title: t.title,
      goal: t.goal,
      coordinator: t.coordinator,
      status: t.status,
      progress: { done, total: items.length },
      participants: this.participants(t, items),
      parts: items.map((i) => ({ id: i.id, assignee: i.assignee, title: i.title, detail: i.detail, status: i.status, progress: i.progress, report: i.report, updated_at: i.updated_at })),
      votes,
      permissions: this.permissions(t.session_id ?? "workspace"),
      final_report: t.final_report,
      created_at: t.created_at,
      updated_at: t.updated_at,
      ...(opts.events ? { events: this.db.prepare("SELECT actor, kind, text, at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 200").all(t.id) } : {}),
    };
  }

  /** Tasks an agent coordinates or works on. */
  listFor(address: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT DISTINCT t.* FROM tasks t LEFT JOIN task_items i ON i.task_id = t.id WHERE t.coordinator = ? OR i.assignee = ? ORDER BY t.updated_at DESC LIMIT 50")
      .all(address, address) as TaskRow[];
    return rows.map((t) => this.view(t));
  }

  detailFor(address: string, id: string): Record<string, unknown> {
    const t = this.task(id);
    if (!t || !this.isParticipant(t, address)) throw new TaskError(404, "not_found", `No task ${id} that you are part of.`);
    return this.view(t, { events: true });
  }

  /** The dashboard's list, optionally for one session. */
  list(sessionId?: string): Record<string, unknown>[] {
    const rows = (sessionId
      ? this.db.prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY updated_at DESC LIMIT 100").all(sessionId)
      : this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 100").all()) as TaskRow[];
    return rows.map((t) => this.view(t));
  }

  detail(id: string): Record<string, unknown> | null {
    const t = this.task(id);
    return t ? this.view(t, { events: true }) : null;
  }

  // ------------------------------------------------------------ writing

  private event(taskId: string, actor: string, kind: string, text: string): void {
    const at = iso();
    this.db.prepare("INSERT INTO task_events (task_id, actor, kind, text, at) VALUES (?, ?, ?, ?, ?)").run(taskId, actor, kind, text.slice(0, 2000), at);
    this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at, taskId);
    this.relay.publish("task", { id: taskId, actor, kind, text: text.slice(0, 300), at });
  }

  private tell(to: string, taskId: string, text: string): void {
    const r = this.relay.systemNotify(to, `[a2a-task ${taskId}] ${text}`, this.task(taskId)?.session_id ?? null);
    if (r.status >= 300) this.event(taskId, "relay", "undelivered", `Could not reach ${short(to)}: ${String(r.body.error ?? r.status)}`);
  }

  /**
   * The session a task belongs to, whose permissions apply. Every person on it (the owner's agents
   * aside) must be a member, so nobody can borrow another session's looser permissions.
   */
  private pickSession(coordinator: string, assignees: string[], wanted?: string): string | null {
    const guests = [...new Set([coordinator, ...assignees])].filter((a) => !this.relay.isOwnerAgent(a));
    const holdsAll = (id: string): boolean => guests.every((a) => !!this.db.prepare("SELECT 1 FROM session_members WHERE session_id = ? AND address = ?").get(id, a));
    if (wanted) {
      const ok = this.db.prepare("SELECT 1 FROM sessions WHERE id = ? AND archived = 0").get(wanted);
      if (!ok) throw new TaskError(404, "unknown_session", `No session ${wanted}.`);
      if (!holdsAll(wanted)) throw new TaskError(403, "not_in_session", "Everyone on the task must be in that session.");
      return wanted;
    }
    if (!guests.length) return null;
    const candidates = (this.db.prepare("SELECT m.session_id AS id FROM session_members m JOIN sessions s ON s.id = m.session_id WHERE m.address = ? AND s.archived = 0").all(guests[0]!) as { id: string }[]).map((r) => r.id);
    return candidates.find(holdsAll) ?? null;
  }

  private assignmentText(t: TaskRow, item: ItemRow, all: ItemRow[]): string {
    const p = this.permissions(t.session_id ?? "workspace");
    const others = all.filter((i) => i.id !== item.id).map((i) => `- ${short(i.assignee)}: ${i.title}`);
    return [
      `New assignment from ${short(t.coordinator)}.`,
      "",
      `Task: ${t.title} (task_id ${t.id})`,
      t.goal ? `Goal: ${t.goal}` : null,
      "",
      `Your part (part_id ${item.id}): ${item.title}`,
      item.detail || null,
      "",
      others.length ? `Others on this task:\n${others.join("\n")}` : "You are the only worker on this task.",
      "",
      `Permissions: ${describePermissions(p)}`,
      "",
      "How to work: start now and keep going until your part is done; nobody will prompt you again.",
      "- Post progress with task_update (status working, a short note) as you go.",
      "- If you need something from a teammate, ask them directly with send_message.",
      "- If you are stuck, task_update with status blocked and say why; the coordinator will help.",
      "- When finished, call task_report with a full report: what you did, files or results, and anything left open.",
    ]
      .filter((l) => l !== null)
      .join("\n");
  }

  create(from: string, input: Record<string, unknown>): Record<string, unknown> {
    const title = clip(input.title, 200);
    if (!title) throw new TaskError(400, "title_required");
    const goal = clip(input.goal, 4000);
    const raw = Array.isArray(input.parts) ? input.parts : Array.isArray(input.subtasks) ? input.subtasks : [];
    if (!raw.length) throw new TaskError(400, "parts_required", "Give at least one part: { assignee, title, detail }.");
    if (raw.length > MAX_ITEMS) throw new TaskError(400, "too_many_parts", `Up to ${MAX_ITEMS} parts.`);
    const parts = raw.map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const assignee = this.relay.resolveAddress(from, clip(o.assignee ?? o.to, 200));
      return { assignee, title: clip(o.title, 200) || "Your part", detail: clip(o.detail ?? o.instructions, 4000) };
    });
    const sessionId = this.pickSession(from, parts.map((p) => p.assignee), clip(input.session_id, 80) || undefined);
    const perms = this.permissions(sessionId ?? "workspace");
    if (!perms.delegate && !this.relay.isOwnerAgent(from)) throw new TaskError(403, "delegation_disabled", "This session's permissions don't let agents split work. The owner can turn it on in the dashboard.");
    for (const p of parts) {
      if (p.assignee !== from && !this.relay.mayReach(from, p.assignee)) throw new TaskError(403, "not_reachable", `${p.assignee} isn't in a session with you.`);
    }

    const now = iso();
    const t: TaskRow = { id: newId("tsk"), session_id: sessionId, title, goal, coordinator: from, status: "active", final_report: null, created_at: now, updated_at: now };
    tx(this.db, () => {
      this.db.prepare("INSERT INTO tasks (id, session_id, title, goal, coordinator, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(t.id, t.session_id, t.title, t.goal, t.coordinator, now, now);
      for (const p of parts) {
        this.db.prepare("INSERT INTO task_items (id, task_id, assignee, title, detail, status, nudges, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'assigned', 0, ?, ?)").run(newId("prt"), t.id, p.assignee, p.title, p.detail, now, now);
      }
    });
    this.relay.audit(from, "task.create", t.id, { title, parts: parts.length, session_id: sessionId });
    this.event(t.id, from, "created", `Split "${title}" into ${parts.length} part${parts.length === 1 ? "" : "s"}.`);
    const items = this.items(t.id);
    for (const i of items) {
      if (i.assignee === from) continue; // the coordinator's own part needs no notice
      this.tell(i.assignee, t.id, this.assignmentText(t, i, items));
    }
    return this.view(this.task(t.id)!);
  }

  addParts(from: string, id: string, input: Record<string, unknown>): Record<string, unknown> {
    const t = this.task(id);
    if (!t) throw new TaskError(404, "not_found");
    if (t.coordinator !== from) throw new TaskError(403, "not_coordinator", "Only the coordinator adds parts.");
    if (t.status === "done" || t.status === "cancelled") throw new TaskError(409, "task_closed", `The task is ${t.status}.`);
    const raw = Array.isArray(input.parts) ? input.parts : [];
    if (!raw.length) throw new TaskError(400, "parts_required");
    if (this.items(id).length + raw.length > MAX_ITEMS) throw new TaskError(400, "too_many_parts", `Up to ${MAX_ITEMS} parts.`);
    const now = iso();
    const added: string[] = [];
    for (const r of raw) {
      const o = (r ?? {}) as Record<string, unknown>;
      const assignee = this.relay.resolveAddress(from, clip(o.assignee ?? o.to, 200));
      if (assignee !== from && !this.relay.mayReach(from, assignee)) throw new TaskError(403, "not_reachable", `${assignee} isn't in a session with you.`);
      const pid = newId("prt");
      this.db.prepare("INSERT INTO task_items (id, task_id, assignee, title, detail, status, nudges, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'assigned', 0, ?, ?)").run(pid, id, assignee, clip(o.title, 200) || "Your part", clip(o.detail, 4000), now, now);
      added.push(pid);
    }
    // New work reopens the task and voting starts over.
    this.db.prepare("UPDATE tasks SET status = 'active' WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM task_votes WHERE task_id = ?").run(id);
    this.event(id, from, "parts_added", `Added ${added.length} part${added.length === 1 ? "" : "s"}.`);
    const items = this.items(id);
    for (const i of items.filter((x) => added.includes(x.id) && x.assignee !== from)) this.tell(i.assignee, id, this.assignmentText(this.task(id)!, i, items));
    return this.view(this.task(id)!);
  }

  /** The part an agent works on: the one named, or its only open part in the task. */
  private partOf(t: TaskRow, from: string, partId?: string): ItemRow {
    const mine = this.items(t.id).filter((i) => i.assignee === from);
    const part = partId ? mine.find((i) => i.id === partId) : (mine.find((i) => i.status !== "done") ?? mine[0]);
    if (!part) throw new TaskError(403, "not_assignee", partId ? `Part ${partId} isn't yours.` : "You have no part in this task.");
    return part;
  }

  update(from: string, id: string, input: Record<string, unknown>): Record<string, unknown> {
    const t = this.task(id);
    if (!t || !this.isParticipant(t, from)) throw new TaskError(404, "not_found");
    if (t.status === "done" || t.status === "cancelled") throw new TaskError(409, "task_closed", `The task is ${t.status}.`);
    const part = this.partOf(t, from, clip(input.part_id, 40) || undefined);
    // A finished part stays finished; a note on it is still recorded.
    const status = part.status === "done" ? "done" : ((["working", "blocked"] as const).find((s) => s === input.status) ?? "working");
    const note = clip(input.note ?? input.progress, 2000);
    this.db.prepare("UPDATE task_items SET status = ?, progress = COALESCE(?, progress), nudges = 0, updated_at = ? WHERE id = ?").run(status, note || null, iso(), part.id);
    this.event(id, from, status, note ? `${part.title}: ${note}` : `${part.title}: ${status}`);
    if (status === "blocked" && part.status !== "done" && t.coordinator !== from) this.tell(t.coordinator, id, `${short(from)} is blocked on "${part.title}": ${note || "no reason given"}. Help them with send_message, or reassign the part with add_parts.`);
    return this.view(this.task(id)!);
  }

  report(from: string, id: string, input: Record<string, unknown>): Record<string, unknown> {
    const t = this.task(id);
    if (!t || !this.isParticipant(t, from)) throw new TaskError(404, "not_found");
    if (t.status === "done" || t.status === "cancelled") throw new TaskError(409, "task_closed", `The task is ${t.status}.`);
    const report = clip(input.report ?? input.text, 20_000);
    if (!report) throw new TaskError(400, "report_required", "Write what you did, what changed and what is left open.");
    const part = this.partOf(t, from, clip(input.part_id, 40) || undefined);
    this.db.prepare("UPDATE task_items SET status = 'done', report = ?, nudges = 0, updated_at = ? WHERE id = ?").run(report, iso(), part.id);
    const items = this.items(id);
    const done = items.filter((i) => i.status === "done").length;
    this.event(id, from, "reported", `Finished "${part.title}" (${done} of ${items.length} parts done).`);
    if (t.coordinator !== from) this.tell(t.coordinator, id, `${short(from)} finished "${part.title}" (${done} of ${items.length} parts done). Report:\n\n${report.slice(0, 1500)}${report.length > 1500 ? "\n\n(Full report in task_status.)" : ""}`);
    if (done === items.length) this.startReview(this.task(id)!, items);
    return this.view(this.task(id)!);
  }

  private startReview(t: TaskRow, items: ItemRow[]): void {
    this.db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(t.id);
    this.db.prepare("DELETE FROM task_votes WHERE task_id = ?").run(t.id);
    this.event(t.id, "relay", "review", "Every part is reported. Waiting for everyone to agree the task is done.");
    for (const p of this.participants(t, items)) {
      this.tell(
        p,
        t.id,
        `Every part of "${t.title}" is reported. Read the reports with task_status, then vote with task_vote: done if the whole task is complete, or not done with what is missing. The task ends when everyone votes done.`,
      );
    }
  }

  vote(from: string, id: string, input: Record<string, unknown>): Record<string, unknown> {
    const t = this.task(id);
    if (!t || !this.isParticipant(t, from)) throw new TaskError(404, "not_found");
    if (t.status !== "review") throw new TaskError(409, "not_in_review", t.status === "active" ? "Parts are still open; vote once every part is reported." : `The task is ${t.status}.`);
    const done = input.done !== false && input.vote !== "not_done";
    const note = clip(input.note, 2000) || null;
    this.db
      .prepare("INSERT INTO task_votes (task_id, address, vote, note, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (task_id, address) DO UPDATE SET vote = excluded.vote, note = excluded.note, at = excluded.at")
      .run(id, from, done ? "done" : "not_done", note, iso());
    this.event(id, from, done ? "voted_done" : "voted_not_done", done ? `Agrees the task is done.${note ? ` ${note}` : ""}` : `Says it isn't done: ${note ?? "no reason given"}`);

    if (!done) {
      this.db.prepare("UPDATE tasks SET status = 'active' WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM task_votes WHERE task_id = ?").run(id);
      if (t.coordinator !== from) this.tell(t.coordinator, id, `${short(from)} says "${t.title}" isn't done: ${note ?? "no reason given"}. Add the missing work with add_parts (or message them), and voting starts again when it is reported.`);
      else for (const i of this.items(id)) if (i.assignee !== from) this.tell(i.assignee, id, `The coordinator says "${t.title}" isn't done yet: ${note ?? "no reason given"}. Wait for new parts, or reply with send_message if you can help.`);
      return this.view(this.task(id)!);
    }

    const items = this.items(id);
    const voters = new Set((this.db.prepare("SELECT address FROM task_votes WHERE task_id = ? AND vote = 'done'").all(id) as { address: string }[]).map((r) => r.address));
    if (this.participants(t, items).every((p) => voters.has(p))) this.finish(this.task(id)!, items);
    return this.view(this.task(id)!);
  }

  private compile(t: TaskRow, items: ItemRow[]): string {
    const lines = [`# ${t.title}`, "", t.goal ? `**Goal:** ${t.goal}` : "", `**Coordinator:** ${short(t.coordinator)} · **Finished:** ${iso()}`, ""];
    for (const i of items) lines.push(`## ${short(i.assignee)}: ${i.title}`, "", i.report ?? "(no report)", "");
    return lines.filter((l, n) => l || lines[n - 1]).join("\n").trim();
  }

  private finish(t: TaskRow, items: ItemRow[]): void {
    const report = this.compile(t, items);
    this.db.prepare("UPDATE tasks SET status = 'done', final_report = ? WHERE id = ?").run(report, t.id);
    this.event(t.id, "relay", "done", "Everyone agreed the task is done. The full report is ready.");
    this.relay.audit("relay", "task.done", t.id, { parts: items.length });
    for (const p of this.participants(t, items)) this.tell(p, t.id, `Everyone agreed "${t.title}" is done. Final report:\n\n${report.slice(0, 6000)}`);
  }

  cancel(id: string, actor: string): boolean {
    const t = this.task(id);
    if (!t || t.status === "done" || t.status === "cancelled") return false;
    this.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(id);
    this.event(id, actor, "cancelled", "The task was stopped.");
    for (const p of this.participants(t)) this.tell(p, id, `"${t.title}" was stopped by ${actor === "admin" ? "the workspace owner" : short(actor)}. Stop working on it.`);
    return true;
  }

  // ------------------------------------------------------------ keeping work moving

  hasActive(): boolean {
    return !!this.db.prepare("SELECT 1 FROM tasks WHERE status IN ('active', 'review') LIMIT 1").get();
  }

  /** Checks in on parts and votes that went quiet. Runs with the relay's sweep. */
  sweep(now = Date.now()): void {
    const tasks = this.db.prepare("SELECT * FROM tasks WHERE status IN ('active', 'review')").all() as TaskRow[];
    for (const t of tasks) {
      const quietMs = this.checkinMs ?? this.permissions(t.session_id ?? "workspace").checkin_minutes * 60_000;
      const cutoff = iso(now - quietMs);
      if (t.status === "active") {
        for (const i of this.items(t.id)) {
          if (i.status === "done" || i.assignee === t.coordinator) continue;
          // An update resets the count, so the clock runs from the update until the first check-in.
          const last = i.nudges > 0 && i.last_nudge_at ? i.last_nudge_at : i.updated_at;
          if (last > cutoff) continue;
          if (i.nudges >= MAX_NUDGES) {
            if (i.status === "blocked") continue;
            this.db.prepare("UPDATE task_items SET status = 'blocked', progress = ?, updated_at = ? WHERE id = ?").run(`No answer after ${MAX_NUDGES} check-ins.`, iso(now), i.id);
            this.event(t.id, "relay", "stalled", `${short(i.assignee)} hasn't answered ${MAX_NUDGES} check-ins on "${i.title}".`);
            this.tell(t.coordinator, t.id, `${short(i.assignee)} hasn't answered ${MAX_NUDGES} check-ins on "${i.title}" (they may be offline). Reassign it with add_parts, or do it yourself.`);
            continue;
          }
          this.db.prepare("UPDATE task_items SET nudges = nudges + 1, last_nudge_at = ? WHERE id = ?").run(iso(now), i.id);
          this.event(t.id, "relay", "checkin", `Checked in with ${short(i.assignee)} on "${i.title}".`);
          this.tell(i.assignee, t.id, `Check-in ${i.nudges + 1} of ${MAX_NUDGES}: "${i.title}" (part_id ${i.id}) has had no update for a while. Post progress with task_update, finish with task_report, or set status blocked and say why.`);
        }
      } else {
        const voted = new Set((this.db.prepare("SELECT address FROM task_votes WHERE task_id = ?").all(t.id) as { address: string }[]).map((r) => r.address));
        const lastNudge = this.db.prepare("SELECT MAX(at) AS at FROM task_events WHERE task_id = ? AND kind IN ('review', 'vote_checkin')").get(t.id) as { at: string | null };
        if ((lastNudge.at ?? "") > cutoff) continue;
        const missing = this.participants(t).filter((p) => !voted.has(p));
        if (!missing.length) continue;
        this.event(t.id, "relay", "vote_checkin", `Waiting for votes from ${missing.map(short).join(", ")}.`);
        for (const p of missing) this.tell(p, t.id, `"${t.title}" is waiting for your vote. Read the reports with task_status, then call task_vote.`);
      }
    }
  }
}

