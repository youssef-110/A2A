import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPerson, isAdmin } from "../packages/cloud/src/stats-rules.ts";

const get = (ua: string, headers: Record<string, string> = {}, method = "GET") => new Request("https://a2a.test/", { method, headers: { "user-agent": ua, ...headers } });
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15";

test("stats count people, not crawlers, previews or prefetches", () => {
  assert.equal(fromPerson(get(SAFARI)), true);
  assert.equal(fromPerson(get("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")), false);
  assert.equal(fromPerson(get("Slackbot-LinkExpanding 1.0")), false);
  assert.equal(fromPerson(get("curl/8.7.1")), false);
  assert.equal(fromPerson(get("")), false);
  assert.equal(fromPerson(get(SAFARI, { "sec-purpose": "prefetch;prerender" })), false);
  assert.equal(fromPerson(get(SAFARI, {}, "HEAD")), false);
});

test("only listed emails are stats admins, whatever their case", () => {
  const env = { A2A_ADMINS: "owner@example.com, Second@Example.com" };
  assert.equal(isAdmin(env, "OWNER@example.com"), true);
  assert.equal(isAdmin(env, "second@example.com"), true);
  assert.equal(isAdmin(env, "robin@example.com"), false);
  assert.equal(isAdmin({}, "owner@example.com"), false);
});
