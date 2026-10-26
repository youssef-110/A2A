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
  const g = await http("GET", "/auth/google");
  assert.equal(g.status, 302);
  const loc = new URL(g.headers.get("location"));
  assert.equal(loc.searchParams.get("redirect_uri"), `${O}/auth/callback/google`);
  console.log("  redirect_uri =", loc.searchParams.get("redirect_uri"));

  step("Lena and Sam sign up; Lena creates a session for 2 people with a brief");
  const lena = await signup("Lena");
  const sam = await signup("Sam");
  const kim = await signup("Kim");
  const max = await signup("Max");
  const ses = (await http("POST", `/api/w/${lena.ws}/v1/admin/sessions`, { cookie: lena.cookie, body: { name: "Launch", max_members: 2, brief: "Ship v1 Friday. Lena owns the API." } })).body;
  assert.ok(ses.invite?.url, JSON.stringify(ses));
  console.log("  invite:", ses.invite.url);

  step("Joining without signing in is refused");
  const anonHome = join(tmp, "anon");
  homes.push(anonHome);
  const anon = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "--home", anonHome, "join", ses.invite.url, "--name", "anon", "--no-start"], { encoding: "utf8" });
  assert.notEqual(anon.status, 0);
  assert.match(anon.stderr, /sign_in_required/);

  step("Sam pastes the prompt: one command, approve the code, Antigravity and Cursor both join");
  const samHome = join(tmp, "sam");
  const samApps = join(tmp, "sam-apps");
  homes.push(samHome);
  mkdirSync(join(samApps, ".gemini", "antigravity"), { recursive: true });
  mkdirSync(join(samApps, ".cursor"), { recursive: true });
  const out = await connect(sam, samHome, samApps, [ses.invite.url]);
  console.log(out.split("\n").filter((l) => /●|✓|!|Joined|Connected/.test(l)).map((l) => `  ${l.trim()}`).join("\n"));
  assert.match(out, /Joined the session "Launch"/);
  assert.ok(existsSync(join(samApps, ".gemini", "antigravity", "mcp_config.json")));
  assert.match(readFileSync(join(samApps, ".cursor", "mcp.json"), "utf8"), /--tool", "cursor"|"cursor"/);
  assert.ok(existsSync(join(samApps, ".gemini", "antigravity", "skills", "a2a", "SKILL.md")));

  step("Lena sees who joined (name, email, both apps), counted as one person");
  const detail = (await http("GET", `/api/w/${lena.ws}/v1/admin/sessions/${ses.id}`, { cookie: lena.cookie })).body;
  assert.equal(detail.people, 1);
  const samAgents = detail.members.filter((m) => m.email === sam.email);
  assert.equal(samAgents.length, 2, JSON.stringify(detail.members));
  console.log("  ", samAgents.map((m) => `${m.address} (${m.display_name})`).join(", "));

  step("Sam's dashboard lists the session under Shared with you");
  const shared = (await http("GET", "/api/shared", { cookie: sam.cookie })).body;
  assert.equal(shared.sessions[0]?.name, "Launch");
  const sharedDetail = (await http("GET", `/api/shared/${lena.ws}/sessions/${ses.id}`, { cookie: sam.cookie })).body;
  assert.equal(sharedDetail.brief, "Ship v1 Friday. Lena owns the API.");
  assert.ok(sharedDetail.members.every((m) => !("email" in m)), "guests don't see emails");

  step("Lena connects her own apps without a link; her agents and Sam's reach each other by name");
  const lenaHome = join(tmp, "lena");
  const lenaApps = join(tmp, "lena-apps");
  homes.push(lenaHome);
  mkdirSync(join(lenaApps, ".codex"), { recursive: true });
  await connect(lena, lenaHome, lenaApps, []);
  const sent = JSON.parse(cli(samHome, "send", "lena", "Is the API schema final?", "--wait", "0", "--json"));
  assert.notEqual(sent.state, "blocked", JSON.stringify(sent));
  let got = "";
  for (let i = 0; i < 40 && !got.includes("schema"); i++) {
    got = cli(lenaHome, "inbox");
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.match(got, /Is the API schema final\?/);
  console.log("  Sam -> Lena delivered:", sent.id);

  step("Sam's agent reads the brief and updates it; Lena sees the change");
  const list = JSON.parse(cli(samHome, "sessions", "--json"));
  assert.equal(list.sessions[0].brief, "Ship v1 Friday. Lena owns the API.");
  cli(samHome, "brief", ses.id, "Ship v1 Friday. Lena owns the API, Sam the UI.");
  const updated = (await http("GET", `/api/w/${lena.ws}/v1/admin/sessions/${ses.id}`, { cookie: lena.cookie })).body;
  assert.equal(updated.brief, "Ship v1 Friday. Lena owns the API, Sam the UI.");

  step("Kim takes the second place; the session is full, so Max is turned away");
  const kimHome = join(tmp, "kim");
  const maxHome = join(tmp, "max");
  homes.push(kimHome, maxHome);
  await connect(kim, kimHome, join(tmp, "kim-apps"), [ses.invite.url]);
  await assert.rejects(connect(max, maxHome, join(tmp, "max-apps"), [ses.invite.url]), /session_full/);

  step("Lena deletes the session for everyone: Sam is cut off and told");
  assert.equal((await http("DELETE", `/api/w/${lena.ws}/v1/admin/sessions/${ses.id}`, { cookie: lena.cookie })).status, 200);
  // Lena is out of reach: by name she no longer resolves, and her full address is blocked.
  assert.throws(() => cli(samHome, "send", "lena", "still there?", "--wait", "0"), /No agent called "lena"/);
  const lenaAddr = JSON.parse(cli(lenaHome, "info", "--json")).agents.find((x) => x.server.endsWith(`/w/${lena.ws}`)).address;
  const after = JSON.parse(cliOk([0, 2], samHome, "send", lenaAddr, "still there?", "--wait", "0", "--json", "--scope", "general"));
  assert.ok(["blocked", "rejected"].includes(after.state), JSON.stringify(after));
  assert.equal((await http("GET", "/api/shared", { cookie: sam.cookie })).body.sessions.length, 0);
  console.log("  after delete:", after.state, after.reason_code);
  assert.match(readFileSync(join(samHome, "run", "daemon.log"), "utf8"), /"Launch" was deleted by its owner/);
  console.log("  Sam's apps were told the session was deleted");

  console.log("\n✓ hosted flow works end to end");
} finally {
  for (const h of homes) spawnSync(process.execPath, [CLI, "--home", h, "stop"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));
  rmSync(tmp, { recursive: true, force: true });
}
