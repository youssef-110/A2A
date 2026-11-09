// End-to-end check of the hosted flow against a running Worker (default: `pnpm cloud:dev` on :8787):
// two people sign up, one creates a session, the other runs the one-line `connect` with the invite,
// approves the sign-in code, and their apps' agents join. Then messages, briefs, "shared with you",
// capacity and deleting the session for everyone. Uses throwaway homes; never touches ~/.a2a.
//   node scripts/smoke-cloud.mjs [origin]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const O = process.argv[2] ?? "http://localhost:8787";
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "bin", "a2a.mjs");
const tmp = mkdtempSync(join(tmpdir(), "a2a-smoke-"));
const run = Date.now().toString(36);
const step = (s) => console.log(`\n▸ ${s}`);

async function http(method, path, { cookie, body } = {}) {
  const res = await fetch(O + path, { method, redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

async function signup(name) {
  const r = await http("POST", "/auth/signup", { body: { email: `${name}-${run}@example.com`, password: "correct horse battery", name } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const me = (await http("GET", "/api/me", { cookie })).body;
  return { cookie, ws: me.workspaces[0].slug, email: me.user.email };
}

/** Runs `a2a connect`, approving the sign-in code it prints as `person`. */
function connect(person, home, apps, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "--home", home, "connect", ...args], {
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
        const r = await http("POST", "/api/device/approve", { cookie: person.cookie, body: { code: m[1], workspace: person.ws } });
        if (r.status !== 200) reject(new Error(`approve failed: ${JSON.stringify(r.body)}`));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`connect exited ${code}:\n${out}`))));
  });
}

