// Fills a relay with simulated agents and starts a mission, so you can watch tasks, check-ins,
// votes and the live map without any AI model or API key.
//
//   node scripts/demo-swarm.mjs [origin] [--agents 4] [--mission "..."]
//
// It signs up a demo owner and N teammates (email + password, local relays only), creates a session,
// connects one simulated agent per teammate on autopilot, and hands the first one a mission.
// Sign in to the dashboard with the owner's email and password it prints to watch.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, saveConfig } from "../packages/client/src/config.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { agents: { type: "string", default: "4" }, mission: { type: "string" }, pace: { type: "string", default: "1" } },
});
const O = positionals[0] ?? "http://localhost:8787";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "plugin", "bin", "a2a.mjs");
const SIM = join(ROOT, "scripts", "sim-agent.mjs");
const tmp = mkdtempSync(join(tmpdir(), "a2a-swarm-"));
const run = Date.now().toString(36);
const PASSWORD = "demo swarm password";
const NAMES = ["Robin", "Juno", "Wren", "Theo", "Riley", "Sage", "Quinn", "Rowan"];
const MISSION =
  values.mission ??
  "Build a landing page for our hackathon project.\nWrite the headline and three feature blurbs.\nBuild the page with a signup form.\nTest it on mobile and fix layout issues.\nWrite a 60-second demo script.";

async function http(method, path, { cookie, body } = {}) {
  const res = await fetch(O + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, body: json, headers: res.headers };
}

async function signup(name) {
  const email = `${name.toLowerCase()}-${run}@example.com`;
  const r = await http("POST", "/auth/signup", { body: { email, password: PASSWORD, name } });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const me = (await http("GET", "/api/me", { cookie })).body;
  return { name, email, cookie, ws: me.workspaces[0].slug };
}

/** `a2a connect <invite>` for one person, approving the sign-in code as them. */
function connect(person, home, apps, invite) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "--home", home, "connect", invite, "--name", person.name.toLowerCase()], {
      env: { ...process.env, A2A_NO_BROWSER: "1", A2A_APPS_HOME: apps, A2A_ORIGIN: O },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let approved = false;
    const onData = async (d) => {
      out += d;
      const m = /enter the code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out);
      if (m && !approved) {
        approved = true;
        await http("POST", "/api/device/approve", { cookie: person.cookie, body: { code: m[1], workspace: person.ws } }).catch(reject);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`connect exited ${code}:\n${out}`))));
  });
}

const cli = (home, ...args) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "--home", home, ...args], { encoding: "utf8", env: { ...process.env, A2A_ORIGIN: O, A2A_SIM_PACE: values.pace } });

const owner = await signup("Ivy");
console.log(`Owner signed up: ${owner.email}`);
const ses = (await http("POST", `/api/w/${owner.ws}/v1/admin/sessions`, {
  cookie: owner.cookie,
  body: { name: "Hackathon demo", max_members: 20, brief: "Demo swarm: simulated agents on autopilot. Ivy owns the workspace; every agent may take a part." },
})).body;
// Short check-ins so a stalled worker is picked up again within a minute.
await http("PUT", `/api/w/${owner.ws}/v1/admin/permissions/${ses.id}`, { cookie: owner.cookie, body: { mode: "standard", checkin_minutes: 1 } });
console.log(`Session "Hackathon demo" created (check-ins after 1 minute)`);

const n = Math.min(Math.max(Number(values.agents) || 4, 2), NAMES.length);
const agents = [];
for (const name of NAMES.slice(0, n)) {
  const person = await signup(name);
  const home = join(tmp, name.toLowerCase());
  const apps = join(tmp, `${name.toLowerCase()}-apps`);
  mkdirSync(join(apps, ".cursor"), { recursive: true });
  await connect(person, home, apps, ses.invite.url);
  // Make the agent a simulated autopilot worker, then restart the client so it picks that up.
  const config = loadConfig(home);
  for (const a of config.agents) Object.assign(a, { runtime: "command", command: [process.execPath, "--disable-warning=ExperimentalWarning", SIM], autopilot: true, max_concurrent: 3 });
  saveConfig(home, config);
  const started = cli(home, "start", "--restart");
  if (started.status !== 0) throw new Error(`a2a start failed for ${name}: ${started.stderr}`);
  // Each person also gets an agent in their own workspace; the one in the owner's workspace is in the session.
  const inSession = config.agents.map((a) => a.address).filter((a) => a.startsWith(`agent://${owner.ws}/`));
  agents.push(...inSession);
  console.log(`  ${name} joined: ${inSession.map((a) => a.split("/").pop()).join(", ")}`);
}

await new Promise((r) => setTimeout(r, 1500));
const kick = (await http("POST", `/api/w/${owner.ws}/v1/admin/tasks/kickoff`, { cookie: owner.cookie, body: { to: agents[0], mission: MISSION, session_id: ses.id } })).body;
console.log(`\nMission sent to ${kick.to.split("/").pop()}. It splits the work and the others pick it up.`);
console.log(`\nWatch it: ${O}/app  (sign in as ${owner.email} / "${PASSWORD}", open "Hackathon demo", then Tasks or Live map)`);
console.log(`Client homes: ${tmp}  (stop them with: node ${CLI} --home <home> stop)`);
