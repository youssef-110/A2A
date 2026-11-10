/**
 * Website accounts on D1: email + password and Google sign-in, cookie sessions, and workspaces.
 * A workspace is one relay (one Durable Object); its slug is the agent org, agent://<slug>/<name>.
 */

export interface AccountsEnv {
  ACCOUNTS: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** This email gets the original single relay (agent://acme) as a workspace when it signs in. */
  A2A_LEGACY_OWNER?: string;
  A2A_ORG?: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  do_name: string;
  role: "owner" | "admin";
}

const COOKIE = "a2a_auth";
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000; // the Workers runtime caps PBKDF2 at 100k
const enc = new TextEncoder();
const iso = (ms = Date.now()): string => new Date(ms).toISOString();

const b64url = (bytes: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const randomToken = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const newId = (prefix: string): string => `${prefix}_${randomToken(12)}`;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return b64url(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, iter, salt, hash] = (stored ?? "").split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  return timingSafeEqualStr(await pbkdf2(password, fromB64url(salt), Number(iter)), hash);
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function cookie(name: string, value: string, maxAgeS: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

// ------------------------------------------------------------------ sessions

async function newSessionToken(env: AccountsEnv, userId: string, days = SESSION_DAYS): Promise<string> {
  const token = randomToken();
  await env.ACCOUNTS.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, iso(), iso(Date.now() + days * 86_400_000))
    .run();
  return token;
}

export async function createSession(env: AccountsEnv, userId: string, secure: boolean): Promise<string> {
  return cookie(COOKIE, await newSessionToken(env, userId), SESSION_DAYS * 86_400, secure);
}

/** The signed-in person: the website cookie, or a Bearer token the a2a CLI got by signing in at /link. */
export async function currentUser(env: AccountsEnv, req: Request): Promise<User | null> {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : readCookie(req, COOKIE);
  if (!token) return null;
  return env.ACCOUNTS.prepare(
    "SELECT u.id, u.email, u.name, u.avatar_url FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  )
    .bind(await sha256Hex(token), iso())
    .first<User>();
}

export async function endSession(env: AccountsEnv, req: Request, secure: boolean): Promise<string> {
  const auth = req.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : readCookie(req, COOKIE);
  if (token) await env.ACCOUNTS.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return cookie(COOKIE, "", 0, secure);
}

// ------------------------------------------------------------------ sign-in throttling

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

export async function tooManyFailures(env: AccountsEnv, keys: string[], max = MAX_FAILURES): Promise<boolean> {
  const since = iso(Date.now() - WINDOW_MS);
  for (const key of keys) {
    const r = await env.ACCOUNTS.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ? AND at > ?").bind(key, since).first<{ n: number }>();
    if ((r?.n ?? 0) >= max) return true;
  }
  return false;
}

export async function recordFailure(env: AccountsEnv, keys: string[]): Promise<void> {
  const now = iso();
  await env.ACCOUNTS.batch([
    ...keys.map((k) => env.ACCOUNTS.prepare("INSERT INTO auth_attempts (key, at) VALUES (?, ?)").bind(k, now)),
    env.ACCOUNTS.prepare("DELETE FROM auth_attempts WHERE at < ?").bind(iso(Date.now() - 24 * 3600_000)),
  ]);
}

// ------------------------------------------------------------------ users and workspaces

const slugify = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "team";

async function uniqueSlug(env: AccountsEnv, base: string): Promise<string> {
  const reserved = new Set(["acme", "app", "api", "auth", "docs", "admin", "www", "w", "join"]);
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (reserved.has(slug)) continue;
    const taken = await env.ACCOUNTS.prepare("SELECT 1 FROM workspaces WHERE slug = ?").bind(slug).first();
    if (!taken) return slug;
  }
  return `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

export async function createWorkspace(env: AccountsEnv, userId: string, name: string, slugHint?: string): Promise<Workspace> {
  const id = newId("ws");
  const slug = await uniqueSlug(env, slugify(slugHint ?? name));
  const now = iso();
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare("INSERT INTO workspaces (id, slug, name, do_name, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, slug, name.slice(0, 60), `ws:${id}`, now),
    env.ACCOUNTS.prepare("INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(userId, id, now),
  ]);
  return { id, slug, name, do_name: `ws:${id}`, role: "owner" };
}

/**
 * The original single relay (Durable Object "relay", agent://acme) belongs to the legacy owner's account.
 * Only call this for an identity whose email is proven (Google with email_verified): password sign-ups
 * don't verify email, so matching on them would hand the relay to whoever registers the address first.
 */
async function attachLegacyRelay(env: AccountsEnv, user: User): Promise<void> {
  if (!env.A2A_LEGACY_OWNER || user.email.toLowerCase() !== env.A2A_LEGACY_OWNER.toLowerCase()) return;
  const slug = env.A2A_ORG || "acme";
  let ws = await env.ACCOUNTS.prepare("SELECT id FROM workspaces WHERE do_name = 'relay'").first<{ id: string }>();
  if (!ws) {
    const id = newId("ws");
    await env.ACCOUNTS.prepare("INSERT INTO workspaces (id, slug, name, do_name, created_at) VALUES (?, ?, ?, 'relay', ?)").bind(id, slug, "Acme", iso()).run();
    ws = { id };
  }
  await env.ACCOUNTS.prepare("INSERT OR IGNORE INTO memberships (user_id, workspace_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(user.id, ws.id, iso()).run();
}

export async function workspacesFor(env: AccountsEnv, userId: string): Promise<Workspace[]> {
  const r = await env.ACCOUNTS.prepare(
    "SELECT w.id, w.slug, w.name, w.do_name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at",
  )
    .bind(userId)
    .all<Workspace>();
  return r.results;
}

export async function workspaceBySlug(env: AccountsEnv, slug: string): Promise<{ id: string; slug: string; name: string; do_name: string } | null> {
  return env.ACCOUNTS.prepare("SELECT id, slug, name, do_name FROM workspaces WHERE slug = ?").bind(slug).first();
}

export async function signUp(env: AccountsEnv, input: { email?: unknown; password?: unknown; name?: unknown }): Promise<User | { error: string }> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 60) : email.split("@")[0]!;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };
  if (password.length < 10) return { error: "Use at least 10 characters for your password." };
  const existing = await env.ACCOUNTS.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return { error: "An account with this email already exists. Sign in instead." };
  const user: User = { id: newId("usr"), email, name, avatar_url: null };
  await env.ACCOUNTS.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(user.id, email, name, await hashPassword(password), iso())
    .run();
  await onFirstSignIn(env, user);
  return user;
}

export async function signIn(env: AccountsEnv, input: { email?: unknown; password?: unknown }): Promise<User | null> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const row = await env.ACCOUNTS.prepare("SELECT id, email, name, avatar_url, password_hash FROM users WHERE email = ?").bind(email).first<User & { password_hash: string | null }>();
  // Hash even when the account is unknown, so response time doesn't reveal which emails exist.
  const ok = await verifyPassword(typeof input.password === "string" ? input.password : "", row?.password_hash ?? "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$x");
  if (!row || !ok) return null;
  return { id: row.id, email: row.email, name: row.name, avatar_url: row.avatar_url };
}

/**
 * Replaces everything an unverified sign-up built with an empty workspace. Password sign-ups don't
 * prove the email, so the first proof of ownership (Google, GitHub or a reset email) must not inherit
 * agents or invites someone else may have planted under that address.
 */
async function freshStart(env: AccountsEnv, user: User): Promise<void> {
  await env.ACCOUNTS.prepare("DELETE FROM workspaces WHERE do_name != 'relay' AND id IN (SELECT workspace_id FROM memberships WHERE user_id = ? AND role = 'owner')").bind(user.id).run();
  await env.ACCOUNTS.prepare("DELETE FROM memberships WHERE user_id = ?").bind(user.id).run();
  await onFirstSignIn(env, user);
}

/** A new account's own workspace. Nothing here depends on the email being verified. */
async function onFirstSignIn(env: AccountsEnv, user: User): Promise<void> {
  const first = (user.name ?? user.email).split(/\s+/)[0]!;
  await createWorkspace(env, user.id, `${first}'s workspace`, first);
}

// ------------------------------------------------------------------ Google sign-in

/** The redirect URI registered in Google Cloud Console. /auth/google/callback is still accepted for old links. */
export const GOOGLE_CALLBACK = "/auth/callback/google";

export const googleEnabled = (env: AccountsEnv): boolean => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export async function googleStart(env: AccountsEnv, url: URL, next: string): Promise<Response> {
  const state = randomToken(18);
  const verifier = randomToken(32);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${url.origin}${GOOGLE_CALLBACK}`,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: { location: auth.toString(), "set-cookie": cookie("a2a_oauth", `${state}.${verifier}.${b64url(enc.encode(next))}`, 600, url.protocol === "https:") },
  });
}

export async function googleFinish(env: AccountsEnv, req: Request, url: URL): Promise<{ user: User; next: string } | { error: string }> {
  const [state, verifier, nextB64] = (readCookie(req, "a2a_oauth") ?? "").split(".");
  if (!state || !verifier || !timingSafeEqualStr(url.searchParams.get("state") ?? "", state)) return { error: "The sign-in link expired. Try again." };
  const code = url.searchParams.get("code");
  if (!code) return { error: "Google sign-in was cancelled." };
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${url.origin}${GOOGLE_CALLBACK}`,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const token = (await res.json()) as { id_token?: string };
  if (!res.ok || !token.id_token) return { error: "Google didn't confirm the sign-in. Try again." };
  // The ID token came straight from Google's token endpoint over TLS, so its claims can be read directly.
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(token.id_token.split(".")[1]!))) as {
    sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string; aud: string; iss: string; exp: number;
  };
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) || claims.exp * 1000 < Date.now()) {
    return { error: "Google's answer didn't check out. Try again." };
  }
  if (!claims.email || !claims.email_verified) return { error: "Your Google account needs a verified email address." };
  const email = claims.email.toLowerCase();

  const user = await oauthUser(env, "google_sub", claims.sub, email, claims.name ?? null, claims.picture ?? null);
  if (!user) return { error: "This email is linked to a different Google account." };
  await attachLegacyRelay(env, user); // Google has verified this email
  return { user, next: oauthNext(nextB64) };
}

