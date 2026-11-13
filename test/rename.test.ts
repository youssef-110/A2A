// Renaming: a person's agents are called <name>-<app>. They can change the name from their own
// computer (a2a rename) or from their dashboard; the agents keep their sessions, tasks and account.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKeyPair } from "@a2a/protocol";
import { Daemon } from "../packages/client/src/daemon.ts";
import { ipc } from "../packages/client/src/ipc.ts";
import { registerAgent, relayInfo } from "../packages/client/src/relay-api.ts";
import { loadConfig, saveConfig, writeKey, type AgentConfig } from "../packages/client/src/config.ts";
import { ADMIN, cleanup, relay, tempDir, waitFor } from "./helpers.ts";

const POLICY = "org: team\nregistration: invite\nisolation: sessions\nscopes:\n  general:\n    description: Anything.\nrules:\n  block: []\n  hold: []\n  redact: []\nguard:\n  judge: off\n";
const A = (n: string) => `agent://team/${n}`;

let r: Awaited<ReturnType<typeof relay>>;
let session = "";
const homes: string[] = [];
const daemons: Daemon[] = [];
let robin = "";
let juno = "";

/** One person's computer: their apps as <person>-<app>, in the session, signed in as `account`. */
async function computer(person: string, apps: string[], account: string): Promise<string> {
  const home = tempDir(person);
  homes.push(home);
  const agents: AgentConfig[] = [];
  for (const app of apps) {
    const address = A(`${person}-${app}`);
    const { privateKeyPem } = generateAgentKeyPair();
    agents.push({ address, key: writeKey(home, `${person}-${app}`, privateKeyPem), tool: app === "claude" ? "claude-code" : app, runtime: "none" });
    await registerAgent(r.url, address, privateKeyPem, { adminToken: ADMIN, display_name: `${person} (${app})` });
    r.relay.db.prepare("INSERT INTO session_members (session_id, address, joined_at) VALUES (?, ?, ?)").run(session, address, new Date().toISOString());
    r.relay.db.prepare("INSERT INTO agent_accounts (address, account_id, email, name) VALUES (?, ?, ?, ?)").run(address, account, `${person}@example.test`, person);
  }
  saveConfig(home, { server: r.url, name: person, person, relay_public_key: (await relayInfo(r.url)).relay_public_key, default_agent: agents[0]!.address, agents });
  const d = new Daemon({ home, log: () => {} });
  await d.start();
  await waitFor(() => d.info().connected === true, 5000, `${person} connect`);
  daemons.push(d);
  return home;
}

const online = (name: string): boolean => r.hub.onlineAgents().includes(A(name));
const members = (): string[] => (r.relay.sessionDetail(session)?.members as { address: string }[]).map((m) => m.address);

before(async () => {
  const dir = tempDir("rename-policy");
  homes.push(dir);
  writeFileSync(join(dir, "policy.yaml"), POLICY);
  r = await relay({ policyPath: join(dir, "policy.yaml"), judges: null });
  session = r.relay.createSession({ name: "Build" }, "admin").id;
  robin = await computer("robin", ["claude", "codex"], "acct_robin");
  juno = await computer("juno", ["claude"], "acct_juno");
});

after(async () => {
  for (const d of daemons) await d.stop();
  await r?.close();
  cleanup(r.dataDir, ...homes);
});

