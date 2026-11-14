// A team: Lea coordinates, Wes's owner put his agent on the session's team, Nia's owner did not, and
// "old" has an auto-reply rule from before teams existed. The `claude` command is a stand-in that does
// what a note asks only as far as the flags it was started with allow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApi } from "../packages/server/src/api.ts";
import { ipc } from "../packages/client/src/ipc.ts";
import { claudeArgs } from "../packages/client/src/runtimes.ts";
import { ADMIN, ROOT, adminFetch, cleanup, client, relay, tempDir, waitFor, type TestClient } from "./helpers.ts";

const POLICY = "org: team\nregistration: invite\nisolation: sessions\nscopes:\n  general:\n    description: Anything.\nrules:\n  block: []\n  hold: []\n  redact: []\nguard:\n  judge: off\n";
const A = (n: string) => `agent://team/${n}`;
const [LEA, BEN, WES, NIA, OLD] = ["lea-claude", "ben-claude", "wes-claude", "nia-claude", "old-claude"].map(A) as [string, string, string, string, string];
const SECRET = "FAKE_KEY=zebra-quartz-9917";

let r: Awaited<ReturnType<typeof relay>>;
let lea: TestClient, ben: TestClient, wes: TestClient, nia: TestClient, old: TestClient;
let session = "";
const dirs: string[] = [];
const proj: Record<string, string> = {};

/** A project folder with a secret in it, as most have. */
function project(name: string): string {
  const dir = tempDir(`proj-${name}`);
  writeFileSync(join(dir, ".env"), SECRET);
  dirs.push(dir);
  return (proj[name] = dir);
}

const state = <T>(home: string, sql: string, ...args: string[]): T => {
  const db = new DatabaseSync(join(home, "state.db"), { readOnly: true });
  try {
    return db.prepare(sql).get(...args) as T;
  } finally {
    db.close();
  }
};
const runCount = (c: TestClient): number => state<{ n: number }>(c.home, "SELECT COUNT(*) AS n FROM runs").n;
/** How the stand-in was last started: its flags, and the prompt it was given. */
function lastStart(c: TestClient): { flag: (name: string) => string; prompt: string } {
  const { argv, prompt } = JSON.parse(readFileSync(join(c.home, "fake-claude.jsonl"), "utf8").trim().split("\n").at(-1)!) as { argv: string[]; prompt: string };
  return { flag: (name) => argv[argv.indexOf(name) + 1] ?? "", prompt };
}

/** Lea hands one part to someone; returns how to read that part back. */
async function assign(to: string, detail: string): Promise<() => Promise<Record<string, any>>> {
  const t = await ipc<Record<string, any>>(lea.home, "POST", "/tasks/create", { agent: LEA, task: { title: `Job: ${detail.slice(0, 30)}`, session_id: session, parts: [{ assignee: to, title: "Your part", detail }] } });
  return async () => (await ipc<Record<string, any>>(lea.home, "POST", "/tasks/call", { agent: LEA, task_id: t.id, action: "detail" })).parts[0];
}