/** Where to go after sign-in, from the OAuth cookie. Only the dashboard or the device-link page. */
function oauthNext(nextB64: string | undefined): string {
  try {
    const decoded = new TextDecoder().decode(fromB64url(nextB64 ?? ""));
    if (/^\/(app|link)(\/|\?|$)/.test(decoded)) return decoded;
  } catch {
    /* default */
  }
  return "/app";
}

/**
 * The account for an identity whose email the provider has verified: matched by the provider's id,
 * else by email, else created. `column` is one of two literals, never input.
 */
async function oauthUser(env: AccountsEnv, column: "google_sub" | "github_id", sub: string, email: string, name: string | null, avatar: string | null): Promise<User | null> {
  const existing = await env.ACCOUNTS.prepare(`SELECT id, email, name, avatar_url, google_sub, github_id, email_verified FROM users WHERE ${column} = ? OR email = ? ORDER BY ${column} IS NULL LIMIT 1`)
    .bind(sub, email)
    .first<User & { google_sub: string | null; github_id: string | null; email_verified: number }>();
  if (existing) {
    if (existing[column] && existing[column] !== sub) return null;
    if (!existing.email_verified) {
      // A password account with this email, never verified. The provider proves who owns the address,
      // so this person takes it over: the old password, every session it opened, and whatever the
      // earlier sign-up left in its workspace (agents, invites) are gone.
      await env.ACCOUNTS.batch([
        env.ACCOUNTS.prepare("UPDATE users SET password_hash = NULL WHERE id = ?").bind(existing.id),
        env.ACCOUNTS.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(existing.id),
      ]);
      await freshStart(env, existing);
    }
    await env.ACCOUNTS.prepare(`UPDATE users SET ${column} = ?, email_verified = 1, avatar_url = COALESCE(avatar_url, ?), name = COALESCE(name, ?) WHERE id = ?`).bind(sub, avatar, name, existing.id).run();
    return { id: existing.id, email: existing.email, name: existing.name ?? name, avatar_url: existing.avatar_url ?? avatar };
  }
  const user: User = { id: newId("usr"), email, name: name ?? email.split("@")[0]!, avatar_url: avatar };
  await env.ACCOUNTS.prepare(`INSERT INTO users (id, email, name, ${column}, avatar_url, email_verified, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`).bind(user.id, email, user.name, sub, avatar, iso()).run();
  await onFirstSignIn(env, user);
  return user;
}

