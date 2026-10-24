#!/usr/bin/env node
// Stand-in for `opencode run --format json`. Logs how it was called, then prints the event
// stream shape OpenCode emits: text parts re-emitted as they grow, sessionID on every line.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const session = args.includes("--session") ? args[args.indexOf("--session") + 1] : "ses_fake_1";
const prompt = args.at(-1);
appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify({ args, cwd: process.cwd(), config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "null"), env: { agent: process.env.A2A_AGENT, run: process.env.A2A_RUN_ID } }) + "\n");

if (prompt.includes("FAIL")) {
  console.log(JSON.stringify({ type: "error", timestamp: Date.now(), sessionID: session, error: { name: "ProviderAuthError", data: { message: "No provider configured" } } }));
  process.exit(1);
}
const ev = (type, part) => console.log(JSON.stringify({ type, timestamp: Date.now(), sessionID: session, part }));
ev("step_start", { type: "step-start" });
ev("text", { id: "p1", type: "text", text: "Let me look at the tickets." });
ev("tool_use", { id: "t1", type: "tool", tool: "read", state: { status: "completed" } });
ev("text", { id: "p2", type: "text", text: "Ticket T-1042" });
ev("text", { id: "p2", type: "text", text: `Ticket T-1042: refund promised. (session ${session}${args.includes("--session") ? ", resumed" : ""})` });
ev("step_finish", { type: "step-finish", reason: "stop", tokens: { input: 10, output: 5 } });
