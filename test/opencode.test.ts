import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ipc } from "../packages/client/src/ipc.ts";
import { parseOpenCodeEvents } from "../packages/client/src/runtimes.ts";
import type { RunningRelay } from "../packages/server/src/index.ts";
import { ROOT, cleanup, client, relay, tempDir, type TestClient } from "./helpers.ts";

const BILLING = "agent://acme/billing-bot";
const SUPPORT = "agent://acme/support-triage";
const LOG = join(tempDir("opencode-log"), "calls.jsonl");
const WORKDIR = join(ROOT, "examples/workspaces/support");

let r: RunningRelay & { dataDir: string };
let a: TestClient;
let b: TestClient;

const calls = (): { args: string[]; cwd: string; config: any; env: { agent: string; run: string } }[] =>
  readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));

before(async () => {
  process.env.A2A_OPENCODE_BIN = join(ROOT, "test/fixtures/fake-opencode.mjs");
  process.env.FAKE_OPENCODE_LOG = LOG;
  r = await relay();
  a = await client(r.url, "laptop-a", [{ address: BILLING, runtime: "none" }]);
  b = await client(r.url, "server-b", [
    { address: SUPPORT, runtime: "opencode", workdir: WORKDIR, allowed_tools: ["Read", "Grep", "Glob"], model: "anthropic/claude-sonnet-5-5" },
  ]);
});

after(async () => {
  await a?.stop();
  await b?.stop();
  await r?.close();
  cleanup(r.dataDir, a.home, b.home);
  delete process.env.A2A_OPENCODE_BIN;
});

const send = (text: string, thread_id?: string) => ipc<Record<string, any>>(a.home, "POST", "/send", { to: SUPPORT, text, thread_id, wait_seconds: 10 });

test("opencode is started headless with the a2a tools and deny-by-default permissions", async () => {
  const res = await send("Did support promise customer 48213 a refund?");
  assert.equal(res.state, "delivered");
  assert.equal(res.reply.text, "Ticket T-1042: refund promised. (session ses_fake_1)"); // last text part, final snapshot

  const call = calls()[0]!;
  assert.deepEqual(call.args.slice(0, 4), ["run", "--format", "json", "--auto"]);
  assert.equal(call.args[call.args.indexOf("--dir") + 1], WORKDIR);
  assert.equal(call.args[call.args.indexOf("--model") + 1], "anthropic/claude-sonnet-5-5");
  assert.ok(!call.args.includes("--session"));
  assert.equal(call.args.at(-2), "--");
  assert.match(call.args.at(-1)!, /<a2a-message id="msg_/);
  assert.equal(call.env.agent, SUPPORT);

  const { mcp, permission } = call.config;
  assert.equal(mcp.a2a.type, "local");
  assert.equal(mcp.a2a.command.at(-1), "mcp");
  assert.equal(mcp.a2a.environment.A2A_AGENT, SUPPORT);
  assert.ok(mcp.a2a.timeout >= 60_000);
  assert.deepEqual(permission, { "*": "deny", external_directory: "deny", question: "deny", doom_loop: "deny", "a2a_*": "allow", read: "allow", grep: "allow", glob: "allow" });
});

test("a follow-up in the same thread resumes the OpenCode session", async () => {
  const first = await send("Which agent handled ticket T-1042 for the customer?");
  const res = await send("And when is the customer's refund due?", first.thread_id);
  assert.match(res.reply.text, /session ses_fake_1, resumed/);
  assert.equal(calls().at(-1)!.args[calls().at(-1)!.args.indexOf("--session") + 1], "ses_fake_1");
});

test("an OpenCode error is reported back to the sender instead of hanging", async () => {
  const res = await send("Customer refund question FAIL");
  assert.match(res.reply.text, /could not handle this message: No provider configured/);
});

test("the event parser keeps the final snapshot of the last text part", () => {
  const out = [
    '{"type":"text","sessionID":"ses_1","part":{"id":"a","text":"Reading files"}}',
    "not json",
    '{"type":"text","sessionID":"ses_1","part":{"id":"b","text":"Done"}}',
    '{"type":"text","sessionID":"ses_1","part":{"id":"b","text":"Done: 2 tickets"}}',
  ].join("\n");
  assert.deepEqual(parseOpenCodeEvents(out), { text: "Done: 2 tickets", sessionId: "ses_1", error: undefined });
});
