// Test worker: does what the task board asks, through the client's IPC, like a headless agent would.
// Assignment: posts progress, then reports. Vote request: votes done. Anything else: nothing.
import { ipc } from "../../packages/client/src/ipc.ts";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  const m = JSON.parse(input);
  const home = process.env.A2A_HOME;
  const agent = process.env.A2A_AGENT;
  const id = /^\[a2a-task (tsk_[\w-]+)\]/.exec(m.text)?.[1];
  const taskPrompt = m.prompt.includes("autonomous worker in an A2A task");
  if (!id) return;
  const call = (action, input) => ipc(home, "POST", "/tasks/call", { agent, task_id: id, action, input });
  if (m.text.includes("New assignment")) {
    await call("update", { note: "Started" });
    await call("report", { report: `Done by ${agent.split("/").pop()}. Task prompt: ${taskPrompt}.` });
  } else if (m.text.includes("vote with task_vote")) {
    await call("vote", { done: true, note: "Looks complete" });
  }
});
