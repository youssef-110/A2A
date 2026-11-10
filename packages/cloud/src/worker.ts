import type { Env } from "./relay-do.ts";
import {
  createSession,
  createWorkspace,
  currentUser,
  decideDeviceLink,
  deviceLinkByCode,
  endSession,
  finishPasswordReset,
  GITHUB_CALLBACK,
  githubEnabled,
  githubFinish,
  githubStart,
  GOOGLE_CALLBACK,
  googleEnabled,
  googleFinish,
  googleStart,
  guestWorkspaces,
  pollDeviceLink,
  recordFailure,
  recordGuestWorkspace,
  resetTokenValid,
  signIn,
  signUp,
  startDeviceLink,
  startPasswordReset,
  subscribe,
  tooManyFailures,
  unsubscribe,
  workspaceBySlug,
  workspacesFor,
} from "./accounts.ts";
import { NEWSLETTER_NAME, sendEmail } from "./email.ts";

export { WorkspaceRelay } from "./relay-do.ts";

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
  "/forgot": "/reset.html",
  "/reset": "/reset.html",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const m = /^\/api\/shared\/([a-z0-9-]+)\/sessions\/([A-Za-z0-9_-]+)(\/leave|\/auto-reply)?$/.exec(url.pathname);
  const ws = m && spaces.find((w) => w.slug === m[1]);
  if (!m || !ws) return json({ error: "not_found" }, 404);
  const id = encodeURIComponent(m[2]!);
  if (m[3] === "/auto-reply" && req.method === "POST") {
    const body = { ...(await readJson(req)), session_id: m[2] };
    const fwd = new Request(new URL("/v1/admin/auto-reply", url.origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return toRelay(env, fwd, ws.do_name, "/v1/admin/auto-reply", { ...workspaceHeaders(url, ws), "x-a2a-account-id": userId }, true);
  }
  if (m[3] && req.method === "POST") return admin(ws, `/v1/admin/sessions/${id}/accounts/${encodeURIComponent(userId)}`, "DELETE");
  const r = await admin(ws, `/v1/admin/sessions/${id}?account=${encodeURIComponent(userId)}`);
  if (!r.ok) return json({ error: "not_found" }, 404);
  return json({ ...((await r.json()) as object), workspace: { slug: ws.slug, name: ws.name } });
}

/** The welcome email after sign-up, plus the newsletter if they ticked the box. Never fails sign-up. */
async function welcome(env: Env, origin: string, email: string, name: string | null, newsletter: boolean): Promise<void> {
  const sub = newsletter ? await subscribe(env, email, "signup") : null;
  const unsub = sub && "unsub_token" in sub ? `${origin}/news/unsubscribe?t=${sub.unsub_token}` : undefined;
  await sendEmail(env, origin, email, "Welcome to a2a", {
    preview: "Connect your AI apps and start your first session.",
    heading: `Welcome, ${name ?? "there"}`,
    paragraphs: [
      "Your workspace is ready. Connect your AI apps (Claude Code, Antigravity, Cursor, Codex and more) and each one gets its own agent that can talk to your teammates' agents.",
      "Open your dashboard, click Connect your AI apps, and paste the prompt into any of them.",
      ...(unsub ? [`You're also on ${NEWSLETTER_NAME}, our short newsletter about what's new.`] : []),
    ],
    button: { label: "Open your dashboard", url: `${origin}/app` },
    footer: "You got this because you created an a2a account.",
    unsubscribeUrl: unsub,
  });
}

/** A small page in the site's style, for the unsubscribe steps. */
function page(title: string, body: string, form?: { action: string; label: string }): Response {
  const action = form ? `<form method="post" action="${form.action}"><button class="btn" type="submit">${form.label}</button></form>` : `<a class="btn" href="/">Back to a2a</a>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/site.css"></head>` +
      `<body><main class="auth"><div class="auth-card"><a class="logo" href="/" aria-label="a2a home"><img src="/email-logo.png" width="28" height="28" alt="" style="border-radius:7px"><span>a2a</span></a>` +
      `<div><h1>${title}</h1><p class="sub" style="margin-top:10px">${body}</p></div>${action}</div></main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/** The newsletter: subscribe from the site, unsubscribe from the link in any email. */
async function handleNews(env: Env, req: Request, url: URL, ctx: ExecutionContext): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  if (url.pathname === "/news/subscribe" && req.method === "POST") {
    if (await tooManyFailures(env, [`news:${ip}`], 10)) return json({ error: "Too many sign-ups from here. Try again later." }, 429);
    const body = await readJson(req);
    const r = await subscribe(env, String(body.email ?? ""), typeof body.source === "string" ? body.source : "site");
    if ("error" in r) return json({ error: r.error }, 400);
    await recordFailure(env, [`news:${ip}`]);
    if (r.isNew) {
      ctx.waitUntil(
        sendEmail(env, url.origin, r.email, `You're on ${NEWSLETTER_NAME}`, {
          preview: "Short notes on what's new in a2a, about once a month.",
          heading: `Welcome to ${NEWSLETTER_NAME}`,
          paragraphs: [
            `Thanks for subscribing. ${NEWSLETTER_NAME} is a short note, about once a month, on what's new in a2a: apps your agents can join from, session features, and tips for getting agents to work together.`,
            "No spam. One click unsubscribes.",
          ],
          button: { label: "See what a2a does", url: `${url.origin}/docs` },
          footer: `You got this because ${r.email} was entered on the a2a website.`,
          unsubscribeUrl: `${url.origin}/news/unsubscribe?t=${r.unsub_token}`,
        }),
      );
    }
    return json({ ok: true, already: !r.isNew });
  }
  if (url.pathname === "/news/unsubscribe") {
    const token = url.searchParams.get("t") ?? "";
    // GET only asks (mail scanners open links); POST, from that button or an email app's one-click
    // List-Unsubscribe, does it.
    if (req.method !== "POST") {
      return page(`Unsubscribe from ${NEWSLETTER_NAME}?`, "You'll stop getting the newsletter. Account emails, like password resets, still arrive.", {
        action: `/news/unsubscribe?t=${encodeURIComponent(token)}`,
        label: "Unsubscribe",
      });
    }
    const email = await unsubscribe(env, token);
    return email
      ? page("You're unsubscribed", `You won't get ${NEWSLETTER_NAME} anymore. Changed your mind? Subscribe again on the home page.`)
      : page("Link not found", "This unsubscribe link isn't valid.");
  }
  return json({ error: "not_found" }, 404);
}

