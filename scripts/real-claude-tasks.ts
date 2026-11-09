// Live check with real Claude Code workers (costs a few cents): a local relay, a coordinator and two
// `claude -p` agents on autopilot. Round 1 runs under Standard permissions (files, no shell) and has
// one worker ask the other a question; round 2 switches to Full access and needs the shell.
//
//   node --disable-warning=ExperimentalWarning scripts/real-claude-tasks.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HeuristicJudge } from "@a2a/guard";
import { startRelay } from "../packages/server/src/index.ts";
import { ipc } from "../packages/client/src/ipc.ts";
import { client, tempDir, waitFor } from "../test/helpers.ts";

const POLICY = "org: team\nregistration: invite\nisolation: sessions\nscopes:\n  general:\n    description: Anything.\nrules:\n  block: [instruction_override]\n  hold: []\n  redact: []\nguard:\n  judge: off\n";
const A = (n: string) => `agent://team/${n}`;
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const dataDir = tempDir("real-claude");
writeFileSync(join(dataDir, "policy.yaml"), POLICY);
const r = await startRelay({ dataDir, port: 0, adminToken: "test-admin-token", judges: { fast: new HeuristicJudge() }, policyPath: join(dataDir, "policy.yaml") });
const work = { juno: tempDir("juno-work"), wren: tempDir("wren-work") };
const worker = (name: "juno" | "wren") => ({
  address: A(`${name}-claude`),
  runtime: "claude" as const,
  autopilot: true,
  workdir: work[name],
  allowed_tools: ["Read", "Grep", "Glob"],
  max_concurrent: 2,
  timeout: "10m",
  model: process.env.A2A_TEST_MODEL ?? "sonnet",
});
const lead = await client(r.url, "robin", [{ address: A("robin-claude"), runtime: "none" }]);
const juno = await client(r.url, "juno", [worker("juno")]);
const wren = await client(r.url, "wren", [worker("wren")]);
const s = r.relay.createSession({ name: "Live" }, "admin");
r.relay.db.prepare("INSERT INTO owner_agents (address, added_at) VALUES (?, ?)").run(A("robin-claude"), new Date().toISOString());
for (const g of ["juno-claude", "wren-claude"]) r.relay.db.prepare("INSERT INTO session_members (session_id, address, joined_at) VALUES (?, ?, ?)").run(s.id, A(g), new Date().toISOString());
r.relay.on("event", (e: { type: string; data: any }) => e.type === "task" && log(`[board] ${String(e.data.actor).split("/").pop()} ${e.data.kind}: ${e.data.text}`));

const detail = (id: string) => ipc<Record<string, any>>(lead.home, "POST", "/tasks/call", { task_id: id, action: "detail" });
async function round(title: string, parts: { assignee: string; title: string; detail: string }[]) {
  const t = await ipc<Record<string, any>>(lead.home, "POST", "/tasks/create", { task: { title, parts } });
  log(`created ${t.id} under ${t.permissions.mode}`);
  await waitFor(async () => {
    const d = await detail(t.id);
    return d.status === "review" && d.votes.length >= 2;
  }, 12 * 60_000, `${title}: workers report and vote`);
  const done = await ipc<Record<string, any>>(lead.home, "POST", "/tasks/call", { task_id: t.id, action: "vote", input: { done: true } });
  log(`${title}: ${done.status}`);
  console.log(`\n${done.final_report}\n`);
  return done;
}

let ok = true;
const check = (cond: boolean, what: string) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${what}`);
  ok &&= cond;
};
try {
  r.relay.tasks.setPermissions(s.id, { mode: "standard" }, "admin");
  await round("Hackathon warm-up", [
    { assignee: "juno", title: "Write a haiku file", detail: "Create haiku.md in your working folder containing one haiku about agents working together. Then report what you wrote." },
    { assignee: "wren", title: "FizzBuzz plus a question", detail: "Create fizzbuzz.py in your working folder that prints FizzBuzz for 1 to 15. Then ask juno-claude with send_message for the first line of their haiku, and put their answer in your report." },
  ]);
  check(existsSync(join(work.juno, "haiku.md")), "juno wrote haiku.md (Standard: edits allowed)");
  check(existsSync(join(work.wren, "fizzbuzz.py")), "wren wrote fizzbuzz.py");
  check(r.relay.listMessages({ agent: A("wren-claude") }).some((m) => m.from === A("wren-claude") && m.to === A("juno-claude")), "wren messaged juno directly");

  r.relay.tasks.setPermissions(s.id, { mode: "full" }, "admin");
  const second = await round("Shell check", [
    { assignee: "juno", title: "Run a command", detail: "Run this shell command in your working folder and report its exact output: node -e \"console.log(6*7)\"" },
    { assignee: "wren", title: "List your folder", detail: "Use the shell to list the files in your working folder and write the listing to listing.txt. Report the listing." },
  ]);
  check(/\b42\b/.test(second.final_report), "juno ran a shell command under Full access");
  check(existsSync(join(work.wren, "listing.txt")), "wren used the shell and wrote listing.txt");
  for (const [name, c] of Object.entries({ juno, wren })) {
    const runs = c.daemon["state"].prepare("SELECT status, error, cost_usd FROM runs").all() as { status: string; error: string | null; cost_usd: number | null }[];
    console.log(`${name}: ${runs.length} runs, ${runs.filter((x) => x.status === "failed").length} failed, $${runs.reduce((n, x) => n + (x.cost_usd ?? 0), 0).toFixed(3)}${runs.filter((x) => x.error).map((x) => `\n  error: ${x.error}`).join("")}`);
  }
  if (existsSync(join(work.juno, "haiku.md"))) console.log(`haiku.md:\n${readFileSync(join(work.juno, "haiku.md"), "utf8")}`);
} catch (err) {
  ok = false;
  console.error(err);
  for (const [name, c] of Object.entries({ juno, wren })) console.log(`--- ${name} log\n${c.logs.slice(-30).join("\n")}`);
} finally {
  await lead.stop();
  await juno.stop();
  await wren.stop();
  await r.close();
  console.log(ok ? "\nALL PASS" : "\nSOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
}
