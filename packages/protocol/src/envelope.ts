import type { KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.ts";
import { signString, verifyString } from "./crypto.ts";

export const PROTOCOL_VERSION = 1;

export type MessageKind = "request" | "reply" | "notify";

export interface Attachment {
  name: string;
  mime: string;
  /** Inline content, base64. Kept small: the relay enforces max_body_bytes on the whole envelope. */
  data: string;
}

export interface Envelope {
  v: number;
  id: string;
  thread_id: string;
  in_reply_to: string | null;
  from: string;
  to: string;
  scope: string;
  kind: MessageKind;
  body: { text: string; attachments?: Attachment[] };
  expects_reply: boolean;
  created_at: string;
  /** "ed25519:<base64>" over the canonical JSON of every other field. */
  sig: string;
}

export type UnsignedEnvelope = Omit<Envelope, "sig">;

/** Lifecycle states of a message on the relay. */
export type MessageState =
  | "received"
  | "screening"
  | "held"
  | "queued"
  | "delivered"
  | "blocked"
  | "rejected"
  | "expired";

export const TERMINAL_STATES: ReadonlySet<MessageState> = new Set(["delivered", "blocked", "rejected", "expired"]);

export type Decision = "allow" | "redact" | "hold" | "block";

const SEVERITY: Record<Decision, number> = { allow: 0, redact: 1, hold: 2, block: 3 };

/** The stricter of two decisions. The guard only ever moves decisions this way. */
export function stricter(a: Decision, b: Decision): Decision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export const severityOf = (d: Decision): number => SEVERITY[d];

export const ADDRESS_RE = /^agent:\/\/[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62}$/;
const ID_RE = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/;
const THREAD_RE = /^thr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const orgOf = (address: string): string => address.slice("agent://".length).split("/")[0] ?? "";

export function signingPayload(env: UnsignedEnvelope | Envelope): string {
  const { sig: _sig, ...rest } = env as Envelope;
  return canonicalize(rest);
}

export function signEnvelope(env: UnsignedEnvelope, privateKey: KeyObject | string): Envelope {
  return { ...env, sig: `ed25519:${signString(signingPayload(env), privateKey)}` };
}

export function verifyEnvelope(env: Envelope, publicKeyB64: string): boolean {
  if (typeof env.sig !== "string" || !env.sig.startsWith("ed25519:")) return false;
  return verifyString(signingPayload(env), env.sig.slice("ed25519:".length), publicKeyB64);
}

/** Structural validation. Returns an error string, or null when the envelope is well formed. */
export function validateEnvelope(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "envelope must be an object";
  const e = input as Record<string, unknown>;
  const allowed = new Set(["v", "id", "thread_id", "in_reply_to", "from", "to", "scope", "kind", "body", "expects_reply", "created_at", "sig"]);
  for (const k of Object.keys(e)) if (!allowed.has(k)) return `unknown field: ${k}`;
  if (e.v !== PROTOCOL_VERSION) return `unsupported protocol version: ${String(e.v)}`;
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) return "id must be msg_<ULID>";
  if (typeof e.thread_id !== "string" || !THREAD_RE.test(e.thread_id)) return "thread_id must be thr_<ULID>";
  if (e.in_reply_to !== null && (typeof e.in_reply_to !== "string" || !ID_RE.test(e.in_reply_to))) return "in_reply_to must be null or a message id";
  if (typeof e.from !== "string" || !ADDRESS_RE.test(e.from)) return "from must be agent://<org>/<name>";
  if (typeof e.to !== "string" || !ADDRESS_RE.test(e.to)) return "to must be agent://<org>/<name>";
  if (e.from === e.to) return "an agent cannot message itself";
  if (typeof e.scope !== "string" || !SCOPE_RE.test(e.scope)) return "scope must be a lowercase slug";
  if (e.kind !== "request" && e.kind !== "reply" && e.kind !== "notify") return "kind must be request, reply or notify";
  if (e.kind === "reply" && e.in_reply_to === null) return "a reply needs in_reply_to";
  if (typeof e.expects_reply !== "boolean") return "expects_reply must be a boolean";
  if (typeof e.created_at !== "string" || Number.isNaN(Date.parse(e.created_at))) return "created_at must be an ISO timestamp";
  if (typeof e.sig !== "string") return "sig is required";
  const body = e.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") return "body must be an object";
  for (const k of Object.keys(body)) if (k !== "text" && k !== "attachments") return `unknown body field: ${k}`;
  if (typeof body.text !== "string") return "body.text must be a string";
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments)) return "body.attachments must be an array";
    for (const a of body.attachments as unknown[]) {
      const att = a as Record<string, unknown>;
      if (!att || typeof att.name !== "string" || typeof att.mime !== "string" || typeof att.data !== "string") {
        return "each attachment needs name, mime and data (base64)";
      }
    }
  }
  return null;
}
