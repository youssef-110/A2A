// Auto-reply across people: two friends, each with their own client home, on one relay in sessions mode.
// Friend A turns auto-reply on for one agent in one session; everything else must stay manual.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateAgentKeyPair } from "@a2a/protocol";
import { Daemon, THREAD_RUNS_PER_HOUR } from "../packages/client/src/daemon.ts";
import { ipc } from "../packages/client/src/ipc.ts";
import { registerAgent, relayInfo } from "../packages/client/src/relay-api.ts";
import { saveConfig, writeKey, type AgentConfig } from "../packages/client/src/config.ts";
import { ECHO_AGENT, adminFetch, cleanup, relay, tempDir, waitFor } from "./helpers.ts";

// The relay ends a thread after a number of hops (40 on the hosted site). Here that is set high, so the
// client's own per-thread limit is what the ping-pong test meets.
const POLICY = "org: team\nregistration: invite\nisolation: sessions\nscopes:\n  general:\n    description: Anything.\nrules:\n  block: []\n  hold: []\n  redact: []\nlimits:\n  max_hops_per_thread: 100\n  max_messages_per_thread: 200\nguard:\n  judge: off\n";
const A_CODEX = "agent://team/ada-codex";
const A_CLAUDE = "agent://team/ada-claude";
const B_CLAUDE = "agent://team/ben-claude";
const ECHO = [process.execPath, ECHO_AGENT];

let r: Awaited<ReturnType<typeof relay>>;
let policyDir = "";
const homes: string[] = [];
const daemons: Daemon[] = [];
let x: { id: string; code: string };
let y: { id: string; code: string };
let z: { id: string; code: string };
let A = "";
let B = "";

async function session(name: string): Promise<{ id: string; code: string }> {
  const res = await adminFetch(r.url, "POST", "/v1/admin/sessions", { name, max_members: 10 });
  const invite = res.body.invite as { code: string };
  return { id: String(res.body.id), code: invite.code };
}

/** One friend's computer: keys made here, joined to sessions with invite links, `a2a run` started. */
async function friend(name: string, agents: Omit<AgentConfig, "key">[], invites: string[]): Promise<string> {
  const home = tempDir(name);
  homes.push(home);
  const configured: AgentConfig[] = [];
  for (const a of agents) {
    const { privateKeyPem } = generateAgentKeyPair();
    configured.push({ ...a, key: writeKey(home, a.address.split("/").pop()!, privateKeyPem) });
    for (const code of invites) await registerAgent(r.url, a.address, privateKeyPem, { invite: code, display_name: a.address.split("/").pop() });
  }
  saveConfig(home, { server: r.url, name, person: name, relay_public_key: (await relayInfo(r.url)).relay_public_key, default_agent: agents[0]!.address, agents: configured });
  const d = new Daemon({ home, log: process.env.A2A_TEST_LOG ? (l: string) => console.log(`[${name}] ${l}`) : () => {} });
  await d.start();
  await waitFor(() => d.info().connected === true, 5000, `${name} connect`);
  daemons.push(d);
  return home;
}

const runs = (home: string, agent: string): { auto: number; session_id: string | null; delivery_ms: number | null; start_ms: number | null; model_ms: number | null }[] => {
  const db = new DatabaseSync(join(home, "state.db"), { readOnly: true });
  try {
    return db.prepare("SELECT auto, session_id, delivery_ms, start_ms, model_ms FROM runs WHERE agent = ? ORDER BY started_at").all(agent) as never;
  } finally {
    db.close();
  }
};
const unhandled = async (home: string, agent: string): Promise<string[]> =>
  (await ipc<{ messages: { text: string; handled: number }[] }>(home, "GET", `/inbox?agent=${encodeURIComponent(agent)}`)).messages.filter((m) => !m.handled).map((m) => m.text);
const send = (to: string, text: string, extra: Record<string, unknown> = {}) =>
  ipc<Record<string, any>>(B, "POST", "/send", { from: B_CLAUDE, to, text, wait_seconds: 8, ...extra });
