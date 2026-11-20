// The Stats page's two rules, kept free of Worker types so the Node tests can import them.

const BOT = /bot|crawl|spider|slurp|preview|scan|monitor|uptime|headless|lighthouse|curl|wget|python|go-http|java\/|okhttp|axios|node-fetch/i;

/** Requests from people, not crawlers, link previews or prefetches. */
export function fromPerson(req: Request): boolean {
  const ua = req.headers.get("user-agent") ?? "";
  if (req.method !== "GET" || !ua || BOT.test(ua)) return false;
  return !/prefetch|prerender/i.test(`${req.headers.get("sec-purpose") ?? ""} ${req.headers.get("purpose") ?? ""}`);
}

/** Whether this email is in A2A_ADMINS (comma-separated, any case). */
export function isAdmin(env: { A2A_ADMINS?: string }, email: string): boolean {
  const admins = (env.A2A_ADMINS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email.toLowerCase());
}