test("a2a rename: every agent takes the new name and keeps its sessions, tasks and account", async () => {
  // Robin's Codex has a part in a task, so there is something to carry over.
  const task = await ipc<Record<string, any>>(juno, "POST", "/tasks/create", { agent: A("juno-claude"), task: { title: "Docs", session_id: session, parts: [{ assignee: A("robin-codex"), title: "Write the intro" }] } });

  const out = await ipc<Record<string, any>>(robin, "POST", "/rename", { person: "Sam" });
  assert.deepEqual(out.renamed, [{ from: A("robin-claude"), to: A("sam-claude") }, { from: A("robin-codex"), to: A("sam-codex") }]);
  assert.deepEqual(out.failed, []);

  // On the relay the old names are gone, and nothing the agents had was left behind.
  assert.equal(r.relay.getAgent(A("robin-claude")), undefined);
  assert.equal(r.relay.getAgent(A("sam-claude"))?.display_name, "Sam (Claude Code)");
  assert.ok(members().includes(A("sam-claude")) && members().includes(A("sam-codex")) && !members().some((a) => a.includes("robin")));
  assert.equal(r.relay.accountOf(A("sam-codex"))?.account_id, "acct_robin");
  assert.equal((r.relay.tasks.detail(task.id)!.parts as { assignee: string }[])[0]!.assignee, A("sam-codex"));

  // This computer's config carries the new name, and its client is back online under it.
  const config = loadConfig(robin);
  assert.equal(config.person, "sam");
  assert.deepEqual(config.agents.map((a) => a.address), [A("sam-claude"), A("sam-codex")]);
  assert.equal(config.default_agent, A("sam-claude"));
  await waitFor(() => online("sam-claude") && online("sam-codex") && !online("robin-claude"), 8000, "sam's agents online");

  // The name Robin's agent gave up stays his: a stranger can't register it and pass as the agent people knew.
  await assert.rejects(registerAgent(r.url, A("robin-claude"), generateAgentKeyPair().privateKeyPem, { adminToken: ADMIN }), /name_retired/);
  assert.equal(r.relay.renameAgent(A("juno-claude"), { name: "robin-claude" }).status, 409);

  // A teammate reaches the agent by its new name, and it can still work on its part.
  const sent = await ipc<Record<string, any>>(juno, "POST", "/send", { from: A("juno-claude"), to: "sam-claude", text: "hello Sam", session, wait_seconds: 0 });
  assert.match(String(sent.state), /queued|delivered/);
  await waitFor(async () => (await ipc<{ messages: { text: string }[] }>(robin, "GET", `/inbox?agent=${encodeURIComponent(A("sam-claude"))}`)).messages.some((m) => m.text === "hello Sam"), 5000, "the message under the new name");
  const updated = await ipc<Record<string, any>>(robin, "POST", "/tasks/call", { agent: A("sam-codex"), task_id: task.id, action: "update", input: { note: "On it" } });
  assert.equal(updated.parts[0].status, "working");
});

test("a name someone already has is refused, and the agent keeps its own", async () => {
  const out = await ipc<Record<string, any>>(juno, "POST", "/rename", { person: "sam" });
  assert.deepEqual(out.renamed, []);
  assert.match(out.failed[0].why, /name_taken/);
  assert.ok(r.relay.getAgent(A("juno-claude")));
  // The relay itself refuses names that aren't addresses, and the console's.
  assert.equal(r.relay.renameAgent(A("juno-claude"), { name: "Not A Name" }).status, 400);
  assert.equal(r.relay.renameAgent(A("juno-claude"), { name: "console" }).status, 409);
  // A name every relay refused isn't kept for agents connected later either.
  assert.equal(loadConfig(juno).person, "juno");
});

test("from the dashboard: only the signed-in person's own online computers are asked, and they do the renaming", async () => {
  assert.deepEqual(r.relay.requestRename("acct_nobody", "riley"), { status: 409, error: "offline", detail: "None of your AI apps is connected here yet." });
  assert.equal((r.relay.requestRename("acct_robin", "  ") as { error: string }).error, "name_required");
  const asked = r.relay.requestRename("acct_robin", "Riley");
  assert.deepEqual(asked, { ok: true, asked: 2, offline: 0 });
  await waitFor(() => online("riley-claude") && online("riley-codex"), 8000, "riley's agents online");
  assert.equal(loadConfig(robin).person, "riley");
  // A relay that isn't the one an agent lives on can't have it renamed: the request names its own server.
  const elsewhere = await (daemons[0] as unknown as { renamePerson(b: Record<string, unknown>, server: string): Promise<Record<string, any>> }).renamePerson({ person: "mallory" }, "https://other-relay.example");
  assert.deepEqual(elsewhere.renamed, []);
  assert.equal(loadConfig(robin).person, "riley");
  assert.ok(!members().some((a) => a.includes("sam")) && r.relay.getAgent(A("juno-claude")), "nobody else was renamed");
  // A headless run can't rename anything.
  await assert.rejects(ipc(robin, "POST", "/rename", { person: "mallory", run_id: "run_fake" }), /headless run can't rename/);
  assert.match(readFileSync(join(robin, "config.yaml"), "utf8"), /person: riley/);
});
