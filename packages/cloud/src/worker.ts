import type { Env } from "./relay-do.ts";
import {
  createSession,
  createWorkspace,
  currentUser,
  endSession,
  googleEnabled,
  googleFinish,
  googleStart,
  recordFailure,
  signIn,
  signUp,
  tooManyFailures,
  workspaceBySlug,
  workspacesFor,
} from "./accounts.ts";

export { RelayDO } from "./relay-do.ts";

/**
 * The A2A website and relays on one Worker:
 *   /                     landing page          /docs        SDK and plug-in docs
 *   /signin, /signup      accounts              /app/*       dashboard (signed in)
 *   /auth/*               sign-in endpoints     /api/*       account + workspace admin API
 *   /w/<slug>/v1/*        a workspace relay (agents)        /w/<slug>/join/<code>  invite page
 *   /v1/*, /join/<code>   the original single relay (agent://acme)
 */

const PAGES: Record<string, string> = {
  "/": "/index.html",
  "/docs": "/docs.html",
  "/signin": "/signin.html",
  "/signup": "/signin.html",
};

const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const asset = (env: Env, req: Request, path: string): Promise<Response> => env.ASSETS.fetch(new Request(new URL(path, req.url), req));

/** Forwards to a relay Durable Object with the workspace prefix removed, so agents' signed paths match. */
function toRelay(env: Env, req: Request, doName: string, path: string, extra: Record<string, string> = {}, admin = false): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL(path + url.search, url.origin);
  const headers = new Headers(req.headers);
  for (const k of [...headers.keys()]) if (k.startsWith("x-a2a-")) headers.delete(k);
  headers.delete("cookie");
  if (admin) headers.set("authorization", `Bearer ${env.A2A_ADMIN_TOKEN ?? ""}`);
  else headers.delete("authorization");
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  const init: RequestInit = { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body };
  return env.RELAY.get(env.RELAY.idFromName(doName)).fetch(new Request(target, init));
}

function workspaceHeaders(url: URL, ws: { slug: string; name: string; do_name: string }): Record<string, string> {
  // The original relay keeps its root address and its own org.
  if (ws.do_name === "relay") return { "x-a2a-base": url.origin, "x-a2a-name": ws.name };
  return { "x-a2a-base": `${url.origin}/w/${ws.slug}`, "x-a2a-org": ws.slug, "x-a2a-name": ws.name };
}

async function handleAuth(env: Env, req: Request, url: URL): Promise<Response> {
  const secure = url.protocol === "https:";
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  if (url.pathname === "/auth/signup" && req.method === "POST") {
    if (await tooManyFailures(env, [`ip:${ip}`])) return json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
    const r = await signUp(env, await readJson(req));
    if ("error" in r) {
      await recordFailure(env, [`ip:${ip}`]);
      return json({ error: r.error }, 400);
    }
    return json({ ok: true }, 201, { "set-cookie": await createSession(env, r.id, secure) });
  }
  if (url.pathname === "/auth/signin" && req.method === "POST") {
    const body = await readJson(req);
    const keys = [`ip:${ip}`, `email:${String(body.email ?? "").trim().toLowerCase()}`];
    if (await tooManyFailures(env, keys)) return json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
    const user = await signIn(env, body);
    if (!user) {
      await recordFailure(env, keys);
      return json({ error: "That email and password don't match an account." }, 401);
    }
    return json({ ok: true }, 200, { "set-cookie": await createSession(env, user.id, secure) });
  }
  if (url.pathname === "/auth/signout" && req.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": await endSession(env, req, secure) });
  }
  if (url.pathname === "/auth/google-status") return json({ enabled: googleEnabled(env) });
  if (url.pathname === "/auth/google") {
    if (!googleEnabled(env)) return Response.redirect(`${url.origin}/signin?error=google_unavailable`, 302);
    return googleStart(env, url, url.searchParams.get("next") ?? "/app");
  }
  if (url.pathname === "/auth/google/callback") {
    const r = await googleFinish(env, req, url);
    if ("error" in r) return Response.redirect(`${url.origin}/signin?error=${encodeURIComponent(r.error)}`, 302);
    const headers = new Headers({ location: `${url.origin}${r.next}` });
    headers.append("set-cookie", await createSession(env, r.user.id, secure));
    headers.append("set-cookie", "a2a_oauth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return new Response(null, { status: 302, headers });
  }
  return json({ error: "not_found" }, 404);
}

async function handleApi(env: Env, req: Request, url: URL): Promise<Response> {
  const user = await currentUser(env, req);
  if (!user) return json({ error: "signed_out" }, 401);
  const workspaces = await workspacesFor(env, user.id);

  if (url.pathname === "/api/me") {
    return json({ user, workspaces: workspaces.map(({ slug, name, role }) => ({ slug, name, role, url: `${url.origin}/w/${slug}` })), google: googleEnabled(env) });
  }
  if (url.pathname === "/api/workspaces" && req.method === "POST") {
    const body = await readJson(req);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "New workspace";
    const ws = await createWorkspace(env, user.id, name);
    return json({ slug: ws.slug, name: ws.name, role: ws.role }, 201);
  }

  // /api/w/<slug>/v1/... : the workspace's relay admin API, for members only.
  const m = /^\/api\/w\/([a-z0-9-]+)(\/v1\/.*)$/.exec(url.pathname);
  if (m) {
    const ws = workspaces.find((w) => w.slug === m[1]);
    if (!ws) return json({ error: "not_found" }, 404);
    if (m[2] === "/v1/admin/workspace" && req.method === "PATCH") {
      const body = await readJson(req);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
      if (!name) return json({ error: "A workspace needs a name." }, 400);
      await env.ACCOUNTS.prepare("UPDATE workspaces SET name = ? WHERE id = ?").bind(name, ws.id).run();
      return json({ ok: true, name });
    }
    return toRelay(env, req, ws.do_name, m[2]!, workspaceHeaders(url, ws), true);
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p.startsWith("/auth/")) return handleAuth(env, req, url);
    if (p.startsWith("/api/")) return handleApi(env, req, url);

    // Workspace relays: agents only. Admin and voice go through /api with a signed-in member.
    const w = /^\/w\/([a-z0-9-]+)(\/.*)$/.exec(p);
    if (w) {
      const [, slug, rest] = w;
      if (rest!.startsWith("/join/")) return asset(env, req, "/join.html");
      if (!rest!.startsWith("/v1/") || rest!.startsWith("/v1/admin/") || rest!.startsWith("/v1/voice/")) return json({ error: "not_found" }, 404);
      const ws = await workspaceBySlug(env, slug!);
      if (!ws) return json({ error: "unknown_workspace" }, 404);
      return toRelay(env, req, ws.do_name, rest!, workspaceHeaders(url, ws));
    }

    // The original relay at the root, unchanged for agents already connected to it.
    if (p.startsWith("/v1/") || p === "/healthz") {
      // Internal x-a2a-* headers are the Worker's to set; drop any a client sent.
      const headers = new Headers(req.headers);
      for (const k of [...headers.keys()]) if (k.startsWith("x-a2a-")) headers.delete(k);
      return env.RELAY.get(env.RELAY.idFromName("relay")).fetch(new Request(req, { headers }));
    }
    if (p.startsWith("/join/")) return asset(env, req, "/join.html");

    if (p === "/app" || p.startsWith("/app/")) {
      if (!(await currentUser(env, req))) return Response.redirect(`${url.origin}/signin?next=${encodeURIComponent(p)}`, 302);
      return asset(env, req, "/app.html");
    }
    if (PAGES[p]) return asset(env, req, PAGES[p]!);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