async function handleAuth(env: Env, req: Request, url: URL, ctx: ExecutionContext): Promise<Response> {
  const secure = url.protocol === "https:";
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  if (url.pathname === "/auth/signup" && req.method === "POST") {
    if (await tooManyFailures(env, [`ip:${ip}`]) || (await tooManyFailures(env, [`signup:${ip}`], 60))) return json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
    await recordFailure(env, [`signup:${ip}`]);
    const body = await readJson(req);
    const r = await signUp(env, body);
    if ("error" in r) {
      await recordFailure(env, [`ip:${ip}`]);
      return json({ error: r.error }, 400);
    }
    ctx.waitUntil(welcome(env, url.origin, r.email, r.name, body.newsletter === true));
    return json({ ok: true }, 201, { "set-cookie": await createSession(env, r.id, secure) });
  }
  if (url.pathname === "/auth/signin" && req.method === "POST") {
    const body = await readJson(req);
    const email = String(body.email ?? "").trim().toLowerCase();
    const keys = [`ip:${ip}`, `pair:${ip}:${email}`, `email:${email}`];
    if ((await tooManyFailures(env, keys.slice(0, 2))) || (await tooManyFailures(env, keys.slice(2), 60))) return json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
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
  if (url.pathname === "/auth/providers") return json({ google: googleEnabled(env), github: githubEnabled(env) });

  // Forgot password: the reply is the same whether or not the email has an account, and the email
  // goes out after replying, so neither the answer nor its timing tells who has one.
  if (url.pathname === "/auth/forgot" && req.method === "POST") {
    const email = String((await readJson(req)).email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
    const keys = [`reset-ip:${ip}`, `reset-email:${email}`];
    if (await tooManyFailures(env, keys, 5)) return json({ error: "Too many reset emails. Wait a few minutes and try again." }, 429);
    await recordFailure(env, keys);
    ctx.waitUntil(
      startPasswordReset(env, email).then(
        (r) =>
          r &&
          sendEmail(env, url.origin, r.user.email, "Reset your a2a password", {
            preview: "Choose a new password. The link works for 30 minutes.",
            heading: "Reset your password",
            paragraphs: [`Hi ${r.user.name ?? "there"},`, "Someone (hopefully you) asked to reset the password for your a2a account. The button below works once, for 30 minutes."],
            button: { label: "Choose a new password", url: `${url.origin}/reset?token=${r.token}` },
            footer: "Didn't ask for this? Ignore this email; your password stays the same.",
          }),
      ),
    );
    return json({ ok: true });
  }
  if (url.pathname === "/auth/reset/check" && req.method === "GET") {
    return json({ valid: await resetTokenValid(env, url.searchParams.get("token") ?? "") });
  }
  if (url.pathname === "/auth/reset" && req.method === "POST") {
    if (await tooManyFailures(env, [`ip:${ip}`])) return json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
    const body = await readJson(req);
    const r = await finishPasswordReset(env, String(body.token ?? ""), typeof body.password === "string" ? body.password : "");
    if ("error" in r) {
      await recordFailure(env, [`ip:${ip}`]);
      return json({ error: r.error }, 400);
    }
    ctx.waitUntil(
      sendEmail(env, url.origin, r.email, "Your a2a password was changed", {
        preview: "Your password was just changed.",
        heading: "Your password was changed",
        paragraphs: [`Hi ${r.name ?? "there"},`, "The password for your a2a account was just changed, and every other device was signed out. Your agents keep working."],
        button: { label: "Open a2a", url: `${url.origin}/app` },
        footer: "If this wasn't you, reset your password again right away.",
      }),
    );
    return json({ ok: true }, 200, { "set-cookie": await createSession(env, r.id, secure) });
  }

  // Desktop app sign-in, like a TV code: the app gets a code, the person approves it at /link.
  if (url.pathname === "/auth/device/start" && req.method === "POST") {
    // Every start counts (not only failures), agents retry, and a whole room (a hackathon) can share one address.
    if (await tooManyFailures(env, [`device:${ip}`], 200)) return json({ error: "Too many sign-in codes. Wait a few minutes and try again." }, 429);
    await recordFailure(env, [`device:${ip}`]);
    const body = await readJson(req);
    const cf = (req as Request & { cf?: { city?: string; region?: string; country?: string } }).cf;
    const place = [cf?.city, cf?.region, cf?.country].filter(Boolean).join(", ") || null;
    const link = await startDeviceLink(env, typeof body.host === "string" ? body.host.trim() : "", { ip, place });
    // verify_url_complete (RFC 8628) fills the code in, so the person only clicks Connect. /link still
    // shows which computer and network asked, and warns when that network isn't the browser's.
    return json({ ...link, verify_url: `${url.origin}/link`, verify_url_complete: `${url.origin}/link?code=${link.user_code}`, interval: 2 });
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
  if (url.pathname === "/auth/github") {
    if (!githubEnabled(env)) return Response.redirect(`${url.origin}/signin?error=github_unavailable`, 302);
    return githubStart(env, url, url.searchParams.get("next") ?? "/app");
  }
  if (url.pathname === GITHUB_CALLBACK) {
    const r = await githubFinish(env, req, url);
    if ("error" in r) return Response.redirect(`${url.origin}/signin?error=${encodeURIComponent(r.error)}`, 302);
    const headers = new Headers({ location: `${url.origin}${r.next}` });
    headers.append("set-cookie", await createSession(env, r.user.id, secure));
    headers.append("set-cookie", "a2a_oauth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return new Response(null, { status: 302, headers });
  }
  return json({ error: "not_found" }, 404);
}

async function handleApi(env: Env, req: Request, url: URL, ctx: ExecutionContext): Promise<Response> {
  const user = await currentUser(env, req);
  if (!user) return json({ error: "signed_out" }, 401);
  const workspaces = await workspacesFor(env, user.id);
  const ip = req.headers.get("cf-connecting-ip") ?? "local";

  if (url.pathname === "/api/me") {
    return json({ user, workspaces: workspaces.map(({ slug, name, role }) => ({ slug, name, role, url: `${url.origin}/w/${slug}` })), google: googleEnabled(env), github: githubEnabled(env) });
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
  if (url.pathname === "/api/invite-email" && req.method === "POST") {
    const body = await readJson(req);
    const to = String(body.to ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(to)) return json({ error: "Enter a valid email address." }, 400);
    // Only invites to the sender's own workspaces, checked with the relay, so this can't mail arbitrary links.
    let path = "";
    try {
      path = new URL(String(body.url ?? "")).pathname;
    } catch {
      /* not a URL */
    }
    const m = /^\/w\/([a-z0-9-]+)\/join\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    const ws = m && workspaces.find((w) => w.slug === m[1]);
    if (!m || !ws) return json({ error: "That isn't an invite to one of your workspaces." }, 400);
    if (await tooManyFailures(env, [`invite-mail:${user.id}`], 30)) return json({ error: "That's a lot of invites at once. Wait a few minutes and try again." }, 429);
    const check = await toRelay(env, new Request(new URL(`/v1/invites/${m[2]}`, url.origin)), ws.do_name, `/v1/invites/${m[2]}`, workspaceHeaders(url, ws));
    const info = (await check.json().catch(() => ({}))) as { valid?: boolean; session?: string | null };
    if (!info.valid) return json({ error: "This invite expired. Create a new one first." }, 400);
    await recordFailure(env, [`invite-mail:${user.id}`]);
    const who = user.name ?? user.email;
    const sent = await sendEmail(env, url.origin, to, "You were invited to an a2a session", {
      preview: "Your AI agents can work together in one shared session.",
      heading: "You're invited to a2a",
      paragraphs: [
        `${who} (${user.email}) invited you to ${info.session ? `the session "${info.session}"` : "a shared session"} on a2a. Your AI apps (Claude Code, Antigravity, Cursor, Codex and more) each get their own agent and can message everyone else's agents in the session.`,
        "Open the invite, copy the prompt into your AI agent, and click Connect when your browser asks. It takes about a minute.",
      ],
      button: { label: "Open the invite", url: `${url.origin}/w/${ws.slug}/join/${m[2]}` },
      footer: `You got this because ${user.email} entered your address on a2a. If you don't know them, ignore this email.`,
    });
    return sent ? json({ ok: true }) : json({ error: "The email couldn't be sent. Copy the link and send it yourself." }, 502);
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
    // The relay checks the agent is this person's; it needs to know who is asking.
    const who: Record<string, string> = m[2] === "/v1/admin/auto-reply" ? { "x-a2a-account-id": user.id } : {};
    return toRelay(env, req, ws.do_name, m[2]!, { ...workspaceHeaders(url, ws), ...who }, true);
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

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // the small pages (sign-in, join, link, reset) carry inline scripts
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://lh3.googleusercontent.com https://avatars.githubusercontent.com",
  "connect-src 'self' wss://api.reson8.dev",
  "media-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/** Headers every answer gets. Upgrades (WebSockets) pass through untouched. */
function secured(res: Response, https: boolean): Response {
  if (res.status === 101 || res.webSocket) return res;
  const out = new Response(res.body, res);
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "no-referrer"); // reset tokens and codes travel in URLs
  out.headers.set("x-frame-options", "DENY");
  if (https) out.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  if ((out.headers.get("content-type") ?? "").startsWith("text/html")) out.headers.set("content-security-policy", CSP);
  return out;
}

/**
 * Cookie-backed writes must come from this site: a browser's cross-site request says so in
 * Sec-Fetch-Site or Origin, and a plain HTML form can't send JSON. The a2a CLI sends neither header.
 */
function crossSiteWrite(req: Request, url: URL): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  if (req.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = req.headers.get("origin");
  if (origin && origin !== "null" && origin !== url.origin) return true;
  const type = req.headers.get("content-type");
  return !!type && !type.toLowerCase().startsWith("application/json");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if ((url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) && crossSiteWrite(req, url)) {
      return secured(json({ error: "cross_site", detail: "This request didn't come from a2a." }, 403), url.protocol === "https:");
    }
    return secured(await route(req, env, ctx, url), url.protocol === "https:");
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  {
    const p = url.pathname;

    if (p.startsWith("/auth/")) return handleAuth(env, req, url, ctx);
    if (p.startsWith("/api/")) return handleApi(env, req, url, ctx);
    if (p.startsWith("/news/")) return handleNews(env, req, url, ctx);

    // Workspace relays: agents only. Admin and voice go through /api with a signed-in member.
    const w = /^\/w\/([a-z0-9-]+)(\/.*)$/.exec(p);
    if (w) {
      const [, slug, rest] = w;
      if (rest!.startsWith("/join/")) return asset(env, req, "/join.html");
      if (!rest!.startsWith("/v1/") || rest!.startsWith("/v1/admin/") || rest!.startsWith("/v1/voice/")) return json({ error: "not_found" }, 404);
      const ws = await workspaceBySlug(env, slug!);
      if (!ws) return json({ error: "unknown_workspace" }, 404);
      if (rest === "/v1/register") {
        const ip = req.headers.get("cf-connecting-ip") ?? "local";
        if (await tooManyFailures(env, [`register:${ip}`], 400)) return json({ error: "rate_limited", detail: "Too many agents registered from here. Wait a few minutes and try again." }, 429);
        await recordFailure(env, [`register:${ip}`]);
        if (req.headers.get("authorization")?.startsWith("Bearer ")) return registerAsAccount(env, req, url, ws);
      }
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
  }
}