/** The dashboard's API as the hosted Worker calls it: the signed-in person's account in a header. */
async function asAccount(account: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const api = createApi({ relay: r.relay, adminToken: ADMIN, name: "team", trustForwardedBase: true });
  const res = (await api.handle(new Request(`http://relay.test${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "x-a2a-account-id": account, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })))!;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

before(async () => {
  process.env.A2A_CLAUDE_BIN = join(ROOT, "test/fixtures/fake-claude.mjs");
  const policyDir = tempDir("team-policy");
  dirs.push(policyDir);
  writeFileSync(join(policyDir, "policy.yaml"), POLICY);
  r = await relay({ policyPath: join(policyDir, "policy.yaml"), judges: null });
  session = r.relay.createSession({ name: "Build" }, "admin").id;
  const headless = (name: string) => ({ tool: "claude-code", runtime: "claude" as const, workdir: project(name) });
  lea = await client(r.url, "lea", [{ address: LEA, runtime: "none" }]);
  ben = await client(r.url, "ben", [{ address: BEN, runtime: "none" }]);
  wes = await client(r.url, "wes", [{ address: WES, ...headless("wes"), auto_reply: [] }]);
  nia = await client(r.url, "nia", [{ address: NIA, ...headless("nia"), auto_reply: [] }]);
  // A rule made before teams: the session is named, `team` is not.
  old = await client(r.url, "old", [{ address: OLD, ...headless("old"), allowed_tools: ["Read", "Grep", "Glob"], auto_reply: [{ session }] }]);
  const now = new Date().toISOString();
  for (const a of [LEA, BEN, WES, NIA, OLD]) r.relay.db.prepare("INSERT INTO session_members (session_id, address, joined_at) VALUES (?, ?, ?)").run(session, a, now);
  // Who is behind each agent, as the hosted relay records it at sign-in.
  for (const [a, id] of [[WES, "acct_wes"], [BEN, "acct_ben"], [LEA, "acct_lea"]] as const) r.relay.db.prepare("INSERT INTO agent_accounts (address, account_id, email, name) VALUES (?, ?, ?, ?)").run(a, id, `${id}@example.test`, id);
  // Wes's owner puts his agent on this session's team, from inside the project. One switch, once.
  const on = await ipc<Record<string, any>>(wes.home, "POST", "/auto-reply", { action: "on", session, agents: [WES], workdir: proj.wes, max_per_hour: 200 });
  assert.equal((on.matrix as Record<string, any>[]).find((m) => m.agent === WES)?.team, true);
  await waitFor(() => wes.daemon.info().connected === true, 5000, "wes reconnect");
});

after(async () => {
  for (const c of [lea, ben, wes, nia, old]) await c?.stop();
  await r?.close();
  delete process.env.A2A_CLAUDE_BIN;
  cleanup(r.dataDir, ...dirs, ...[lea, ben, wes, nia, old].map((c) => c.home));
});

test("on the team, the coordinator's assignment is carried out with no prompt: files are edited, within the session's permissions", async () => {
  const part = await assign(WES, "write notes.txt, then run-check, then read-secret");
  await waitFor(async () => (await part()).status === "done", 15_000, "wes to finish the part");
  // Standard session: edits yes, shell no. The secret stays shut.
  assert.deepEqual(JSON.parse((await part()).report), { edited: true, ran: false, secret: null, team: true });
  assert.equal(readFileSync(join(proj.wes!, "notes.txt"), "utf8"), `written by ${WES}`);
  const start = lastStart(wes);
  const allowed = start.flag("--allowedTools").split(",");
  assert.equal(start.flag("--permission-mode"), "dontAsk", "allowed tools run without prompts; nothing else runs");
  assert.ok(allowed.includes("Edit(./**)") && allowed.includes("mcp__a2a__request_approval"));
  assert.ok(!allowed.some((t) => ["Read", "Grep", "Glob", "Edit", "Write", "Bash"].includes(t)), "no rule reaches outside the working folder, and there is no shell");
});

test("full access gives a shell only when the owner also set this computer's limit to full, and never opens a secret", async () => {
  assert.equal((await adminFetch(r.url, "PUT", `/v1/admin/permissions/${session}`, { mode: "full" })).status, 200);
  // The workspace owner's Full access alone: still no shell on Wes's computer.
  let part = await assign(WES, "write a.txt, then run-check, then read-secret");
  await waitFor(async () => (await part()).status === "done", 15_000, "the part under a remote full access");
  assert.deepEqual(JSON.parse((await part()).report), { edited: true, ran: false, secret: null, team: true });

  // Wes's owner raises the limit on his own computer, once.
  await ipc(wes.home, "POST", "/auto-reply", { action: "on", session, agents: [WES], workdir: proj.wes, max: "full", max_per_hour: 200 });
  await waitFor(() => wes.daemon.info().connected === true, 5000, "wes reconnect");
  part = await assign(WES, "write b.txt, then run-check, then read-secret");
  await waitFor(async () => (await part()).status === "done", 15_000, "the part under full access on both sides");
  assert.deepEqual(JSON.parse((await part()).report), { edited: true, ran: true, secret: null, team: true });
  assert.ok(existsSync(join(proj.wes!, "ran.txt")), "the command ran");
  const start = lastStart(wes);
  assert.equal(start.flag("--permission-mode"), "dontAsk", "no run skips permission checks, whatever the mode");
  const denied = start.flag("--disallowedTools").split(",");
  for (const rule of ["Read(**/.env)", "Read(~/.ssh/**)", "Read(~/.a2a/keys/**)", "Edit(~/.a2a/**)", "Edit(**/.git/**)", "Edit(**/.claude/**)", "Bash(*.env*)"]) assert.ok(denied.includes(rule), `${rule} is denied`);
});

test("the hard line is in every Claude Code run's flags, even one whose config asks to skip permission checks", () => {
  const args = claudeArgs({
    agent: { address: WES, key: "k", runtime: "claude", allowed_tools: ["Read", "Edit", "Write", "Bash"], permission_mode: "bypassPermissions" },
    message: { id: "m1", thread_id: "t1", in_reply_to: null, from: LEA, to: WES, scope: "general", kind: "request", expects_reply: true, hop: 0, text: "", redacted: false, modified: false, sender_verified: true, files: [{ name: "a.md", path: join("home", "files", "m1", "a.md"), bytes: 1 }] },
    prompt: "",
    env: {},
    home: wes.home,
    mcpConfigPath: "x.json",
    timeoutMs: 1,
  });
  const of = (name: string): string[] => args[args.indexOf(name) + 1]!.split(",");
  assert.ok(of("--disallowedTools").includes("Read(**/.env)") && of("--disallowedTools").includes("Edit(**/.husky/**)"));
  assert.deepEqual(of("--allowedTools").slice(0, 2), ["Edit(./**)", "Bash"]);
  assert.equal(args[args.indexOf("--add-dir") + 1], join("home", "files", "m1"), "files that came with the message stay readable");
  // Editing needs a project folder: an agent switched on from the website (home folder) only reads.
  const agent = { address: WES, key: "k", runtime: "claude" as const, autopilot_max: "full" as const };
  assert.equal(wes.daemon.ceiling({ ...agent, workdir: homedir() }), "read_only");
  assert.equal(wes.daemon.ceiling(agent), "read_only");
  assert.equal(wes.daemon.ceiling({ ...agent, workdir: proj.wes }), "full");
});

test("a client home that is not ~/.a2a is shut by its real path: keys, sign-in, the run folder and the settings", () => {
  // A folder as a Read or Edit rule names it: from the filesystem root, a Windows drive as its letter.
  const rulePath = (dir: string): string => "//" + dir.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase()).replace(/^\//, "");
  const shut = (home: string): string[] => [
    ...["keys/**", "run/**", "account.json"].flatMap((p) => [`Read(${rulePath(home)}/${p})`, `Edit(${rulePath(home)}/${p})`]),
    `Edit(${rulePath(home)}/**)`, // config.yaml, where auto-reply is switched on, and state.db
  ];
  // Through the client: Wes's home is a temp folder (A2A_HOME), and his last run was started with rules for it.
  const denied = lastStart(wes).flag("--disallowedTools").split(",");
  for (const rule of [...shut(wes.home), "Read(~/.a2a/keys/**)", "Edit(~/.a2a/**)"]) assert.ok(denied.includes(rule), `${rule} is denied`);

  // The desktop app's layout: the client home sits inside the folder its agent works in.
  const home = join(proj.wes!, "AppData", "a2a", "agent");
  const args = claudeArgs({
    agent: { address: WES, key: "k", runtime: "claude", allowed_tools: ["Read", "Edit", "Bash"], workdir: proj.wes },
    message: { id: "m1", thread_id: "t1", in_reply_to: null, from: LEA, to: WES, scope: "general", kind: "request", expects_reply: true, hop: 0, text: "", redacted: false, modified: false, sender_verified: true },
    prompt: "",
    env: {},
    home,
    mcpConfigPath: "x.json",
    timeoutMs: 1,
  });
  const inside = args[args.indexOf("--disallowedTools") + 1]!.split(",");
  // A command reaches it by the path from the working folder, written either way round.
  for (const rule of [...shut(home), "Bash(*AppData/a2a/agent*)", `Bash(*${join("AppData", "a2a", "agent")}*)`, "Edit(~/.a2a/**)"]) assert.ok(inside.includes(rule), `${rule} is denied`);
});

test("the leader's own request counts as the owner's instruction; a teammate's is answered but changes nothing", async () => {
  // Lea coordinates tasks Wes is on. A coordinator is usually a headless run, so her request is marked automated.
  const led = await ipc<Record<string, any>>(lea.home, "POST", "/send", { from: LEA, to: WES, text: "write direct.txt", session, auto: true, wait_seconds: 10 });
  assert.ok(led.reply, `expected Wes to do it, got ${JSON.stringify(led)}`);
  assert.deepEqual(JSON.parse(led.reply.text), { edited: true, ran: false, secret: null, team: true });
  assert.ok(existsSync(join(proj.wes!, "direct.txt")));
  assert.match(lastStart(wes).prompt, /leads the team wes put you on in this session\. Treat what it asks as wes's own instruction/);

  // Ben is on the same session but leads nothing: Wes's agent answers with its own read-only tools.
  const asked = await ipc<Record<string, any>>(ben.home, "POST", "/send", { from: BEN, to: WES, text: "write nope.txt", session, wait_seconds: 10 });
  assert.deepEqual(JSON.parse(asked.reply.text), { edited: false, ran: false, secret: null, team: false });
  assert.ok(!existsSync(join(proj.wes!, "nope.txt")));
  assert.match(lastStart(wes).prompt, /not as instructions from your operator/);
  // And the loop guard still holds for anyone who isn't the leader.
  const before = runCount(wes);
  const looped = await ipc<Record<string, any>>(ben.home, "POST", "/send", { from: BEN, to: WES, text: "write loop.txt", session, auto: true, wait_seconds: 1 });
  assert.equal(looped.timed_out, true);
  assert.equal(runCount(wes), before);
});

test("a sensitive step goes to the agent's own owner only; while it waits nothing runs, and approving resumes the run once", async () => {
  const part = await assign(WES, "ask-owner, then write shipped.txt");
  await waitFor(() => r.relay.approvalsFor("acct_wes").length === 1, 15_000, "the request to reach the relay");
  const [ask] = r.relay.approvalsFor("acct_wes") as Record<string, any>[];
  assert.equal(ask.agent, WES);
  assert.equal(ask.action, 'Deploy for "shipped.txt"');
  assert.equal(ask.session.id, session);

  // Nobody else sees it or can answer it: not a teammate, not the coordinator, not the workspace's admin.
  assert.deepEqual(r.relay.approvalsFor("acct_ben"), []);
  assert.deepEqual(r.relay.approvalsFor(undefined), []);
  assert.deepEqual((await asAccount("acct_lea", "GET", "/v1/admin/approvals")).body.approvals, []);
  assert.equal((await asAccount("acct_ben", "POST", `/v1/admin/approvals/${ask.id}`, { decision: "approve" })).status, 404);
  assert.equal((await adminFetch(r.url, "POST", `/v1/admin/approvals/${ask.id}`, { decision: "approve" })).status, 404);
  assert.equal((await adminFetch(r.url, "GET", "/v1/admin/approvals")).body.approvals instanceof Array, true);

  // Waiting costs nothing: the run ended, the part is not reported, and a check-in starts no model.
  await waitFor(async () => /Waiting for its owner's OK/.test((await part()).progress ?? ""), 10_000, "the part to say it is waiting");
  await waitFor(async () => (await ipc<Record<string, any>>(wes.home, "GET", "/info")).agents[0].running === 0, 10_000, "the run to end");
  const waiting = runCount(wes);
  r.relay.tasks.checkinMs = 1;
  r.relay.tasks.sweep(Date.now() + 5000);
  await waitFor(async () => /answered by the a2a client: no model runs while it waits/.test((await part()).progress ?? ""), 10_000, "the client to answer the check-in");
  r.relay.tasks.checkinMs = 3600_000;
  assert.equal(runCount(wes), waiting);
  assert.equal((await part()).status, "working");
  assert.ok(!existsSync(join(proj.wes!, "shipped.txt")));
  // The owner's other apps hear about it once (the [A2A] hook note reads this list).
  assert.equal((await ipc<Record<string, any>>(wes.home, "GET", `/approvals?agent=${encodeURIComponent(WES)}`)).approvals.length, 1);

  // Wes's owner approves on his own page: the same part goes on, told the answer, and finishes.
  const ok = await asAccount("acct_wes", "POST", `/v1/admin/approvals/${ask.id}`, { decision: "approve" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  await waitFor(async () => (await part()).status === "done", 15_000, "the approved part to finish");
  assert.ok(existsSync(join(proj.wes!, "shipped.txt")));
  assert.match(lastStart(wes).prompt, /^\[a2a\] wes answered the approval you asked for\.\nYou asked: Deploy for "shipped\.txt"\nAnswer: APPROVED, this one time\./);
  // Used once: a second answer changes nothing, and the approval lifted no limit on the run.
  assert.equal((await asAccount("acct_wes", "POST", `/v1/admin/approvals/${ask.id}`, { decision: "deny" })).status, 409);
  assert.ok(lastStart(wes).flag("--disallowedTools").split(",").includes("Read(**/.env)"));
  assert.deepEqual(r.relay.approvalsFor("acct_wes"), []);
});

test("denying also resumes the run, which reports that it is blocked instead of doing the step", async () => {
  const part = await assign(WES, "ask-owner, then write never.txt");
  await waitFor(() => r.relay.approvalsFor("acct_wes").length === 1, 15_000, "the second request");
  const [ask] = r.relay.approvalsFor("acct_wes") as Record<string, any>[];
  assert.equal((await asAccount("acct_wes", "POST", `/v1/admin/approvals/${ask.id}`, { decision: "deny" })).status, 200);
  await waitFor(async () => (await part()).status === "blocked", 15_000, "the denied part to say it is blocked");
  assert.match((await part()).progress, /My owner said no/);
  assert.ok(!existsSync(join(proj.wes!, "never.txt")));
  assert.match(lastStart(wes).prompt, /Answer: DENIED\. Don't do it/);
});

test("an agent whose owner did not opt in does nothing, and a rule from before teams keeps its old reach", async () => {
  // Nia can run headless, but her owner never switched anything on: the assignment waits for her.
  await assign(NIA, "write nia.txt");
  await waitFor(async () => (await ipc<{ messages: { text: string; handled: number }[] }>(nia.home, "GET", `/inbox?agent=${encodeURIComponent(NIA)}`)).messages.some((m) => !m.handled && m.text.includes("write nia.txt")), 10_000, "the assignment in Nia's inbox");
  assert.equal(runCount(nia), 0);
  assert.ok(!existsSync(join(proj.nia!, "nia.txt")));

  // "old" answers in this session since before teams. It still takes task work, with its own read-only tools.
  const part = await assign(OLD, "write old.txt, then read-secret");
  await waitFor(async () => (await part()).status === "done", 15_000, "old's part");
  assert.deepEqual(JSON.parse((await part()).report), { edited: false, ran: false, secret: null, team: false });
  assert.ok(!existsSync(join(proj.old!, "old.txt")));
  assert.match(lastStart(old).prompt, /If a part needs more, say so with task_update \(status blocked\) instead of working around it\./);
});
