import type { KeyObject } from "node:crypto";
import { hostname } from "node:os";
import { publicKeyFromPrivate, registerSigningString, signRequestHeaders, signString } from "@a2a/protocol";

export class RelayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = status;
    this.code = code;
  }
}

async function request(server: string, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(server + path, {
    method,
    headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: "invalid_response", detail: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

export async function relayInfo(server: string): Promise<{ org: string; relay_public_key: string; name: string; policy_version: number; judge: unknown }> {
  const r = await request(server, "GET", "/v1/relay");
  if (r.status !== 200) throw new RelayError(r.status, String(r.body.error ?? "relay_unreachable"));
  return r.body as never;
}

export async function registerAgent(
  server: string,
  address: string,
  key: KeyObject | string,
  extra: { display_name?: string; description?: string; adminToken?: string; invite?: string },
): Promise<{ status: string }> {
  const pem = typeof key === "string" ? key : key.export({ type: "pkcs8", format: "pem" }).toString();
  const public_key = publicKeyFromPrivate(pem);
  const timestamp = new Date().toISOString();
  const r = await request(server, "POST", "/v1/register", {
    body: { address, public_key, timestamp, proof: signString(registerSigningString(address, public_key, timestamp), pem), display_name: extra.display_name, description: extra.description, host: hostname(), invite: extra.invite },
    headers: extra.adminToken ? { authorization: `Bearer ${extra.adminToken}` } : {},
  });
  if (r.status !== 200 && r.status !== 201) throw new RelayError(r.status, String(r.body.error), r.body.detail as string | undefined);
  return { status: String(r.body.status) };
}

export async function submitEnvelope(server: string, envelope: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return request(server, "POST", "/v1/messages", { body: envelope });
}

export async function signedGet(server: string, agent: string, key: KeyObject, path: string): Promise<Record<string, unknown>> {
  const r = await request(server, "GET", path, { headers: signRequestHeaders(agent, key, "GET", path) });
  if (r.status !== 200) throw new RelayError(r.status, String(r.body.error ?? "request_failed"), r.body.detail as string | undefined);
  return r.body;
}

export async function inviteInfo(server: string, code: string): Promise<{ valid: boolean; org: string; relay: string; note: string | null; expires_at: string | null }> {
  const r = await request(server, "GET", `/v1/invites/${encodeURIComponent(code)}`);
  if (r.status !== 200) throw new RelayError(r.status, String(r.body.error ?? "invite_lookup_failed"));
  return r.body as never;
}
