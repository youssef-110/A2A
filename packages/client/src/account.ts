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
  const b = r.body as { device_code: string; user_code: string; verify_url: string; expires_in: number };
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  writeFileSync(pendingPath(home), JSON.stringify({ origin, device_code: b.device_code, user_code: b.user_code, verify_url: b.verify_url, expires_at: Date.now() + b.expires_in * 1000 }), { mode: 0o600 });
  return { user_code: b.user_code, verify_url: b.verify_url, expires_in: b.expires_in };
}

export function pendingLogin(home: string, origin: string): LoginStart | null {
  try {
    const p = JSON.parse(readFileSync(pendingPath(home), "utf8")) as { origin: string; user_code: string; verify_url: string; expires_at: number };
    if (p.origin !== origin || p.expires_at < Date.now()) return null;
    return { user_code: p.user_code, verify_url: p.verify_url, expires_in: Math.round((p.expires_at - Date.now()) / 1000) };
  } catch {
    return null;
  }
}

/** Step 2: waits (up to waitMs) for the person to approve. Returns null if they haven't yet. */
export async function finishLogin(home: string, origin: string, waitMs: number): Promise<Account | null> {
  const p = JSON.parse(readFileSync(pendingPath(home), "utf8")) as { origin: string; device_code: string; expires_at: number };
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await publicApi(origin, "POST", "/auth/device/poll", { device_code: p.device_code });
    const status = r.body.status as string | undefined;
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
    if (status === "expired" || r.status >= 400) {
      rmSync(pendingPath(home), { force: true });
      throw new Error("The sign-in code expired. Start again.");
    }
    if (Date.now() >= until) return null;
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/** Signs in from a terminal: prints the code, opens the browser and waits. */
export async function login(home: string, origin: string, say: (line: string) => void): Promise<Account> {
  const existing = await validAccount(home, origin);
  if (existing) return existing;
  const start = pendingLogin(home, origin) ?? (await startLogin(home, origin));
  say(`\n  Sign in to A2A: open ${start.verify_url}\n  and enter the code  ${start.user_code}\n`);
  openBrowser(start.verify_url);
  for (;;) {
    const a = await finishLogin(home, origin, 60_000);
    if (a) {
      say(`  Signed in as ${a.user.email}.`);
      return a;
    }
    say("  Still waiting for you to approve the code in the browser...");
  }
}

/** First name, lower-cased, usable in an agent address: "Sam Lee" -> "sam". */
export function personSlug(name: string | null | undefined, email: string): string {
  const base = (name?.trim().split(/\s+/)[0] || email.split("@")[0] || "agent").toLowerCase();
  return base.normalize("NFKD").replace(/[^a-z0-9._-]+/g, "").replace(/^[^a-z0-9]+/, "").slice(0, 24) || "agent";
}
