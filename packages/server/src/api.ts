import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyRequestSignature } from "@a2a/protocol";
import { RELAY_VERSION, type Account, type Relay, type RelayEvent } from "./relay.ts";

const MAX_BODY = 1 << 20;
const SESSION_TTL_S = 24 * 3600;
const RESON8_TOKEN_URL = "https://api.reson8.dev/v1/auth/token";

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  constructor(status: number, code: string, detail?: string) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

interface Ctx {
  req: Request;
  url: URL;
  params: string[];
  body(): Promise<Record<string, unknown>>;
  /** Response status and headers the handler wants on its JSON reply. */
  status: number;
  headers: Headers;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

export interface ApiOptions {
  relay: Relay;
  adminToken: string;
  /** The relay's display name. A function lets a Durable Object show its workspace's current name. */
  name: string | (() => string);
  /** Trust the x-a2a-base header for the public base URL (set by the Cloudflare Worker for workspace relays). */
  trustForwardedBase?: boolean;
  /** Reson8 API key. When set, the console can mint short-lived speech-to-text tokens for the voice desk. */
  reson8ApiKey?: string;
  fetch?: typeof fetch;
}

export interface Api {
  /** Handles API routes. Returns null for anything else, so the caller can serve the console or a 404. */
  handle(req: Request): Promise<Response | null>;
}

const json = (status: number, body: unknown, headers?: Headers): Response => {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * The relay's HTTP API on web-standard Request/Response, shared by the Node server (http.ts)
 * and the Cloudflare Worker. Admin sessions are signed cookies rather than server state, so a
 * Durable Object can hibernate without logging everyone out.
 */
export function createApi(opts: ApiOptions): Api {
  const { relay, adminToken } = opts;
  const doFetch = opts.fetch ?? fetch;
  const routes: { method: string; re: RegExp; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler): void => {
    routes.push({ method, re: new RegExp(`^${path.replace(/:[a-z]+/g, "([^/]+)")}$`), handler });
  };

  // Sessions are signed together with a generation number kept in the database; logging out bumps it, revoking every session.
  const generation = (): number => Number((relay.db.prepare("SELECT value FROM meta WHERE key = 'session_generation'").get() as { value: string } | undefined)?.value ?? 0);
  const revokeSessions = (): void => {
    relay.db.prepare("INSERT INTO meta (key, value) VALUES ('session_generation', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(generation() + 1));
  };
  const sign = (exp: number, gen: number): string => createHmac("sha256", adminToken).update(`a2a-session\n${exp}\n${gen}`).digest("base64url");
  const newSession = (): string => {
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
    const gen = generation();
    return `${exp}.${gen}.${sign(exp, gen)}`;
  };
  const validSession = (value: string | undefined): boolean => {
    if (!value) return false;
    const [expText, genText, mac] = value.split(".");
    const exp = Number(expText);
    const gen = Number(genText);
    return !!mac && Number.isFinite(exp) && exp > Date.now() / 1000 && gen === generation() && safeEqual(mac, sign(exp, gen));
  };

  const isAdmin = (req: Request): boolean => {
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ") && safeEqual(auth.slice(7), adminToken)) return true;
    return validSession(parseCookies(req.headers.get("cookie")).a2a_session);
  };
  const requireAdmin = (ctx: Ctx): void => {
    if (!isAdmin(ctx.req)) throw new HttpError(401, "admin_required");
  };
  const requireAgent = (ctx: Ctx): string => {
    const h = ctx.req.headers;
    const agent = h.get("a2a-agent");
    const ts = h.get("a2a-timestamp");
    const sig = h.get("a2a-signature");
    if (!agent || !ts || !sig) throw new HttpError(401, "agent_auth_required");
    const row = relay.getAgent(agent);
    if (!row || row.status !== "active") throw new HttpError(403, "agent_not_active");
    if (!verifyRequestSignature(row.public_key, ctx.req.method, ctx.url.pathname + ctx.url.search, ts, sig)) throw new HttpError(401, "bad_signature");
    return agent;
  };
  const secureCookie = (url: URL): string => (url.protocol === "https:" ? "; Secure" : "");
  const relayName = (): string => (typeof opts.name === "function" ? opts.name() : opts.name);
  /** Where agents reach this relay: the origin, or origin + /w/<slug> for a workspace behind the Worker. */
  const baseOf = (ctx: Ctx): string => (opts.trustForwardedBase && ctx.req.headers.get("x-a2a-base")) || ctx.url.origin;
  const inviteUrl = (ctx: Ctx, code: string): string => `${baseOf(ctx)}/join/${code}`;
  /** The signed-in person behind a request. Only the Worker sets these headers, after checking their sign-in. */
  const accountOf = (ctx: Ctx): Account | undefined => {
    if (!opts.trustForwardedBase) return undefined;
    const id = ctx.req.headers.get("x-a2a-account-id");
    if (!id) return undefined;
    const h = (k: string): string | null => { const v = ctx.req.headers.get(k); return v ? decodeURIComponent(v) : null; };
    return { id, email: h("x-a2a-account-email"), name: h("x-a2a-account-name"), role: ctx.req.headers.get("x-a2a-account-role") === "owner" ? "owner" : "member" };
  };

  // ------------------------------------------------------------ public + agent API
  route("GET", "/healthz", () => ({ ok: true }));
  route("GET", "/v1/relay", () => ({
    name: relayName(),
    version: RELAY_VERSION,
    org: relay.policy.org,
    relay_public_key: relay.relayPublicKey,
    policy_version: relay.policyVersion,
    registration: relay.policy.registration,
    judge: relay.judgeInfo(),
  }));
  route("POST", "/v1/register", async (ctx) => {
    const r = relay.register(await ctx.body(), isAdmin(ctx.req), accountOf(ctx));
    ctx.status = r.status;
    return r.body;
  });
  route("GET", "/v1/invites/:code", (ctx) => ({ ...relay.inviteInfo(decodeURIComponent(ctx.params[0]!)), relay: relayName(), server: baseOf(ctx) }));
  route("POST", "/v1/messages", async (ctx) => {
    const r = relay.submit(await ctx.body());
    ctx.status = r.status;
    return r.body;
  });
  route("GET", "/v1/messages/:id", (ctx) => {
    const agent = requireAgent(ctx);
    const s = relay.messageStatusFor(agent, decodeURIComponent(ctx.params[0]!));
    if (!s) throw new HttpError(404, "not_found");
    return s;
  });
  route("GET", "/v1/threads/:id", (ctx) => {
    const agent = requireAgent(ctx);
    const t = relay.threadFor(agent, decodeURIComponent(ctx.params[0]!));
    if (!t) throw new HttpError(404, "not_found");
    return t;
  });
  route("GET", "/v1/directory", (ctx) => ({ agents: relay.directory(requireAgent(ctx)) }));
  route("GET", "/v1/sessions", (ctx) => ({ sessions: relay.sessionsFor(requireAgent(ctx)) }));
  route("PUT", "/v1/sessions/:id/brief", async (ctx) => {
    const agent = requireAgent(ctx);
    const { text } = await ctx.body();
    if (typeof text !== "string") throw new HttpError(400, "text_required");
    if (!relay.agentSetBrief(agent, decodeURIComponent(ctx.params[0]!), text)) throw new HttpError(404, "not_found");
    return { ok: true };
  });
  route("GET", "/v1/keys/:address", (ctx) => {
    requireAgent(ctx);
    const k = relay.agentKey(decodeURIComponent(ctx.params[0]!));
    if (!k) throw new HttpError(404, "not_found");
    return k;
  });

  // ------------------------------------------------------------ admin API
  route("POST", "/v1/admin/login", async (ctx) => {
    const { token } = await ctx.body();
    if (typeof token !== "string" || !safeEqual(token, adminToken)) throw new HttpError(401, "invalid_token");
    ctx.headers.append("set-cookie", `a2a_session=${newSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}${secureCookie(ctx.url)}`);
    relay.audit("admin", "admin.login", null);
    return { ok: true };
  });
  route("POST", "/v1/admin/logout", (ctx) => {
    if (isAdmin(ctx.req)) revokeSessions();
    ctx.headers.append("set-cookie", `a2a_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie(ctx.url)}`);
    return { ok: true };
  });
  route("GET", "/v1/admin/session", (ctx) => ({ admin: isAdmin(ctx.req) }));
  route("GET", "/v1/admin/overview", (ctx) => {
    requireAdmin(ctx);
    return {
      relay: {
        name: relayName(),
        version: RELAY_VERSION,
        org: relay.policy.org,
        policy_version: relay.policyVersion,
        registration: relay.policy.registration,
        isolation: relay.policy.isolation,
        judge: relay.judgeInfo(),
        console_address: relay.consoleAddress,
        voice: { reson8: !!opts.reson8ApiKey },
        url: baseOf(ctx),
      },
      stats: relay.stats(),
    };
  });
  route("GET", "/v1/admin/messages", (ctx) => {
    requireAdmin(ctx);
    const q = ctx.url.searchParams;
    return { messages: relay.listMessages({ state: q.get("state") ?? undefined, before: q.get("before") ?? undefined, agent: q.get("agent") ?? undefined, limit: Number(q.get("limit") ?? 100) }) };
  });
  route("GET", "/v1/admin/messages/:id", (ctx) => {
    requireAdmin(ctx);
    const d = relay.messageDetail(decodeURIComponent(ctx.params[0]!), "admin");
    if (!d) throw new HttpError(404, "not_found");
    return d;
  });
  route("POST", "/v1/admin/messages/:id/review", async (ctx) => {
    requireAdmin(ctx);
    const { decision, note } = await ctx.body();
    if (decision !== "release" && decision !== "reject") throw new HttpError(400, "invalid_decision", "decision must be release or reject");
    const r = relay.review(decodeURIComponent(ctx.params[0]!), decision, "admin", typeof note === "string" ? note.slice(0, 500) : undefined);
    ctx.status = r.status;
    return r.body;
  });
  route("GET", "/v1/admin/threads/:id", (ctx) => {
    requireAdmin(ctx);
    const t = relay.threadDetail(decodeURIComponent(ctx.params[0]!));
    if (!t) throw new HttpError(404, "not_found");
    return t;
  });
  route("GET", "/v1/admin/agents", (ctx) => {
    requireAdmin(ctx);
    return { agents: relay.listAgents() };
  });
  route("POST", "/v1/admin/agents/:address/:action", (ctx) => {
    requireAdmin(ctx);
    const action = ctx.params[1];
    if (action !== "approve" && action !== "disable" && action !== "enable") throw new HttpError(404, "not_found");
    if (!relay.setAgentStatus(decodeURIComponent(ctx.params[0]!), action === "disable" ? "disabled" : "active", "admin")) throw new HttpError(404, "not_found");
    return { ok: true };
  });
  route("GET", "/v1/admin/policy", (ctx) => {
    requireAdmin(ctx);
    const versions = relay.db.prepare("SELECT version, created_by, created_at, note FROM policies ORDER BY version DESC LIMIT 50").all();
    const current = relay.db.prepare("SELECT yaml FROM policies WHERE version = ?").get(relay.policyVersion) as { yaml: string };
    return {
      version: relay.policyVersion,
      yaml: current.yaml,
      versions,
      registration: relay.policy.registration,
      scopes: relay.policy.scopes,
      links: relay.policy.links.map((l) => ({ from: l.from, to: l.to, scopes: l.scopes, rate: l.rate?.text ?? null })),
      rules: relay.policy.rules,
      limits: relay.policy.limits,
      guard: relay.policy.guard,
      org: relay.policy.org,
    };
  });
  route("PUT", "/v1/admin/policy", async (ctx) => {
    requireAdmin(ctx);
    const { yaml, note } = await ctx.body();
    if (typeof yaml !== "string") throw new HttpError(400, "invalid_request", "yaml is required");
    const r = relay.setPolicy(yaml, "admin", typeof note === "string" ? note.slice(0, 200) : undefined);
    if (!r.ok) {
      ctx.status = 422;
      return { error: "invalid_policy", errors: r.errors };
    }
    return { ok: true, version: r.version };
  });
  route("POST", "/v1/admin/screen", async (ctx) => {
    requireAdmin(ctx);
    const b = await ctx.body();
    for (const k of ["from", "to", "scope", "text"]) if (typeof b[k] !== "string") throw new HttpError(400, "invalid_request", `${k} is required`);
    relay.audit("admin", "guard.dry_run", null, { from: b.from, to: b.to, scope: b.scope });
    return relay.dryRun(b as { from: string; to: string; scope: string; text: string; kind?: string });
  });
  route("GET", "/v1/admin/audit", (ctx) => {
    requireAdmin(ctx);
    return { events: relay.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 200").all() };
  });

  // Invites: a link that lets one person (or a few) join without the admin token.
  route("GET", "/v1/admin/invites", (ctx) => {
    requireAdmin(ctx);
    return { invites: relay.listInvites().map((i) => ({ ...i, url: inviteUrl(ctx, i.code) })) };
  });
  route("POST", "/v1/admin/invites", async (ctx) => {
    requireAdmin(ctx);
    let invite;
    try {
      invite = relay.createInvite(await ctx.body(), "admin");
    } catch {
      throw new HttpError(404, "unknown_session");
    }
    ctx.status = 201;
    return { ...invite, url: inviteUrl(ctx, invite.code) };
  });

  // Sessions: private lines between the owner's agents and the people invited into each one.
  route("GET", "/v1/admin/sessions", (ctx) => {
    requireAdmin(ctx);
    const account = ctx.url.searchParams.get("account");
    return { sessions: relay.listSessions(account ? { account } : undefined) };
  });
  route("POST", "/v1/admin/sessions", async (ctx) => {
    requireAdmin(ctx);
    const b = await ctx.body();
    const session = relay.createSession(b, "admin");
    // One link for the whole session: it lets in as many people as there is room for.
    const invite = relay.createInvite({ session_id: session.id, note: session.name, max_uses: session.max_members, ttl_hours: b.ttl_hours ?? 24 * 14 }, "admin");
    ctx.status = 201;
    return { ...session, invite: { ...invite, url: inviteUrl(ctx, invite.code) } };
  });
  route("GET", "/v1/admin/sessions/:id", (ctx) => {
    requireAdmin(ctx);
    const id = decodeURIComponent(ctx.params[0]!);
    const account = ctx.url.searchParams.get("account");
    // A guest's view (through the Worker, for a signed-in member): the conversation, without invites.
    if (account && !relay.accountInSession(account, id)) throw new HttpError(404, "not_found");
    const d = relay.sessionDetail(id, account ?? undefined);
    if (!d) throw new HttpError(404, "not_found");
    if (account) return { ...d, invites: [], members: (d.members as Record<string, unknown>[]).map(({ email: _e, ...m }) => m) };
    return { ...d, invites: (d.invites as { code: string }[]).map((i) => ({ ...i, url: inviteUrl(ctx, i.code) })) };
  });
  route("DELETE", "/v1/admin/sessions/:id", (ctx) => {
    requireAdmin(ctx);
    if (!relay.deleteSession(decodeURIComponent(ctx.params[0]!), "admin")) throw new HttpError(404, "not_found");
    return { ok: true };
  });
  route("PATCH", "/v1/admin/sessions/:id", async (ctx) => {
    requireAdmin(ctx);
    if (!relay.updateSession(decodeURIComponent(ctx.params[0]!), await ctx.body(), "admin")) throw new HttpError(404, "not_found");
    return relay.sessionDetail(decodeURIComponent(ctx.params[0]!));
  });
  route("POST", "/v1/admin/sessions/:id/invites", async (ctx) => {
    requireAdmin(ctx);
    const b = await ctx.body();
    let invite;
    try {
      invite = relay.createInvite({ ...b, session_id: decodeURIComponent(ctx.params[0]!) }, "admin");
    } catch {
      throw new HttpError(404, "not_found");
    }
    ctx.status = 201;
    return { ...invite, url: inviteUrl(ctx, invite.code) };
  });
  route("DELETE", "/v1/admin/sessions/:id/members/:address", (ctx) => {
    requireAdmin(ctx);
    if (!relay.removeSessionMember(decodeURIComponent(ctx.params[0]!), decodeURIComponent(ctx.params[1]!), "admin")) throw new HttpError(404, "not_found");
    return { ok: true };
  });
  route("DELETE", "/v1/admin/sessions/:id/accounts/:account", (ctx) => {
    requireAdmin(ctx);
    if (!relay.removeAccountFromSession(decodeURIComponent(ctx.params[0]!), decodeURIComponent(ctx.params[1]!), "admin")) throw new HttpError(404, "not_found");
    return { ok: true };
  });
  route("DELETE", "/v1/admin/invites/:code", (ctx) => {
    requireAdmin(ctx);
    if (!relay.revokeInvite(decodeURIComponent(ctx.params[0]!), "admin")) throw new HttpError(404, "not_found");
    return { ok: true };
  });

  // Console: the admin talks to agents (typed or by voice) as the relay's own agent.
  route("POST", "/v1/admin/console/send", async (ctx) => {
    requireAdmin(ctx);
    const r = relay.consoleSend(await ctx.body(), "admin");
    ctx.status = r.status;
    return r.body;
  });
  route("GET", "/v1/admin/console/messages", (ctx) => {
    requireAdmin(ctx);
    return { address: relay.consoleAddress, messages: relay.listMessages({ agent: relay.consoleAddress, limit: 200 }) };
  });

  // Voice: Reson8 speech-to-text. The API key stays here; the browser gets a 10-minute token.
  route("POST", "/v1/voice/token", async (ctx) => {
    requireAdmin(ctx);
    if (!opts.reson8ApiKey) throw new HttpError(503, "voice_not_configured", "set the RESON8_API_KEY secret to enable Reson8 voice");
    const res = await doFetch(RESON8_TOKEN_URL, { method: "POST", headers: { authorization: `ApiKey ${opts.reson8ApiKey}` } });
    if (!res.ok) throw new HttpError(502, "voice_token_failed", `Reson8 answered ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    return { access_token: body.access_token, expires_in: body.expires_in ?? 600, provider: "reson8" };
  });

  route("GET", "/v1/admin/events", (ctx) => {
    requireAdmin(ctx);
    const encoder = new TextEncoder();
    let cleanup = (): void => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (s: string): void => {
          try {
            controller.enqueue(encoder.encode(s));
          } catch {
            cleanup();
          }
        };
        write("retry: 2000\n\n");
        const onEvent = (e: RelayEvent): void => write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
        relay.on("event", onEvent);
        const ping = setInterval(() => write(": ping\n\n"), 20_000);
        // End every stream after a minute; the browser reconnects on its own. An endless stream would keep
        // a Durable Object on its old code after a deploy, because Cloudflare lets in-flight work finish first.
        const end = setTimeout(() => {
          cleanup();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }, 55_000);
        cleanup = () => {
          clearInterval(ping);
          clearTimeout(end);
          relay.off("event", onEvent);
        };
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
  });

  async function readBody(req: Request): Promise<Record<string, unknown>> {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY) throw new HttpError(413, "too_large");
    const text = await req.text();
    if (text.length > MAX_BODY) throw new HttpError(413, "too_large");
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new HttpError(400, "invalid_json");
    }
  }

  return {
    async handle(req: Request): Promise<Response | null> {
      const url = new URL(req.url);
      let cachedBody: Promise<Record<string, unknown>> | undefined;
      try {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const ctx: Ctx = { req, url, params: m.slice(1), body: () => (cachedBody ??= readBody(req)), status: 200, headers: new Headers() };
          const out = await r.handler(ctx);
          if (out instanceof Response) return out;
          return json(ctx.status, out, ctx.headers);
        }
        return null;
      } catch (err) {
        if (err instanceof HttpError) return json(err.status, { error: err.code, detail: err.detail });
        console.error(err);
        return json(500, { error: "internal_error" });
      }
    },
  };
}
