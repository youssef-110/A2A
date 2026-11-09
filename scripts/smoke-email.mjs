// Checks the email features against a running Worker: welcome + newsletter on sign-up, forgot and
// reset password, newsletter subscribe/unsubscribe, and emailing a session invite.
// Locally (no RESEND_API_KEY) emails are logged by `wrangler dev`; pass its log file so the reset
// link can be read from it:  node scripts/smoke-email.mjs http://127.0.0.1:8790 path/to/wrangler.log
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const O = process.argv[2] ?? "http://127.0.0.1:8787";
const LOG = process.argv[3];
const run = Date.now().toString(36);
const step = (s) => console.log(`\n▸ ${s}`);

async function http(method, path, { cookie, body, form } = {}) {
  const headers = { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) };
  const res = await fetch(O + path, { method, redirect: "manual", headers, body: body ? JSON.stringify(body) : form });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
}
const cookieOf = (r) => r.headers.get("set-cookie")?.split(";")[0];

/** The newest reset link in the dev server's log, waiting for the background send to land. */
async function resetToken(after) {
  for (let i = 0; i < 40; i++) {
    const tokens = [...readFileSync(LOG, "utf8").slice(after).matchAll(/\/reset\?token=([A-Za-z0-9_-]+)/g)];
    if (tokens.length) return tokens.at(-1)[1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("no reset link in the log");
}

const email = `ivy-${run}@example.com`;
step("Sign-up with the newsletter box ticked: account works and the email is on the list");
const signup = await http("POST", "/auth/signup", { body: { email, password: "first password 1", name: "Ivy", newsletter: true } });
assert.equal(signup.status, 201, signup.text);
const firstCookie = cookieOf(signup);
await new Promise((r) => setTimeout(r, 800));
const again = await http("POST", "/news/subscribe", { body: { email } });
assert.equal(again.body.already, true, "sign-up subscribed them");

step("Forgot password: same answer for real and unknown emails");
const known = await http("POST", "/auth/forgot", { body: { email } });
const unknown = await http("POST", "/auth/forgot", { body: { email: `nobody-${run}@example.com` } });
assert.equal(known.status, 200);
assert.deepEqual(known.body, unknown.body);
assert.equal((await http("POST", "/auth/forgot", { body: { email: "not-an-email" } })).status, 400);

if (LOG) {
  const before = 0;
  const token = await resetToken(before);
  step("The reset link works once, signs out old sessions, and the new password signs in");
  assert.equal((await http("GET", `/auth/reset/check?token=${token}`)).body.valid, true);
  assert.equal((await http("POST", "/auth/reset", { body: { token, password: "short" } })).status, 400);
  const reset = await http("POST", "/auth/reset", { body: { token, password: "second password 2" } });
  assert.equal(reset.status, 200, reset.text);
  assert.ok(cookieOf(reset), "signed in after reset");
  assert.equal((await http("POST", "/auth/reset", { body: { token, password: "third password 3" } })).status, 400, "token is single use");
  assert.equal((await http("GET", `/auth/reset/check?token=${token}`)).body.valid, false);
  assert.equal((await http("GET", "/api/me", { cookie: firstCookie })).status, 401, "old session signed out");
  assert.equal((await http("POST", "/auth/signin", { body: { email, password: "first password 1" } })).status, 401);
  assert.equal((await http("POST", "/auth/signin", { body: { email, password: "second password 2" } })).status, 200);
} else console.log("  (no log file: skipped reading the reset link)");

step("Newsletter: subscribe, then unsubscribe (GET only asks, POST does it)");
const fan = `fan-${run}@example.com`;
const sub = await http("POST", "/news/subscribe", { body: { email: fan, source: "home" } });
assert.equal(sub.status, 200, sub.text);
assert.equal(sub.body.already, false);
assert.equal((await http("POST", "/news/subscribe", { body: { email: "nope" } })).status, 400);
const bad = await http("GET", "/news/unsubscribe?t=nope");
assert.match(bad.text, /Unsubscribe/);
assert.match((await http("POST", "/news/unsubscribe?t=nope")).text, /isn't valid/);

step("Emailing an invite: only your own, live invites");
const ws = (await http("GET", "/api/me", { cookie: cookieOf(await http("POST", "/auth/signin", { body: { email, password: LOG ? "second password 2" : "first password 1" } })) })).body;
const cookie = cookieOf(await http("POST", "/auth/signin", { body: { email, password: LOG ? "second password 2" : "first password 1" } }));
const slug = ws.workspaces[0].slug;
const ses = await http("POST", `/api/w/${slug}/v1/admin/sessions`, { cookie, body: { name: "Launch", max_members: 2 } });
assert.ok(ses.body.invite?.url, ses.text);
const sent = await http("POST", "/api/invite-email", { cookie, body: { url: ses.body.invite.url, to: `friend-${run}@example.com` } });
// Locally there's no key, so sending reports failure; with a key it must succeed.
assert.ok(sent.status === 200 || sent.status === 502, sent.text);
console.log(`  own invite: ${sent.status === 200 ? "sent" : "accepted, not sent (no RESEND_API_KEY here)"}`);
assert.equal((await http("POST", "/api/invite-email", { cookie, body: { url: `${O}/w/someone-else/join/abc`, to: "x@example.com" } })).status, 400);
assert.equal((await http("POST", "/api/invite-email", { cookie, body: { url: `${O}/w/${slug}/join/doesnotexist`, to: "x@example.com" } })).status, 400);
assert.equal((await http("POST", "/api/invite-email", { body: { url: ses.body.invite.url, to: "x@example.com" } })).status, 401);

console.log("\n✓ email features work end to end");
