import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { accountApi, publicApi } from "./relay-api.ts";

/** The hosted A2A. Self-hosted relays have no accounts. */
export const DEFAULT_ORIGIN = process.env.A2A_ORIGIN ?? "https://a2a-relay.a2a-cloud.workers.dev";

export interface Account {
  origin: string;
  token: string;
  user: { id: string; email: string; name: string | null };
  /** The person's own workspace (slug), where their agents are owner agents. */
  workspace: string;
}

export interface LoginStart {
  user_code: string;
  verify_url: string;
  /** verify_url with the code filled in: the person only has to click Connect. */
  verify_url_complete: string;
  expires_in: number;
}

const accountPath = (home: string): string => join(home, "account.json");
const pendingPath = (home: string): string => join(home, "run", "login.json");

export function loadAccount(home: string, origin?: string): Account | null {
  try {
    const a = JSON.parse(readFileSync(accountPath(home), "utf8")) as Account;
    return !origin || a.origin === origin ? a : null;
  } catch {
    return null;
  }
}

function saveAccount(home: string, account: Account): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(accountPath(home), JSON.stringify(account, null, 2), { mode: 0o600 });
}

/** Signs this computer out: the website forgets the token, then the local copy is deleted. */
export async function signOut(home: string): Promise<boolean> {
  const a = loadAccount(home);
  if (!a) return false;
  await accountApi(a.origin, a.token, "POST", "/auth/signout").catch(() => {});
  rmSync(accountPath(home), { force: true });
  return true;
}

/** The saved sign-in, if the website still accepts it. */
export async function validAccount(home: string, origin: string): Promise<Account | null> {
  const a = loadAccount(home, origin);
  if (!a) return null;
  const r = await accountApi(origin, a.token, "GET", "/api/me").catch(() => null);
  if (!r || r.status === 401) return null;
  if (r.status !== 200) return a; // the website is having trouble; keep the sign-in
  const ws = (r.body.workspaces as { slug: string; role: string }[] | undefined) ?? [];
  if (!ws.some((w) => w.slug === a.workspace) && ws[0]) a.workspace = ws[0].slug;
  return a;
}

export function openBrowser(url: string): void {
  if (process.env.A2A_NO_BROWSER) return;
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch {
    /* no browser here; the URL is printed too */
  }
}

/**
 * Step 1 of signing in: the website gives a short code; the person opens /link, signs in with
 * Google or email and types the code. The secret device code stays on this computer.
 */
export async function startLogin(home: string, origin: string): Promise<LoginStart> {
  const r = await publicApi(origin, "POST", "/auth/device/start", { host: `${hostname()} (a2a)` });
  if (r.status !== 200) throw new Error(String(r.body.error ?? `Sign-in failed to start (${r.status}).`));
  const b = r.body as { device_code: string; user_code: string; verify_url: string; verify_url_complete?: string; expires_in: number };
  const complete = b.verify_url_complete ?? `${b.verify_url}?code=${encodeURIComponent(b.user_code)}`;
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  writeFileSync(pendingPath(home), JSON.stringify({ origin, device_code: b.device_code, user_code: b.user_code, verify_url: b.verify_url, verify_url_complete: complete, expires_at: Date.now() + b.expires_in * 1000 }), { mode: 0o600 });
  return { user_code: b.user_code, verify_url: b.verify_url, verify_url_complete: complete, expires_in: b.expires_in };
}

export function pendingLogin(home: string, origin: string): LoginStart | null {
  try {
    const p = JSON.parse(readFileSync(pendingPath(home), "utf8")) as { origin: string; user_code: string; verify_url: string; verify_url_complete?: string; expires_at: number };
    // With under a minute left there's no time to sign in and approve: a fresh code is better.
    if (p.origin !== origin || p.expires_at < Date.now() + 60_000) return null;
    return { user_code: p.user_code, verify_url: p.verify_url, verify_url_complete: p.verify_url_complete ?? `${p.verify_url}?code=${p.user_code}`, expires_in: Math.round((p.expires_at - Date.now()) / 1000) };
  } catch {
    return null;
  }
}

/** Step 2: waits (up to waitMs) for the person to approve. Returns null if they haven't yet. */
export async function finishLogin(home: string, origin: string, waitMs: number): Promise<Account | null> {
  const p = JSON.parse(readFileSync(pendingPath(home), "utf8")) as { origin: string; device_code: string; expires_at: number };
  const until = Date.now() + waitMs;
  for (;;) {
    // A network blip or a busy server (5xx, 429) isn't an answer: keep polling until the wait is up.
    const r = await publicApi(origin, "POST", "/auth/device/poll", { device_code: p.device_code }).catch(() => ({ status: 503, body: {} as Record<string, unknown> }));
    const transient = r.status === 429 || r.status >= 500;
    const status = transient ? undefined : (r.body.status as string | undefined);
    if (status === "approved") {
      const b = r.body as { session_token: string; workspace: string; user: Account["user"] };
      const account: Account = { origin, token: b.session_token, user: { id: b.user.id, email: b.user.email, name: b.user.name }, workspace: b.workspace };
      saveAccount(home, account);
      rmSync(pendingPath(home), { force: true });
      return account;
    }
    if (status === "denied") {
      rmSync(pendingPath(home), { force: true });
      throw new Error("The sign-in was denied in the browser.");
    }
    if (status === "expired" || (!transient && r.status >= 400)) {
      rmSync(pendingPath(home), { force: true });
      throw new Error("The sign-in code expired. Start again.");
    }
    if (Date.now() >= until) return null;
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/** The wait ran out before the person clicked Connect; the code is kept, so running again resumes. */
export class LoginPendingError extends Error {}

/**
 * Signs in from a terminal: opens the approval page with the code filled in and waits. maxWaitMs
 * bounds the wait for AI agents, whose shell tools time out. An expired code is replaced once.
 */
export async function login(home: string, origin: string, say: (line: string) => void, maxWaitMs = Infinity): Promise<Account> {
  const existing = await validAccount(home, origin);
  if (existing) return existing;
  const until = Date.now() + maxWaitMs;
  for (let attempt = 0; ; attempt++) {
    const resumed = pendingLogin(home, origin);
    const start = resumed ?? (await startLogin(home, origin));
    say(`\n  Sign in to A2A: open ${start.verify_url_complete}\n  (or open ${start.verify_url} and enter the code  ${start.user_code} )\n  Sign in with Google or email, check the code matches, then click Connect.\n`);
    if (!resumed) openBrowser(start.verify_url_complete);
    try {
      for (;;) {
        const a = await finishLogin(home, origin, Math.max(0, Math.min(60_000, until - Date.now())));
        if (a) {
          say(`  Signed in as ${a.user.email}.`);
          return a;
        }
        if (Date.now() >= until) throw new LoginPendingError(`Not approved yet. Open ${start.verify_url_complete} (code ${start.user_code}), click Connect, then run the same command again to finish.`);
        say("  Still waiting for you to click Connect in the browser...");
      }
    } catch (err) {
      if (err instanceof LoginPendingError || attempt > 0 || /denied/.test((err as Error).message)) throw err;
      say("  That code expired. Here is a new one.");
    }
  }
}

/** First name, lower-cased, usable in an agent address: "Robin Lee" -> "robin". */
export function personSlug(name: string | null | undefined, email: string): string {
  const base = (name?.trim().split(/\s+/)[0] || email.split("@")[0] || "agent").toLowerCase();
  return base.normalize("NFKD").replace(/[^a-z0-9._-]+/g, "").replace(/^[^a-z0-9]+/, "").slice(0, 24) || "agent";
}
