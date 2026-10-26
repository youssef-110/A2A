import type { Env } from "./relay-do.ts";
import {
  createSession,
  createWorkspace,
  currentUser,
  decideDeviceLink,
  deviceLinkByCode,
  endSession,
  GOOGLE_CALLBACK,
  googleEnabled,
  googleFinish,
  googleStart,
  guestWorkspaces,
  pollDeviceLink,
  recordFailure,
  recordGuestWorkspace,
  signIn,
  signUp,
  startDeviceLink,
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
 *   /link                 approve a desktop app sign-in         /download/<os>  desktop app installers
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

/**
 * An agent registering with the a2a CLI's sign-in token: the relay learns which person it belongs to.
 * The workspace's owner gets owner agents; anyone else joins as a guest and sees it under "Shared with you".
 */
async function registerAsAccount(env: Env, req: Request, url: URL, ws: { id: string; slug: string; name: string; do_name: string }): Promise<Response> {
  const user = await currentUser(env, req);
  if (!user) return json({ error: "signed_out", detail: "Your sign-in on this computer expired. Run `a2a login` and try again." }, 401);
  const owner = (await workspacesFor(env, user.id)).some((w) => w.id === ws.id);
  const res = await toRelay(env, req, ws.do_name, "/v1/register", {
    ...workspaceHeaders(url, ws),
    "x-a2a-account-id": user.id,
    "x-a2a-account-email": encodeURIComponent(user.email),
    "x-a2a-account-name": encodeURIComponent(user.name ?? user.email.split("@")[0]!),
    "x-a2a-account-role": owner ? "owner" : "member",
  });
  if (res.ok && !owner) await recordGuestWorkspace(env, user.id, ws.id);
  return res;
}

/** Sessions other people invited this person into: read-only, and only the sessions they are in. */
async function handleShared(env: Env, req: Request, url: URL, userId: string): Promise<Response> {
  const spaces = await guestWorkspaces(env, userId);
  // toRelay appends the request's query to the path it is given, so pass the path without it.
  const admin = (ws: (typeof spaces)[number], path: string, method = "GET"): Promise<Response> =>
    toRelay(env, new Request(new URL(path, url.origin), { method }), ws.do_name, path.split("?")[0]!, workspaceHeaders(url, ws), true);
  const noEmails = (people: Record<string, unknown>[] = []) => people.map(({ email: _e, ...p }) => p);

  if (url.pathname === "/api/shared" && req.method === "GET") {
    const out = await Promise.all(
      spaces.map(async (ws) => {
        const r = await admin(ws, `/v1/admin/sessions?account=${encodeURIComponent(userId)}`);
        const { sessions = [] } = (await r.json().catch(() => ({}))) as { sessions?: Record<string, unknown>[] };
        return sessions.map((s) => ({ ...s, guests: noEmails(s.guests as Record<string, unknown>[]), workspace: { slug: ws.slug, name: ws.name } }));
      }),
    );
    return json({ sessions: out.flat() });
  }
  const m = /^\/api\/shared\/([a-z0-9-]+)\/sessions\/([A-Za-z0-9_-]+)(\/leave)?$/.exec(url.pathname);
  const ws = m && spaces.find((w) => w.slug === m[1]);
  if (!m || !ws) return json({ error: "not_found" }, 404);
  const id = encodeURIComponent(m[2]!);
  if (m[3] && req.method === "POST") return admin(ws, `/v1/admin/sessions/${id}/accounts/${encodeURIComponent(userId)}`, "DELETE");
  const r = await admin(ws, `/v1/admin/sessions/${id}?account=${encodeURIComponent(userId)}`);
  if (!r.ok) return json({ error: "not_found" }, 404);
  return json({ ...((await r.json()) as object), workspace: { slug: ws.slug, name: ws.name } });
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

  // Desktop app sign-in, like a TV code: the app gets a code, the person approves it at /link.
  if (url.pathname === "/auth/device/start" && req.method === "POST") {
    if (await tooManyFailures(env, [`device:${ip}`])) return json({ error: "Too many sign-in codes. Wait a few minutes and try again." }, 429);
    await recordFailure(env, [`device:${ip}`]);
    const body = await readJson(req);
    const cf = (req as Request & { cf?: { city?: string; region?: string; country?: string } }).cf;
    const place = [cf?.city, cf?.region, cf?.country].filter(Boolean).join(", ") || null;
    const link = await startDeviceLink(env, typeof body.host === "string" ? body.host.trim() : "", { ip, place });
    // The code is never put in the link: the person types what their own app shows, so a link
    // someone else sends them can't approve a sign-in they didn't start.
    return json({ ...link, verify_url: `${url.origin}/link`, interval: 2 });
  }
  if (url.pathname === "/auth/device/poll" && req.method === "POST") {
    const body = await readJson(req);
    if (typeof body.device_code !== "string" || body.device_code.length < 20) return json({ error: "device_code required" }, 400);
    return json(await pollDeviceLink(env, body.device_code));
  }
  if (url.pathname === "/auth/google") {
    if (!googleEnabled(env)) return Response.redirect(`${url.origin}/signin?error=google_unavailable`, 302);
    return googleStart(env, url, url.searchParams.get("next") ?? "/app");
  }
  // Google Cloud Console has /auth/callback/google registered; the older path still works.
  if (url.pathname === GOOGLE_CALLBACK || url.pathname === "/auth/google/callback") {
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
  const ip = req.headers.get("cf-connecting-ip") ?? "local";

  if (url.pathname === "/api/me") {
    return json({ user, workspaces: workspaces.map(({ slug, name, role }) => ({ slug, name, role, url: `${url.origin}/w/${slug}` })), google: googleEnabled(env) });
  }
  if (url.pathname.startsWith("/api/shared")) return handleShared(env, req, url, user.id);
  if (url.pathname === "/api/device" && req.method === "GET") {
    // Wrong codes count against the person, so codes can't be guessed.
    if (await tooManyFailures(env, [`code:${user.id}`, `code-ip:${ip}`])) return json({ error: "Too many wrong codes. Wait a few minutes and try again." }, 429);
    const link = await deviceLinkByCode(env, url.searchParams.get("code") ?? "");
    if (!link) {
      await recordFailure(env, [`code:${user.id}`, `code-ip:${ip}`]);
      return json({ error: "That code expired or doesn't exist. Start again from the app." }, 404);
    }
    return json({ code: link.user_code, host: link.host, status: link.status, expires_at: link.expires_at, origin_ip: link.origin_ip, origin_place: link.origin_place, your_ip: ip });
  }
  if (url.pathname === "/api/device/approve" && req.method === "POST") {
    const body = await readJson(req);
    const code = String(body.code ?? "").trim().toUpperCase();
    if (await tooManyFailures(env, [`code:${user.id}`, `code-ip:${ip}`])) return json({ error: "Too many wrong codes. Wait a few minutes and try again." }, 429);
    const link = await deviceLinkByCode(env, code);
    if (!link || link.status !== "pending") {
      await recordFailure(env, [`code:${user.id}`, `code-ip:${ip}`]);
      return json({ error: "That code expired or was already used. Start again from the app." }, 404);
    }
    if (body.deny === true) {
      await decideDeviceLink(env, code, user.id, "deny");
      return json({ ok: true, status: "denied" });
    }
    const ws = workspaces.find((w) => w.slug === body.workspace) ?? workspaces[0];
    if (!ws) return json({ error: "You don't have a workspace yet." }, 400);
    // A one-use owner invite: the app joins with it, as this person's own agent.
    const inviteReq = new Request(new URL("/v1/admin/invites", url.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: true, max_uses: 1, ttl_hours: 1, note: `Desktop app on ${link.host}` }),
    });
    const res = await toRelay(env, inviteReq, ws.do_name, "/v1/admin/invites", workspaceHeaders(url, ws), true);
    const invite = (await res.json().catch(() => ({}))) as { url?: string };
    if (!res.ok || !invite.url) return json({ error: "Couldn't create an invite for this computer. Try again." }, 502);
    if (!(await decideDeviceLink(env, code, user.id, { workspace: ws.slug, invite_url: invite.url }))) return json({ error: "That code expired. Start again from the app." }, 409);
    return json({ ok: true, status: "approved", workspace: ws.slug });
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

/**
 * Desktop installers are bigger than the 25 MiB a single static asset may be, so the build splits
 * each into parts and this joins them back into one download as a stream.
 */
async function download(env: Env, req: Request, url: URL, os: string): Promise<Response> {
  const manifestRes = await asset(env, req, `/downloads/desktop/${os}.json`);
  if (!manifestRes.ok) return Response.redirect(`${url.origin}/docs#desktop`, 302);
  const m = (await manifestRes.json()) as { file: string; size: number; parts: string[] };
  const { readable, writable } = new FixedLengthStream(m.size); // keeps Content-Length, so browsers show progress
  const pump = async () => {
    try {
      for (const part of m.parts) {
        const r = await asset(env, req, `/downloads/desktop/${part}`);
        if (!r.ok || !r.body) throw new Error(`missing part ${part}`);
        await r.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (e) {
      await writable.abort(e);
    }
  };
  void pump();
  return new Response(readable, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(m.size),
      "content-disposition": `attachment; filename="${m.file}"`,
      "cache-control": "public, max-age=300",
    },
  });
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
      if (rest === "/v1/register" && req.headers.get("authorization")?.startsWith("Bearer ")) return registerAsAccount(env, req, url, ws);
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

    if (p === "/link") {
      if (!(await currentUser(env, req))) return Response.redirect(`${url.origin}/signin?next=${encodeURIComponent(p + url.search)}`, 302);
      return asset(env, req, "/link.html");
    }
    const dl = /^\/download\/(windows|mac|linux)$/.exec(p);
    if (dl) return download(env, req, url, dl[1]!);

    if (p === "/app" || p.startsWith("/app/")) {
      if (!(await currentUser(env, req))) return Response.redirect(`${url.origin}/signin?next=${encodeURIComponent(p)}`, 302);
      return asset(env, req, "/app.html");
    }
    if (PAGES[p]) return asset(env, req, PAGES[p]!);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