const sendNoWait = (to: string, text: string, extra: Record<string, unknown> = {}) =>
  ipc<Record<string, any>>(B, "POST", "/send", { from: B_CLAUDE, to, text, wait_seconds: 0, ...extra });
const listening = (sessionId: string, agent: string): boolean =>
  !!(r.relay.sessionDetail(sessionId)?.members as { address: string; auto_reply: boolean }[]).find((m) => m.address === agent)?.auto_reply;

before(async () => {
  policyDir = tempDir("auto-policy");
  writeFileSync(join(policyDir, "policy.yaml"), POLICY);
  r = await relay({ policyPath: join(policyDir, "policy.yaml"), judges: null });
  x = await session("Project X");
  y = await session("Friends");
  z = await session("Ben only");
  // Ada has a Codex and a Claude Code agent, both able to run headless, both in X and Friends. Nothing is turned on.
  A = await friend(
    "ada",
    [
      { address: A_CODEX, tool: "codex", runtime: "command", command: ECHO, auto_reply: [] },
      { address: A_CLAUDE, tool: "claude-code", runtime: "command", command: ECHO, auto_reply: [] },
    ],
    [x.code, y.code],
  );
  B = await friend("ben", [{ address: B_CLAUDE, tool: "claude-code", runtime: "none" }], [x.code, y.code, z.code]);
});

after(async () => {
  for (const d of daemons) await d.stop();
  await r?.close();
  cleanup(policyDir, r.dataDir, ...homes);
});

test("everything is manual by default: a new request waits in the inbox and no agent wakes", async () => {
  const res = await sendNoWait(A_CODEX, "hello before anything is on", { session: "Project X" });
  assert.match(String(res.state), /queued|delivered/);
  await waitFor(async () => (await unhandled(A, A_CODEX)).includes("hello before anything is on"), 5000, "inbox");
  assert.equal(runs(A, A_CODEX).length, 0);
  assert.equal(runs(A, A_CLAUDE).length, 0);
  assert.equal(listening(x.id, A_CODEX), false);
});

test("Ada turns on only her Codex in Project X; Ben's request there gets an automated reply", async () => {
  const on = await ipc<Record<string, any>>(A, "POST", "/auto-reply", { action: "on", session: "Project X", agents: ["ada-codex"], max_per_hour: 2 });
  assert.deepEqual(on.changed, [A_CODEX]);
  const row = (on.matrix as Record<string, any>[]).find((m) => m.agent === A_CODEX && m.session_id === x.id);
  assert.equal(row?.enabled, true);
  assert.equal((on.matrix as Record<string, any>[]).find((m) => m.agent === A_CLAUDE && m.session_id === x.id)?.enabled, false);
  assert.equal((on.matrix as Record<string, any>[]).find((m) => m.agent === A_CODEX && m.session_id === y.id)?.enabled, false);
  // Ben's own relay page shows who is listening, as Ada's client reported it.
  await waitFor(() => listening(x.id, A_CODEX), 5000, "listening report");
  assert.equal(listening(x.id, A_CLAUDE), false);
  assert.equal(listening(y.id, A_CODEX), false);

  const res = await send(A_CODEX, "What's the status of the API?", { session: "Project X" });
  assert.ok(res.reply, `expected an auto-reply, got ${JSON.stringify(res)}`);
  assert.match(res.reply.text, /ada-codex received your request/);
  assert.equal(res.reply.automated, true, "the reply is marked automated");
  assert.equal(res.reply.session?.name, "Project X", "the reply stays in the session");
  const [run] = runs(A, A_CODEX);
  assert.equal(run?.auto, 1);
  assert.equal(run?.session_id, x.id);
  assert.ok(run!.delivery_ms !== null && run!.start_ms !== null && run!.model_ms !== null, "latencies are recorded separately");
});

test("Ada's other agents don't wake, even in the same session", async () => {
  const res = await send(A_CLAUDE, "Claude, are you there?", { session: "Project X", wait_seconds: 1 });
  assert.equal(res.timed_out, true);
  assert.equal(runs(A, A_CLAUDE).length, 0);
  assert.ok((await unhandled(A, A_CLAUDE)).includes("Claude, are you there?"));
});