const cli = (home, ...args) => cliOk([0], home, ...args);
const cliOk = (codes, home, ...args) => {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "--home", home, ...args], { encoding: "utf8", env: { ...process.env, A2A_ORIGIN: O } });
  if (!codes.includes(r.status)) throw new Error(`a2a ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout;
};

const homes = [];
try {
  step("Google sign-in sends people to the redirect URI registered in Google Cloud");
  if ((await http("GET", "/auth/google-status")).body.enabled) {
    const g = await http("GET", "/auth/google");
    assert.equal(g.status, 302);
    const loc = new URL(g.headers.get("location"));
    assert.equal(loc.searchParams.get("redirect_uri"), `${O}/auth/callback/google`);
    console.log("  redirect_uri =", loc.searchParams.get("redirect_uri"));
  } else console.log("  skipped: Google sign-in isn't configured here");

  step("Ivy and Robin sign up; Ivy creates a session for 2 people with a brief");
  const ivy = await signup("Ivy");
  const robin = await signup("Robin");
  const kim = await signup("Kim");
  const max = await signup("Max");
  const ses = (await http("POST", `/api/w/${ivy.ws}/v1/admin/sessions`, { cookie: ivy.cookie, body: { name: "Launch", max_members: 2, brief: "Ship v1 Friday. Ivy owns the API." } })).body;
  assert.ok(ses.invite?.url, JSON.stringify(ses));
  console.log("  invite:", ses.invite.url);

  step("Joining without signing in is refused");
  const anonHome = join(tmp, "anon");
  homes.push(anonHome);
  const anon = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "--home", anonHome, "join", ses.invite.url, "--name", "anon", "--no-start"], { encoding: "utf8" });
  assert.notEqual(anon.status, 0);
  assert.match(anon.stderr, /sign_in_required/);

  step("Robin pastes the prompt: one command, approve the code, Antigravity and Cursor both join");
  const samHome = join(tmp, "robin");
  const samApps = join(tmp, "robin-apps");
  homes.push(samHome);
  mkdirSync(join(samApps, ".gemini", "antigravity"), { recursive: true });
  mkdirSync(join(samApps, ".cursor"), { recursive: true });
  const out = await connect(robin, samHome, samApps, [ses.invite.url]);
  console.log(out.split("\n").filter((l) => /●|✓|!|Joined|Connected/.test(l)).map((l) => `  ${l.trim()}`).join("\n"));
  assert.match(out, /Joined the session "Launch"/);
  assert.ok(existsSync(join(samApps, ".gemini", "antigravity", "mcp_config.json")));
  assert.match(readFileSync(join(samApps, ".cursor", "mcp.json"), "utf8"), /--tool", "cursor"|"cursor"/);
  assert.ok(existsSync(join(samApps, ".gemini", "antigravity", "skills", "a2a", "SKILL.md")));

  step("Ivy sees who joined (name, email, both apps), counted as one person");
  const detail = (await http("GET", `/api/w/${ivy.ws}/v1/admin/sessions/${ses.id}`, { cookie: ivy.cookie })).body;
  assert.equal(detail.people, 1);
  const samAgents = detail.members.filter((m) => m.email === robin.email);
  assert.equal(samAgents.length, 2, JSON.stringify(detail.members));
  console.log("  ", samAgents.map((m) => `${m.address} (${m.display_name})`).join(", "));

  step("Robin's dashboard lists the session under Shared with you");
  const shared = (await http("GET", "/api/shared", { cookie: robin.cookie })).body;
  assert.equal(shared.sessions[0]?.name, "Launch");
  const sharedDetail = (await http("GET", `/api/shared/${ivy.ws}/sessions/${ses.id}`, { cookie: robin.cookie })).body;
  assert.equal(sharedDetail.brief, "Ship v1 Friday. Ivy owns the API.");
  assert.ok(sharedDetail.members.every((m) => !("email" in m)), "guests don't see emails");

  step("Ivy connects her own apps without a link; her agents and Robin's reach each other by name");
  const lenaHome = join(tmp, "ivy");
  const lenaApps = join(tmp, "ivy-apps");
  homes.push(lenaHome);
  mkdirSync(join(lenaApps, ".codex"), { recursive: true });
  await connect(ivy, lenaHome, lenaApps, []);
  const sent = JSON.parse(cli(samHome, "send", "ivy", "Is the API schema final?", "--wait", "0", "--json"));
  assert.notEqual(sent.state, "blocked", JSON.stringify(sent));
  let got = "";
  for (let i = 0; i < 40 && !got.includes("schema"); i++) {
    got = cli(lenaHome, "inbox");
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.match(got, /Is the API schema final\?/);
  console.log("  Robin -> Ivy delivered:", sent.id);

  step("Robin's agent reads the brief and updates it; Ivy sees the change");
  const list = JSON.parse(cli(samHome, "sessions", "--json"));
  assert.equal(list.sessions[0].brief, "Ship v1 Friday. Ivy owns the API.");
  cli(samHome, "brief", ses.id, "Ship v1 Friday. Ivy owns the API, Robin the UI.");
  const updated = (await http("GET", `/api/w/${ivy.ws}/v1/admin/sessions/${ses.id}`, { cookie: ivy.cookie })).body;
  assert.equal(updated.brief, "Ship v1 Friday. Ivy owns the API, Robin the UI.");

  step("Kim takes the second place; the session is full, so Max is turned away");
  const kimHome = join(tmp, "kim");
  const maxHome = join(tmp, "max");
  homes.push(kimHome, maxHome);
  await connect(kim, kimHome, join(tmp, "kim-apps"), [ses.invite.url]);
  await assert.rejects(connect(max, maxHome, join(tmp, "max-apps"), [ses.invite.url]), /session_full/);

  step("An agent's shell gives up before Noa approves: the command stops cleanly, and running it again finishes");
  const noa = await signup("Noa");
  const noaHome = join(tmp, "noa");
  homes.push(noaHome);
  const first = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "--home", noaHome, "connect", "--app", "cursor", "--no-install", "--wait", "3"], { encoding: "utf8", env: { ...process.env, A2A_NO_BROWSER: "1", A2A_APPS_HOME: join(tmp, "noa-apps"), A2A_ORIGIN: O } });
  assert.equal(first.status, 3, first.stdout + first.stderr);
  assert.match(first.stdout, /Not approved yet/);
  const prefilled = /open (\S+\/link\?code=([A-Z0-9]{4}-[A-Z0-9]{4}))/.exec(first.stdout);
  assert.ok(prefilled, first.stdout);
  console.log("  approval link:", prefilled[1]);
  // connect() approves the code the second run prints, which must be the first run's code.
  const second = await connect(noa, noaHome, join(tmp, "noa-apps"), ["--app", "cursor", "--no-install"]);
  assert.match(second, new RegExp(prefilled[2]), "the second run reuses the first code");
  assert.match(second, /noa-cursor/);
  console.log("  resumed with the same code and connected");

  step("Ivy deletes the session for everyone: Robin is cut off and told");
  assert.equal((await http("DELETE", `/api/w/${ivy.ws}/v1/admin/sessions/${ses.id}`, { cookie: ivy.cookie })).status, 200);
  // Ivy is out of reach: by name she no longer resolves, and her full address is blocked.
  assert.throws(() => cli(samHome, "send", "ivy", "still there?", "--wait", "0"), /No agent called "ivy"/);
  const lenaAddr = JSON.parse(cli(lenaHome, "info", "--json")).agents.find((x) => x.server.endsWith(`/w/${ivy.ws}`)).address;
  const after = JSON.parse(cliOk([0, 2], samHome, "send", lenaAddr, "still there?", "--wait", "0", "--json", "--scope", "general"));
  assert.ok(["blocked", "rejected"].includes(after.state), JSON.stringify(after));
  assert.equal((await http("GET", "/api/shared", { cookie: robin.cookie })).body.sessions.length, 0);
  console.log("  after delete:", after.state, after.reason_code);
  assert.match(readFileSync(join(samHome, "run", "daemon.log"), "utf8"), /"Launch" was deleted by its owner/);
  console.log("  Robin's apps were told the session was deleted");

  console.log("\n✓ hosted flow works end to end");
} finally {
  for (const h of homes) spawnSync(process.execPath, [CLI, "--home", h, "stop"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));
  rmSync(tmp, { recursive: true, force: true });
}
