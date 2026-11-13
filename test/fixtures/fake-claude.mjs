// A stand-in for the `claude` command. It does what a note asks only as far as the flags it was started
// with allow, the way Claude Code 2.1 applies them (checked against the real one, see claudeArgs):
// edits need the folder rule, a shell needs Bash, a denied path can't be read, and nothing ever prompts.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ipc } from "../../packages/client/src/ipc.ts";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : "");
const allowed = flag("--allowedTools").split(",");
const denied = flag("--disallowedTools").split(",");

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  const home = process.env.A2A_HOME;
  const agent = process.env.A2A_AGENT;
  appendFileSync(join(home, "fake-claude.jsonl"), JSON.stringify({ argv, prompt }) + "\n");
  const out = (result) => process.stdout.write(JSON.stringify({ result, session_id: "fake-session", is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }));
  // Any other mode would stop at a prompt nobody is there to answer.
  if (flag("--permission-mode") !== "dontAsk") return out("stopped at a permission prompt");

  const note = /<a2a-message [^>]*>\n([\s\S]*)\n<\/a2a-message/.exec(prompt)?.[1] ?? "";
  const taskId = /^\[a2a-task (tsk_[\w-]+)\]/.exec(note)?.[1];
  const call = (action, input) => ipc(home, "POST", "/tasks/call", { agent, task_id: taskId, action, input });
  if (note.includes("vote with task_vote")) {
    await call("vote", { done: true });
    return out("voted");
  }

  // A step the part itself calls sensitive: ask the owner and stop, then go by their answer.
  const answer = /^\[a2a\] .* answered the approval you asked for\.[\s\S]*?Answer: (APPROVED|DENIED)/.exec(prompt)?.[1];
  if (note.includes("ask-owner") && !answer) {
    await ipc(home, "POST", "/approvals/request", { run_id: process.env.A2A_RUN_ID, action: `Deploy for "${/write (\S+\.txt)/.exec(note)?.[1]}"`, why: "The part says to ship it." });
    return out("I asked my owner and stopped.");
  }
  if (answer === "DENIED") {
    if (taskId) await call("update", { status: "blocked", note: "My owner said no." });
    return out("denied");
  }

  const did = { edited: false, ran: false, secret: null, team: /put you on this team|leads the team/.test(prompt) };
  const file = /write (\S+\.txt)/.exec(note)?.[1];
  if (file && allowed.includes("Edit(./**)")) {
    writeFileSync(file, `written by ${agent}`);
    did.edited = true;
  }
  if (note.includes("run-check") && allowed.includes("Bash")) {
    execFileSync(process.execPath, ["-e", "require('fs').writeFileSync('ran.txt', 'ok')"]);
    did.ran = true;
  }
  if (note.includes("read-secret") && !denied.includes("Read(**/.env)")) did.secret = readFileSync(".env", "utf8");
  if (taskId && note.includes("New assignment")) await call("report", { report: JSON.stringify(did) });
  out(JSON.stringify(did));
});
