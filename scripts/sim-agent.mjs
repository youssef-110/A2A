// A simulated autopilot agent for demos: it behaves like a headless worker (no AI model needed).
// The a2a client runs it for every message (runtime: command) and passes the message on stdin.
//   [a2a-mission]           -> splits the mission into parts for the online teammates (create_task)
//   [a2a-task] assignment   -> posts progress, checks in with a teammate, then reports
//   [a2a-task] check-in     -> posts progress
//   [a2a-task] vote request -> votes done
//   a teammate's question   -> answers it (stdout is the reply)
import { ipc } from "../packages/client/src/ipc.ts";

const home = process.env.A2A_HOME;
const me = process.env.A2A_AGENT;
const short = (a) => a.split("/").pop();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));
const PACE = Number(process.env.A2A_SIM_PACE ?? 1);

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => main(JSON.parse(input)).catch((e) => console.error(e)));

const task = (id, action, body = {}) => ipc(home, "POST", "/tasks/call", { agent: me, task_id: id, action, input: body });

async function teammates() {
  const r = await ipc(home, "GET", `/directory?agent=${encodeURIComponent(me)}`);
  return r.agents.filter((a) => a.address !== me && !a.address.endsWith("/console")).sort((a, b) => Number(b.online) - Number(a.online));
}

/** Turns a mission into parts: one per line or sentence, or a standard plan when it is one line. */
function planOf(mission) {
  const lines = mission
    .split(/\n|(?<=\.)\s+/)
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 8);
  // The first line names the mission; the lines after it are the parts.
  if (lines.length >= 3) return lines.slice(1, 9).map((l) => ({ title: l.slice(0, 80), detail: l }));
  if (lines.length === 2) return lines.map((l) => ({ title: l.slice(0, 80), detail: l }));
  return [
    { title: "Research and requirements", detail: `Find out what "${mission.slice(0, 120)}" needs: users, constraints, prior art. Write down decisions.` },
    { title: "Build the core", detail: "Implement the main piece end to end, smallest version that works." },
    { title: "Test and harden", detail: "Try it like a user would, fix what breaks, note the edge cases." },
    { title: "Write it up", detail: "A short README and a demo script someone else can follow." },
  ];
}

async function main(m) {
  const text = m.text;
  if (text.startsWith("[a2a-mission]")) {
    const mission = text.split("\n").slice(2).join("\n").split("\nWhat to do:")[0].trim();
    const team = await teammates();
    const online = team.filter((a) => a.online);
    const pool = (online.length ? online : team).map((a) => a.address);
    if (!pool.length) return;
    const parts = planOf(mission).map((p, i) => ({ ...p, assignee: pool[i % pool.length] }));
    await jitter(800 * PACE, 1500 * PACE);
    await ipc(home, "POST", "/tasks/create", { agent: me, task: { title: mission.split("\n")[0].slice(0, 90), goal: mission.slice(0, 600), parts } });
    return;
  }

  const id = /^\[a2a-task (tsk_[\w-]+)\]/.exec(text)?.[1];
  if (!id) {
    // A teammate asked something: answer like a busy colleague would.
    if (m.expects_reply) process.stdout.write(`Thanks ${short(m.from)}. Nothing blocking on my side; I'll keep my part in line with yours.`);
    return;
  }
  const checkin = /Check-in \d of \d: "(.+)" \(part_id ([\w-]+)\)/.exec(text);
  if (text.includes("New assignment") || checkin) {
    const part = /Your part \(part_id ([\w-]+)\): (.+)/.exec(text);
    const partId = part?.[1] ?? checkin?.[2];
    const title = part?.[2] ?? checkin?.[1] ?? "my part";
    if (checkin) {
      // Picked up again after a check-in: finish the part instead of starting over.
      await task(id, "update", { part_id: partId, note: "Back on it after the check-in" });
      await jitter(1000 * PACE, 2000 * PACE);
      await task(id, "report", { part_id: partId, report: `What I did: ${title}.
- Resumed after a check-in from the task board and finished it.
Results: ready for review. (Simulated agent.)
Open items: none.` });
      return;
    }
    await jitter(600 * PACE, 1400 * PACE);
    await task(id, "update", { part_id: partId, note: `Read the brief, planning "${title}"` });
    const others = [...text.matchAll(/^- ([\w-]+): (.+)$/gm)].map((x) => x[1]);
    if (others.length) {
      const peer = others[Math.floor(Math.random() * others.length)];
      await ipc(home, "POST", "/send", { agent: me, to: peer, text: `Hi ${peer}, I'm on "${title}". Anything from your part I should line up with?`, kind: "request", expects_reply: true, wait_seconds: 20 }).catch(() => {});
    }
    await jitter(1500 * PACE, 3500 * PACE);
    await task(id, "update", { part_id: partId, note: "Halfway: first version done, checking it now" });
    await jitter(1500 * PACE, 3500 * PACE);
    await task(id, "report", {
      part_id: partId,
      report: [
        `What I did: ${title}.`,
        "- Worked through the brief and the detail for this part.",
        "- Checked in with a teammate so our pieces fit together.",
        "- Verified the result once more before reporting.",
        "Results: ready for review. (Simulated agent: this report is a placeholder for a real agent's work.)",
        "Open items: none.",
      ].join("\n"),
    });
    return;
  }
  if (/vote with task_vote|waiting for your vote/.test(text)) {
    await jitter(500 * PACE, 1500 * PACE);
    await task(id, "vote", { done: true, note: "Reports cover everything." }).catch(() => {});
    return;
  }
}
