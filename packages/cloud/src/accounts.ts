/**
 * Website accounts on D1: email + password and Google sign-in, cookie sessions, and workspaces.
 * A workspace is one relay (one Durable Object); its slug is the agent org, agent://<slug>/<name>.
 */

export interface AccountsEnv {
  ACCOUNTS: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
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

export async function createSession(env: AccountsEnv, userId: string, secure: boolean): Promise<string> {
  const token = randomToken();
  await env.ACCOUNTS.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, iso(), iso(Date.now() + SESSION_DAYS * 86_400_000))
    .run();
  return cookie(COOKIE, token, SESSION_DAYS * 86_400, secure);
}

export async function currentUser(env: AccountsEnv, req: Request): Promise<User | null> {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  return env.ACCOUNTS.prepare(
    "SELECT u.id, u.email, u.name, u.avatar_url FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  )
    .bind(await sha256Hex(token), iso())
    .first<User>();
}

export async function endSession(env: AccountsEnv, req: Request, secure: boolean): Promise<string> {
  const token = readCookie(req, COOKIE);
  if (token) await env.ACCOUNTS.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return cookie(COOKIE, "", 0, secure);
}

// ------------------------------------------------------------------ sign-in throttling

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

export async function tooManyFailures(env: AccountsEnv, keys: string[]): Promise<boolean> {
  const since = iso(Date.now() - WINDOW_MS);
  for (const key of keys) {
    const r = await env.ACCOUNTS.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ? AND at > ?").bind(key, since).first<{ n: number }>();
    if ((r?.n ?? 0) >= MAX_FAILURES) return true;
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

/** The original single relay (Durable Object "relay", agent://acme) belongs to the legacy owner's account. */
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
  await attachLegacyRelay(env, row);
  return { id: row.id, email: row.email, name: row.name, avatar_url: row.avatar_url };
}

async function onFirstSignIn(env: AccountsEnv, user: User): Promise<void> {
  const first = (user.name ?? user.email).split(/\s+/)[0]!;
  await createWorkspace(env, user.id, `${first}'s workspace`, first);
  await attachLegacyRelay(env, user);
}

// ------------------------------------------------------------------ Google sign-in

export const googleEnabled = (env: AccountsEnv): boolean => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export async function googleStart(env: AccountsEnv, url: URL, next: string): Promise<Response> {
  const state = randomToken(18);
  const verifier = randomToken(32);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${url.origin}/auth/google/callback`,
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
  if (!state || !verifier || url.searchParams.get("state") !== state) return { error: "The sign-in link expired. Try again." };
  const code = url.searchParams.get("code");
  if (!code) return { error: "Google sign-in was cancelled." };
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${url.origin}/auth/google/callback`,
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

  let user = await env.ACCOUNTS.prepare("SELECT id, email, name, avatar_url FROM users WHERE google_sub = ? OR email = ? ORDER BY google_sub IS NULL LIMIT 1")
    .bind(claims.sub, email)
    .first<User>();
  if (user) {
    await env.ACCOUNTS.prepare("UPDATE users SET google_sub = ?, avatar_url = COALESCE(?, avatar_url), name = COALESCE(name, ?) WHERE id = ?")
      .bind(claims.sub, claims.picture ?? null, claims.name ?? null, user.id)
      .run();
    await attachLegacyRelay(env, user);
  } else {
    user = { id: newId("usr"), email, name: claims.name ?? email.split("@")[0]!, avatar_url: claims.picture ?? null };
    await env.ACCOUNTS.prepare("INSERT INTO users (id, email, name, google_sub, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(user.id, email, user.name, claims.sub, user.avatar_url, iso())
      .run();
    await onFirstSignIn(env, user);
  }
  let next = "/app";
  try {
    const decoded = new TextDecoder().decode(fromB64url(nextB64 ?? ""));
    if (decoded.startsWith("/app")) next = decoded;
  } catch {
    /* default */
  }
  return { user, next };
}
