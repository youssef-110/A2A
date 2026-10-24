import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize as normalizePath, sep } from "node:path";
import { verifyRequestSignature } from "@a2a/protocol";
import { RELAY_VERSION, type Relay, type RelayEvent } from "./relay.ts";
import type { Hub } from "./hub.ts";

const MAX_BODY = 1 << 20;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

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
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body(): Promise<Record<string, unknown>>;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface HttpOptions {
  relay: Relay;
  hub: Hub;
  adminToken: string;
  consoleDir: string;
  name: string;
}

export function createRelayServer(opts: HttpOptions): Server {
  const { relay, hub, adminToken, consoleDir } = opts;
  const sessions = new Set<string>();
  const routes: { method: string; re: RegExp; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler): void => {
    routes.push({ method, re: new RegExp(`^${path.replace(/:[a-z]+/g, "([^/]+)")}$`), handler });
  };

  const isAdmin = (req: IncomingMessage): boolean => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && safeEqual(auth.slice(7), adminToken)) return true;
    const sid = parseCookies(req.headers.cookie).a2a_session;
    return !!sid && sessions.has(sid);
  };
  const requireAdmin = (ctx: Ctx): void => {
    if (!isAdmin(ctx.req)) throw new HttpError(401, "admin_required");
  };
  const requireAgent = (ctx: Ctx): string => {
    const h = ctx.req.headers;
    const agent = h["a2a-agent"];
    const ts = h["a2a-timestamp"];
    const sig = h["a2a-signature"];
    if (typeof agent !== "string" || typeof ts !== "string" || typeof sig !== "string") throw new HttpError(401, "agent_auth_required");
    const row = relay.getAgent(agent);
    if (!row || row.status !== "active") throw new HttpError(403, "agent_not_active");
    if (!verifyRequestSignature(row.public_key, ctx.req.method ?? "GET", ctx.url.pathname + ctx.url.search, ts, sig)) throw new HttpError(401, "bad_signature");
    return agent;
  };

  // ------------------------------------------------------------ public + agent API
  route("GET", "/healthz", () => ({ ok: true }));
  route("GET", "/v1/relay", () => ({
    name: opts.name,
    version: RELAY_VERSION,
    org: relay.policy.org,
    relay_public_key: relay.relayPublicKey,
    policy_version: relay.policyVersion,
    judge: relay.judgeInfo(),
  }));
  route("POST", "/v1/register", async (ctx) => {
    const r = relay.register(await ctx.body(), isAdmin(ctx.req));
    ctx.res.statusCode = r.status;
    return r.body;
  });
  route("POST", "/v1/messages", async (ctx) => {
    const r = relay.submit(await ctx.body());
    ctx.res.statusCode = r.status;
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
    const sid = randomBytes(24).toString("base64url");
    sessions.add(sid);
    ctx.res.setHeader("set-cookie", `a2a_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    relay.audit("admin", "admin.login", null);
    return { ok: true };
  });
  route("POST", "/v1/admin/logout", (ctx) => {
    const sid = parseCookies(ctx.req.headers.cookie).a2a_session;
    if (sid) sessions.delete(sid);
    ctx.res.setHeader("set-cookie", "a2a_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return { ok: true };
  });
  route("GET", "/v1/admin/session", (ctx) => ({ admin: isAdmin(ctx.req) }));
  route("GET", "/v1/admin/overview", (ctx) => {
    requireAdmin(ctx);
    return { relay: { name: opts.name, version: RELAY_VERSION, org: relay.policy.org, policy_version: relay.policyVersion, judge: relay.judgeInfo() }, stats: relay.stats() };
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
    ctx.res.statusCode = r.status;
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
    return { version: relay.policyVersion, yaml: current.yaml, versions, scopes: relay.policy.scopes, links: relay.policy.links.map((l) => ({ from: l.from, to: l.to, scopes: l.scopes, rate: l.rate?.text ?? null })) };
  });
  route("PUT", "/v1/admin/policy", async (ctx) => {
    requireAdmin(ctx);
    const { yaml, note } = await ctx.body();
    if (typeof yaml !== "string") throw new HttpError(400, "invalid_request", "yaml is required");
    const r = relay.setPolicy(yaml, "admin", typeof note === "string" ? note.slice(0, 200) : undefined);
    if (!r.ok) {
      ctx.res.statusCode = 422;
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
  route("GET", "/v1/admin/events", (ctx) => {
    requireAdmin(ctx);
    const { req, res } = ctx;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    const onEvent = (e: RelayEvent): void => {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };
    relay.on("event", onEvent);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(ping);
      relay.off("event", onEvent);
    });
    return STREAMING;
  });

  const STREAMING = Symbol("streaming");

  async function serveStatic(url: URL, res: ServerResponse): Promise<boolean> {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = normalizePath(join(consoleDir, rel));
    if (!file.startsWith(consoleDir + sep) && file !== join(consoleDir, "index.html")) return false;
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    let cachedBody: Promise<Record<string, unknown>> | undefined;
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const out = await r.handler({ req, res, url, params: m.slice(1), body: () => (cachedBody ??= readBody(req)) });
        if (out === STREAMING) return;
        sendJson(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out);
        return;
      }
      if (req.method === "GET" && !url.pathname.startsWith("/v1/") && (await serveStatic(url, res))) return;
      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.code, detail: err.detail });
      else {
        console.error(err);
        sendJson(res, 500, { error: "internal_error" });
      }
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    if (url.pathname !== "/v1/stream") {
      socket.destroy();
      return;
    }
    hub.wss.handleUpgrade(req, socket, head, (ws) => hub.wss.emit("connection", ws, req));
  });

  return server;
}
