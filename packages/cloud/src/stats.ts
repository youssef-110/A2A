// Site stats for the owner's Stats page: daily counters in D1. No cookies, no IP addresses stored:
// unique visitors are a hash of a random daily salt + IP + browser, and both are deleted after a day.
import { fromPerson } from "./stats-rules.ts";

export { fromPerson, isAdmin } from "./stats-rules.ts";

export interface StatsEnv {
  ACCOUNTS: D1Database;
  A2A_ADMINS?: string; // comma-separated emails that may open the Stats page
}

const day = (ms = Date.now()): string => new Date(ms).toISOString().slice(0, 10);

const bumpSql = "INSERT INTO stats_daily (day, kind, key, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, kind, key) DO UPDATE SET n = n + 1";

/** Adds one to today's counter. Never throws: stats must not break a page. */
export async function bump(env: StatsEnv, kind: string, key: string): Promise<void> {
  try {
    await env.ACCOUNTS.prepare(bumpSql).bind(day(), kind, key.slice(0, 120)).run();
  } catch {
    /* stats are best effort */
  }
}

async function hash(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Today's salt, made on the first visit of the day (which also clears yesterday's visitors and salts). */
async function salt(env: StatsEnv, today: string): Promise<string> {
  const fresh = crypto.randomUUID();
  const made = await env.ACCOUNTS.prepare("INSERT OR IGNORE INTO stats_salts (day, salt) VALUES (?, ?)").bind(today, fresh).run();
  if (made.meta.changes) {
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare("DELETE FROM stats_salts WHERE day < ?").bind(today),
      env.ACCOUNTS.prepare("DELETE FROM stats_visitors WHERE day < ?").bind(today),
    ]);
    return fresh;
  }
  return (await env.ACCOUNTS.prepare("SELECT salt FROM stats_salts WHERE day = ?").bind(today).first<{ salt: string }>())?.salt ?? fresh;
}

/** One page view by a person: the page, where they came from, and (once a day) the visitor and their country. */
export async function trackView(env: StatsEnv, req: Request, url: URL, page: string): Promise<void> {
  if (!fromPerson(req)) return;
  try {
    const today = day();
    const writes = [env.ACCOUNTS.prepare(bumpSql).bind(today, "view", page)];
    let host = "";
    try {
      host = new URL(req.headers.get("referer") ?? "").hostname.replace(/^www\./, "");
    } catch {
      /* no referrer, or not a URL */
    }
    if (host && host !== url.hostname) writes.push(env.ACCOUNTS.prepare(bumpSql).bind(today, "ref", host.slice(0, 120)));
    await env.ACCOUNTS.batch(writes);
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    const id = await hash(`${await salt(env, today)}|${ip}|${req.headers.get("user-agent")}`);
    const seen = await env.ACCOUNTS.prepare("INSERT OR IGNORE INTO stats_visitors (day, id) VALUES (?, ?)").bind(today, id).run();
    if (!seen.meta.changes) return;
    const country = (req.headers.get("cf-ipcountry") ?? "").toUpperCase();
    await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare(bumpSql).bind(today, "visitor", "all"),
      ...(/^[A-Z]{2}$/.test(country) && country !== "XX" && country !== "T1" ? [env.ACCOUNTS.prepare(bumpSql).bind(today, "country", country)] : []),
    ]);
  } catch {
    /* stats are best effort */
  }
}

type Row = { day: string; kind: string; key: string; n: number };

/** Everything the Stats page shows, for the last `days` days (UTC). */
export async function report(env: StatsEnv, days: number) {
  const from = day(Date.now() - (days - 1) * 86_400_000);
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [counters, signups, accounts, lists] = await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare("SELECT day, kind, key, n FROM stats_daily WHERE day >= ?").bind(from),
    env.ACCOUNTS.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day").bind(from),
    env.ACCOUNTS.prepare(
      "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(DISTINCT user_id) FROM auth_sessions WHERE created_at >= ?) AS active7d, (SELECT COUNT(*) FROM workspaces) AS workspaces",
    ).bind(since7),
    env.ACCOUNTS.prepare("SELECT COALESCE(source, 'other') AS source, COUNT(*) AS n FROM subscribers WHERE unsubscribed_at IS NULL GROUP BY source"),
  ]);
  const rows = (counters!.results ?? []) as Row[];
  const signupByDay = new Map(((signups!.results ?? []) as { day: string; n: number }[]).map((r) => [r.day, r.n]));

  const daily = Array.from({ length: days }, (_, i) => {
    const d = day(Date.now() - (days - 1 - i) * 86_400_000);
    const sum = (kind: string) => rows.filter((r) => r.day === d && r.kind === kind).reduce((a, r) => a + r.n, 0);
    return { day: d, visitors: sum("visitor"), views: sum("view"), downloads: sum("download"), cli: sum("cli"), signins: sum("signin"), signups: signupByDay.get(d) ?? 0 };
  });
  const top = (kind: string, limit = 10) => {
    const by = new Map<string, number>();
    for (const r of rows) if (r.kind === kind) by.set(r.key, (by.get(r.key) ?? 0) + r.n);
    return [...by].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)).slice(0, limit);
  };
  const total = (k: keyof (typeof daily)[number]) => daily.reduce((a, d) => a + (d[k] as number), 0);
  return {
    from,
    to: day(),
    days,
    daily,
    totals: { visitors: total("visitors"), views: total("views"), downloads: total("downloads"), cli: total("cli"), signups: total("signups"), signins: total("signins") },
    downloads: ["windows", "mac", "linux"].map((os) => ({ key: os, n: top("download").find((t) => t.key === os)?.n ?? 0 })),
    cli: top("cli", 5),
    pages: top("view"),
    referrers: top("ref"),
    countries: top("country"),
    accounts: (accounts!.results?.[0] ?? { users: 0, active7d: 0, workspaces: 0 }) as { users: number; active7d: number; workspaces: number },
    lists: (lists!.results ?? []) as { source: string; n: number }[],
  };
}