// ------------------------------------------------------------------ GitHub sign-in

export const GITHUB_CALLBACK = "/auth/callback/github";

export const githubEnabled = (env: AccountsEnv): boolean => !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

export function githubStart(env: AccountsEnv, url: URL, next: string): Response {
  const state = randomToken(18);
  const auth = new URL("https://github.com/login/oauth/authorize");
  auth.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID!, redirect_uri: `${url.origin}${GITHUB_CALLBACK}`, scope: "read:user user:email", state }).toString();
  // Same cookie shape as Google's (state.verifier.next); GitHub OAuth apps have no PKCE, so the middle is unused.
  return new Response(null, { status: 302, headers: { location: auth.toString(), "set-cookie": cookie("a2a_oauth", `${state}.gh.${b64url(enc.encode(next))}`, 600, url.protocol === "https:") } });
}

export async function githubFinish(env: AccountsEnv, req: Request, url: URL): Promise<{ user: User; next: string } | { error: string }> {
  const [state, , nextB64] = (readCookie(req, "a2a_oauth") ?? "").split(".");
  if (!state || !timingSafeEqualStr(url.searchParams.get("state") ?? "", state)) return { error: "The sign-in link expired. Try again." };
  const code = url.searchParams.get("code");
  if (!code) return { error: "GitHub sign-in was cancelled." };
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}${GITHUB_CALLBACK}` }),
  });
  const token = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !token.access_token) return { error: "GitHub didn't confirm the sign-in. Try again." };
  const gh = { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "a2a-relay" };
  const [profileRes, emailsRes] = await Promise.all([fetch("https://api.github.com/user", { headers: gh }), fetch("https://api.github.com/user/emails", { headers: gh })]);
  if (!profileRes.ok || !emailsRes.ok) return { error: "GitHub didn't share your profile. Try again." };
  const profile = (await profileRes.json()) as { id: number; login: string; name: string | null; avatar_url: string | null };
  const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
  // Only an address GitHub has verified may match an existing account.
  const email = (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified))?.email.toLowerCase();
  if (!profile.id || !email) return { error: "Your GitHub account needs a verified email address." };
  const user = await oauthUser(env, "github_id", String(profile.id), email, profile.name ?? profile.login, profile.avatar_url);
  if (!user) return { error: "This email is linked to a different GitHub account." };
  await attachLegacyRelay(env, user);
  return { user, next: oauthNext(nextB64) };
}

// ------------------------------------------------------------------ desktop app sign-in

const LINK_MINUTES = 10;
/** A computer that signed in keeps its token for half a year; it only needs it to add agents or join sessions. */
const DEVICE_SESSION_DAYS = 180;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I

function userCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export interface DeviceLink {
  user_code: string;
  host: string;
  status: "pending" | "approved" | "denied";
  user_id: string | null;
  workspace_slug: string | null;
  invite_url: string | null;
  expires_at: string;
  origin_ip: string | null;
  origin_place: string | null;
}

/** The app asks for a code. Only the secret device code can collect the result. */
export async function startDeviceLink(env: AccountsEnv, host: string, origin: { ip: string; place: string | null }): Promise<{ device_code: string; user_code: string; expires_in: number }> {
  await env.ACCOUNTS.prepare("DELETE FROM device_links WHERE expires_at < ?").bind(iso()).run();
  const device_code = randomToken(32);
  const code = userCode();
  await env.ACCOUNTS.prepare("INSERT INTO device_links (device_hash, user_code, host, origin_ip, origin_place, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(device_code), code, host.slice(0, 60) || "Computer", origin.ip, origin.place, iso(), iso(Date.now() + LINK_MINUTES * 60_000))
    .run();
  return { device_code, user_code: code, expires_in: LINK_MINUTES * 60 };
}

export async function deviceLinkByCode(env: AccountsEnv, code: string): Promise<DeviceLink | null> {
  return env.ACCOUNTS.prepare("SELECT user_code, host, status, user_id, workspace_slug, invite_url, expires_at, origin_ip, origin_place FROM device_links WHERE user_code = ? AND expires_at > ?")
    .bind(code.trim().toUpperCase(), iso())
    .first<DeviceLink>();
}

export async function decideDeviceLink(env: AccountsEnv, code: string, userId: string, decision: { workspace: string; invite_url: string } | "deny"): Promise<boolean> {
  const r =
    decision === "deny"
      ? await env.ACCOUNTS.prepare("UPDATE device_links SET status = 'denied', user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?").bind(userId, code, iso()).run()
      : await env.ACCOUNTS.prepare("UPDATE device_links SET status = 'approved', user_id = ?, workspace_slug = ?, invite_url = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?")
          .bind(userId, decision.workspace, decision.invite_url, code, iso())
          .run();
  return (r.meta.changes ?? 0) > 0;
}

/** The app polls. An approved link is handed over once, with a fresh session, then deleted. */
export async function pollDeviceLink(
  env: AccountsEnv,
  deviceCode: string,
): Promise<{ status: "pending" | "denied" | "expired" } | { status: "approved"; session_token: string; invite_url: string; workspace: string; user: User }> {
  const hash = await sha256Hex(deviceCode);
  const row = await env.ACCOUNTS.prepare("SELECT status, user_id, workspace_slug, invite_url, expires_at FROM device_links WHERE device_hash = ?")
    .bind(hash)
    .first<{ status: string; user_id: string | null; workspace_slug: string | null; invite_url: string | null; expires_at: string }>();
  if (!row || row.expires_at < iso()) return { status: "expired" };
  if (row.status === "denied") {
    await env.ACCOUNTS.prepare("DELETE FROM device_links WHERE device_hash = ?").bind(hash).run();
    return { status: "denied" };
  }
  if (row.status !== "approved" || !row.user_id || !row.invite_url || !row.workspace_slug) return { status: "pending" };
  // Delete first: if two polls race, only the one that deletes the row gets the session.
  const del = await env.ACCOUNTS.prepare("DELETE FROM device_links WHERE device_hash = ? AND status = 'approved'").bind(hash).run();
  if (!del.meta.changes) return { status: "expired" };
  const user = await env.ACCOUNTS.prepare("SELECT id, email, name, avatar_url FROM users WHERE id = ?").bind(row.user_id).first<User>();
  if (!user) return { status: "expired" };
  return { status: "approved", session_token: await newSessionToken(env, user.id, DEVICE_SESSION_DAYS), invite_url: row.invite_url, workspace: row.workspace_slug, user };
}

// ------------------------------------------------------------------ workspaces someone joined as a guest

/** Remembers that a person has agents in someone else's workspace, for their "Shared with you" list. */
export async function recordGuestWorkspace(env: AccountsEnv, userId: string, workspaceId: string): Promise<void> {
  await env.ACCOUNTS.prepare("INSERT OR IGNORE INTO account_relays (user_id, workspace_id, created_at) VALUES (?, ?, ?)").bind(userId, workspaceId, iso()).run();
}

export async function guestWorkspaces(env: AccountsEnv, userId: string): Promise<{ id: string; slug: string; name: string; do_name: string }[]> {
  const r = await env.ACCOUNTS.prepare(
    "SELECT w.id, w.slug, w.name, w.do_name FROM account_relays a JOIN workspaces w ON w.id = a.workspace_id WHERE a.user_id = ? AND w.id NOT IN (SELECT workspace_id FROM memberships WHERE user_id = ?) ORDER BY a.created_at DESC",
  )
    .bind(userId, userId)
    .all<{ id: string; slug: string; name: string; do_name: string }>();
  return r.results;
}

// ------------------------------------------------------------------ password reset and newsletter

const RESET_MINUTES = 30;
const validEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

/** A one-use reset token for the account with this email, or null if there is none (the caller never says which). */
export async function startPasswordReset(env: AccountsEnv, email: string): Promise<{ user: User; token: string } | null> {
  const user = await env.ACCOUNTS.prepare("SELECT id, email, name, avatar_url FROM users WHERE email = ?").bind(email.trim().toLowerCase()).first<User>();
  if (!user) return null;
  const token = randomToken();
  await env.ACCOUNTS.batch([
    // Only the newest link works: asking again cancels the earlier ones.
    env.ACCOUNTS.prepare("DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?").bind(user.id, iso()),
    env.ACCOUNTS.prepare("INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(token), user.id, iso(), iso(Date.now() + RESET_MINUTES * 60_000)),
  ]);
  return { user, token };
}

export async function resetTokenValid(env: AccountsEnv, token: string): Promise<boolean> {
  return !!(await env.ACCOUNTS.prepare("SELECT 1 FROM password_resets WHERE token_hash = ? AND expires_at > ?").bind(await sha256Hex(token), iso()).first());
}

/**
 * Sets a new password with a reset token. The token is used up, and every other sign-in of the
 * account (browsers and a2a CLIs) is signed out, in case someone else had the old password.
 */
export async function finishPasswordReset(env: AccountsEnv, token: string, password: string): Promise<User | { error: string }> {
  if (password.length < 10) return { error: "Use at least 10 characters for your password." };
  const hash = await sha256Hex(token);
  const row = await env.ACCOUNTS.prepare("SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?").bind(hash, iso()).first<{ user_id: string }>();
  if (!row) return { error: "This reset link expired or was already used. Ask for a new one." };
  // Delete first: if the link is used twice at once, only one request sets the password.
  const del = await env.ACCOUNTS.prepare("DELETE FROM password_resets WHERE token_hash = ?").bind(hash).run();
  if (!del.meta.changes) return { error: "This reset link expired or was already used. Ask for a new one." };
  const before = await env.ACCOUNTS.prepare("SELECT id, email, name, avatar_url, email_verified FROM users WHERE id = ?").bind(row.user_id).first<User & { email_verified: number }>();
  if (before && !before.email_verified) await freshStart(env, before);
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare("UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?").bind(await hashPassword(password), row.user_id),
    env.ACCOUNTS.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(row.user_id),
    env.ACCOUNTS.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(row.user_id),
  ]);
  return (await env.ACCOUNTS.prepare("SELECT id, email, name, avatar_url FROM users WHERE id = ?").bind(row.user_id).first<User>())!;
}

/** Adds (or re-adds) an email to the newsletter. isNew is false when it was already subscribed. */
export async function subscribe(env: AccountsEnv, emailIn: string, source: string): Promise<{ email: string; unsub_token: string; isNew: boolean } | { error: string }> {
  const email = emailIn.trim().toLowerCase();
  if (!validEmail(email)) return { error: "Enter a valid email address." };
  const existing = await env.ACCOUNTS.prepare("SELECT unsub_token, unsubscribed_at FROM subscribers WHERE email = ?").bind(email).first<{ unsub_token: string; unsubscribed_at: string | null }>();
  if (existing && !existing.unsubscribed_at) return { email, unsub_token: existing.unsub_token, isNew: false };
  const token = existing?.unsub_token ?? randomToken(24);
  await env.ACCOUNTS.prepare(
    "INSERT INTO subscribers (email, unsub_token, source, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET unsubscribed_at = NULL, created_at = excluded.created_at",
  )
    .bind(email, token, source.slice(0, 30), iso())
    .run();
  return { email, unsub_token: token, isNew: true };
}

export async function unsubscribe(env: AccountsEnv, token: string): Promise<string | null> {
  const row = await env.ACCOUNTS.prepare("SELECT email FROM subscribers WHERE unsub_token = ?").bind(token).first<{ email: string }>();
  if (!row) return null;
  await env.ACCOUNTS.prepare("UPDATE subscribers SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE unsub_token = ?").bind(iso(), token).run();
  return row.email;
}