test("in a session Ada didn't opt into, nothing wakes", async () => {
  const before = runs(A, A_CODEX).length;
  const res = await send(A_CODEX, "Movie tonight?", { session: "Friends", wait_seconds: 1 });
  assert.equal(res.timed_out, true);
  assert.equal(runs(A, A_CODEX).length, before);
  assert.ok((await unhandled(A, A_CODEX)).includes("Movie tonight?"));
});

test("a message that could belong to either shared session doesn't start a run", async () => {
  const before = runs(A, A_CODEX).length;
  const res = await send(A_CODEX, "No session named", { wait_seconds: 1 });
  assert.equal(res.timed_out, true);
  assert.equal(runs(A, A_CODEX).length, before);
});

test("a sender can't claim a session the recipient isn't in", async () => {
  const res = await sendNoWait(A_CODEX, "pretend this is Ben only", { session: z.id });
  assert.equal(res.state, "blocked");
  assert.equal(res.reason_code, "not_in_session");
});

test("a message the sender doesn't wait for is answered too; the hourly limit and requests from inside a run still hold", async () => {
  const before = runs(A, A_CODEX).length;
  // An app that doesn't block on the answer sends a notify. Where Ada's agent listens it is answered
  // like a request, and the answer waits in Ben's inbox. It is the second run of the hour (limit 2).
  await sendNoWait(A_CODEX, "not waiting, but tell me", { session: "Project X", kind: "notify", expects_reply: false });
  await waitFor(async () => (await unhandled(B, B_CLAUDE)).some((t) => /ada-codex received your notify/.test(t)), 8000, "the answer to a message nobody waited on");
  const third = await send(A_CODEX, "third question", { session: "Project X", wait_seconds: 1 });
  assert.equal(third.timed_out, true);
  assert.equal(runs(A, A_CODEX).length, before + 1);
  assert.ok((await unhandled(A, A_CODEX)).includes("third question"));
  // A headless run (or a message pretending to be one) can't turn anything on.
  await assert.rejects(ipc(A, "POST", "/auto-reply", { action: "on", session: "Friends", agents: ["ada-claude"], run_id: "run_fake" }), /can't change auto-reply/);
  await assert.rejects(ipc(A, "POST", "/auto-reply", { action: "on", agents: ["ada-claude"] }), /Name the session/);
});

test("turning Ada's Codex off stops it at once; new messages stay in the inbox", async () => {
  const off = await ipc<Record<string, any>>(A, "POST", "/auto-reply", { action: "off", agents: ["ada-codex"] });
  assert.deepEqual(off.changed, [A_CODEX]);
  await waitFor(() => !listening(x.id, A_CODEX), 5000, "listening cleared");
  const before = runs(A, A_CODEX).length;
  const res = await send(A_CODEX, "after it was turned off", { session: "Project X", wait_seconds: 1 });
  assert.equal(res.timed_out, true);
  assert.equal(runs(A, A_CODEX).length, before);
  assert.ok((await unhandled(A, A_CODEX)).includes("after it was turned off"));
});

test("the workspace owner's agents count as members of every session, and another agent's automated request never starts a run", async () => {
  // The owner's agent is in every session without a membership row.
  const inv = await adminFetch(r.url, "POST", "/v1/admin/invites", { owner: true, max_uses: 1 });
  const IVY = "agent://team/ivy-codex";
  const ivy = await friend("ivy", [{ address: IVY, tool: "codex", runtime: "command", command: ECHO }], [String((inv.body as { code: string }).code)]);
  const on = await ipc<Record<string, any>>(ivy, "POST", "/auto-reply", { action: "on", session: "Project X", agents: ["ivy-codex"] });
  assert.deepEqual(on.changed, [IVY]);
  await waitFor(() => listening(x.id, IVY), 5000, "owner listening report");

  const res = await send(IVY, "Owner, are you around?", { session: "Project X" });
  assert.ok(res.reply, `expected the owner's agent to auto-reply, got ${JSON.stringify(res)}`);
  assert.equal(res.reply.session?.id, x.id);

  // A request marked as written by another agent's auto-run is a possible loop: it waits in the inbox.
  const looped = await send(IVY, "automated follow-up", { session: "Project X", auto: true, wait_seconds: 1 });
  assert.equal(looped.timed_out, true);
  assert.equal(runs(ivy, IVY).length, 1);
  assert.ok((await unhandled(ivy, IVY)).includes("automated follow-up"));

  // The owner typing in the dashboard ("You") is answered too. The console is in every session, so the
  // relay names the one Ivy listens in; a message typed on a session page names that session.
  const typed = await adminFetch(r.url, "POST", "/v1/admin/console/send", { to: IVY, text: "From the dashboard" });
  assert.equal(typed.status < 300, true, JSON.stringify(typed.body));
  await waitFor(() => runs(ivy, IVY).length === 2, 8000, "a run for the owner's dashboard message");
  await adminFetch(r.url, "POST", "/v1/admin/console/send", { to: IVY, text: "From the session page", session: x.id });
  await waitFor(() => runs(ivy, IVY).length === 3, 8000, "a run for the session page message");
  assert.equal(runs(ivy, IVY).at(-1)!.session_id, x.id);
  // What the owner typed on the session page, and the answer, show on that page (and only there).
  const shown = (id: string): string[] => (r.relay.sessionDetail(id)!.messages as { text: string }[]).map((m) => m.text);
  await waitFor(() => shown(x.id).some((t) => /ivy-codex received your request: "From the session page"/.test(t)), 5000, "the answer on the session page");
  assert.ok(shown(x.id).includes("From the session page"));
  assert.ok(!shown(y.id).includes("From the session page"));
  await ipc(ivy, "POST", "/auto-reply", { action: "off", all: true });
});

test("a job given from the session page wakes the coordinator only if its owner lets it listen in that session", async () => {
  await ipc(A, "POST", "/auto-reply", { action: "on", session: "Project X", agents: ["ada-claude"] });
  const claudeBefore = runs(A, A_CLAUDE).length;
  const codexBefore = runs(A, A_CODEX).length;
  // Ada's Claude listens in Project X: the mission note starts a run there, without autopilot.
  const ok = await adminFetch(r.url, "POST", "/v1/admin/tasks/kickoff", { to: A_CLAUDE, mission: "Write a two-line project summary.", session_id: x.id });
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  await waitFor(() => runs(A, A_CLAUDE).length === claudeBefore + 1, 8000, "coordinator run");
  // Her Codex doesn't listen anywhere now: the same job waits in its inbox.
  await adminFetch(r.url, "POST", "/v1/admin/tasks/kickoff", { to: A_CODEX, mission: "Write a two-line project summary.", session_id: x.id });
  await waitFor(async () => (await unhandled(A, A_CODEX)).some((t) => t.startsWith("[a2a-mission]")), 5000, "mission in the inbox");
  assert.equal(runs(A, A_CODEX).length, codexBefore);
  // Task work spends the session's auto-reply budget: with the hour's one run used, the next job waits.
  await ipc(A, "POST", "/auto-reply", { action: "on", session: "Project X", agents: ["ada-claude"], max_per_hour: 1 });
  await adminFetch(r.url, "POST", "/v1/admin/tasks/kickoff", { to: A_CLAUDE, mission: "Over the budget.", session_id: x.id });
  await waitFor(async () => (await unhandled(A, A_CLAUDE)).some((t) => t.includes("Over the budget.")), 5000, "the capped mission in the inbox");
  assert.equal(runs(A, A_CLAUDE).length, claudeBefore + 1);
  await ipc(A, "POST", "/auto-reply", { action: "off", all: true });
});

test("two agents that both listen answer a person's message once and then stop: no ping-pong", async () => {
  const KAI = "agent://team/kai-codex";
  const kai = await friend("kai", [{ address: KAI, tool: "codex", runtime: "command", command: ECHO }], [y.code]);
  await ipc(kai, "POST", "/auto-reply", { action: "on", session: "Friends", agents: ["kai-codex"] });
  await ipc(A, "POST", "/auto-reply", { action: "on", session: "Friends", agents: ["ada-codex"] });
  await waitFor(() => listening(y.id, KAI) && listening(y.id, A_CODEX), 5000, "both listening in Friends");
  const adaBefore = runs(A, A_CODEX).length;
  const settle = () => new Promise((res) => setTimeout(res, 1200));
  const fromKai = (text: string, extra: Record<string, unknown> = {}) =>
    ipc<Record<string, any>>(kai, "POST", "/send", { from: KAI, to: A_CODEX, text, session: "Friends", kind: "notify", expects_reply: false, wait_seconds: 0, ...extra });

  // Kai's person has their app send one message and doesn't wait. Ada's agent answers it on its own.
  const first = await fromKai("Can you look at the build?");
  await waitFor(async () => (await unhandled(kai, KAI)).some((t) => /ada-codex received your notify/.test(t)), 8000, "Ada's automated answer in Kai's inbox");
  // That answer is automated and asks nothing back, so Kai's listening agent stays asleep: the exchange ends.
  await settle();
  assert.equal(runs(kai, KAI).length, 0, "an automated reply never wakes the other side");
  assert.equal(runs(A, A_CODEX).length, adaBefore + 1);

  // Whatever an auto-run sends on its own (marked automated) wakes nobody either, whatever its kind.
  await fromKai("automated follow-up", { auto: true });
  await ipc(kai, "POST", "/send", { from: KAI, to: A_CODEX, text: "automated question", session: "Friends", auto: true, wait_seconds: 0 });
  // A reply that asks nothing back is the end of an exchange, even from a person's own app.
  const answer = (await ipc<{ messages: { id: string; text: string }[] }>(kai, "GET", `/inbox?agent=${encodeURIComponent(KAI)}`)).messages.find((m) => /ada-codex received/.test(m.text))!;
  await ipc(kai, "POST", "/send", { from: KAI, to: A_CODEX, text: "thanks, got it", in_reply_to: answer.id, wait_seconds: 0 });
  await settle();
  assert.equal(runs(A, A_CODEX).length, adaBefore + 1, "automated messages and plain acknowledgements start nothing");

  // Even a sender that drops the automated mark can't keep a thread going: a set number of answers an hour, then it waits.
  const last = THREAD_RUNS_PER_HOUR + 1;
  for (let i = 0; i <= last; i++) await fromKai(`again ${i}`, { thread_id: first.thread_id });
  await waitFor(async () => (await unhandled(A, A_CODEX)).includes(`again ${last}`), 30_000, "the last one in Ada's inbox");
  await waitFor(() => runs(A, A_CODEX).length >= adaBefore + THREAD_RUNS_PER_HOUR, 30_000, "the allowed answers to run");
  await settle();
  assert.equal(runs(A, A_CODEX).length, adaBefore + THREAD_RUNS_PER_HOUR, "the thread limit holds for messages nobody waits on");
  assert.equal(runs(kai, KAI).length, 0);
  await ipc(kai, "POST", "/auto-reply", { action: "off", all: true });
  await ipc(A, "POST", "/auto-reply", { action: "off", all: true });
});

test("idle clients hold one relay connection each, run no timers, and start no model", async () => {
  const runsBefore = runs(A, A_CODEX).length + runs(A, A_CLAUDE).length;
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(runs(A, A_CODEX).length + runs(A, A_CLAUDE).length, runsBefore, "no runs while idle");
  for (const d of daemons) {
    const internals = d as unknown as { links: Map<string, unknown>; flushTimer?: unknown; running: Map<string, number> };
    assert.equal(internals.links.size, 1, "one connection per workspace");
    assert.equal(internals.flushTimer, undefined, "no outbox timer while the outbox is empty");
    assert.equal([...internals.running.values()].reduce((a, b) => a + b, 0), 0, "no model process");
  }
  assert.equal(r.hub.onlineAgents().filter((a) => a.startsWith("agent://team/ada-") || a === B_CLAUDE).length, 3);
});
