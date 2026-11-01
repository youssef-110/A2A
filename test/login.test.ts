import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { login, LoginPendingError, pendingLogin } from "../packages/client/src/account.ts";
import { cleanup, tempDir } from "./helpers.ts";

process.env.A2A_NO_BROWSER = "1";

/** The website's device sign-in, scripted: each poll answers with the next entry of `polls`. */
async function fakeSite(polls: { status: number; body: Record<string, unknown> }[]) {
  const seen = { starts: 0, polls: 0 };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/auth/device/start") {
      seen.starts++;
      return res.end(JSON.stringify({ device_code: `device-${seen.starts}`.padEnd(40, "x"), user_code: `CODE-000${seen.starts}`, verify_url: `http://${req.headers.host}/link`, expires_in: 600 }));
    }
    if (req.url === "/auth/device/poll") {
      const next = polls[Math.min(seen.polls++, polls.length - 1)]!;
      res.statusCode = next.status;
      return res.end(JSON.stringify(next.body));
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "signed_out" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const approved = { status: 200, body: { status: "approved", session_token: "tok", workspace: "robin", user: { id: "usr_1", email: "robin@example.com", name: "Robin" } } };
const pending = { status: 200, body: { status: "pending" } };

test("an agent's sign-in stops waiting with a link to approve, and running it again resumes the same code", async () => {
  const site = await fakeSite([pending, approved]);
  const home = tempDir("login");
  const lines: string[] = [];
  try {
    await assert.rejects(login(home, site.origin, (l) => lines.push(l), 0), (err: unknown) => {
      assert.ok(err instanceof LoginPendingError);
      assert.match((err as Error).message, /Not approved yet\. Open http:\/\/127\.0\.0\.1:\d+\/link\?code=CODE-0001 \(code CODE-0001\)/);
      return true;
    });
    // The printed link has the code filled in, so the person only signs in and clicks Connect.
    assert.match(lines.join("\n"), /open http:\/\/127\.0\.0\.1:\d+\/link\?code=CODE-0001/);
    assert.equal(pendingLogin(home, site.origin)?.user_code, "CODE-0001");

    const account = await login(home, site.origin, () => {}, 0);
    assert.equal(account.user.email, "robin@example.com");
    assert.equal(site.seen.starts, 1, "the second run picked up the first code instead of starting a new one");
    assert.equal(pendingLogin(home, site.origin), null);
  } finally {
    await site.close();
    cleanup(home);
  }
});

test("a server error or rate limit while polling isn't taken as an expired code", async () => {
  const site = await fakeSite([{ status: 503, body: { error: "unavailable" } }, { status: 429, body: { error: "slow down" } }, approved]);
  const home = tempDir("login");
  try {
    const account = await login(home, site.origin, () => {}, 10_000);
    assert.equal(account.token, "tok");
    assert.equal(site.seen.starts, 1);
    assert.equal(site.seen.polls, 3);
  } finally {
    await site.close();
    cleanup(home);
  }
});

test("an expired code is replaced once with a new one", async () => {
  const site = await fakeSite([{ status: 200, body: { status: "expired" } }, approved]);
  const home = tempDir("login");
  const lines: string[] = [];
  try {
    const account = await login(home, site.origin, (l) => lines.push(l), 10_000);
    assert.equal(account.user.id, "usr_1");
    assert.equal(site.seen.starts, 2);
    assert.ok(lines.some((l) => l.includes("That code expired. Here is a new one.")));
  } finally {
    await site.close();
    cleanup(home);
  }
});
