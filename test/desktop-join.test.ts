// The desktop app signs a person in, then joins with a one-use owner invite. Joined as that person
// (their sign-in in A2A_ACCOUNT_TOKEN), the agent belongs to their account: their page can switch its
// auto-reply and sees what it asks them to approve. Joined the old way, with the invite alone, it doesn't.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { loadPrivateKey } from "@a2a/protocol";
import { createApi } from "../packages/server/src/api.ts";
import { Daemon } from "../packages/client/src/daemon.ts";
import { keyPath, loadConfig, saveConfig } from "../packages/client/src/config.ts";
import { signedSend } from "../packages/client/src/relay-api.ts";
import { ADMIN, ROOT, cleanup, relay, tempDir, waitFor } from "./helpers.ts";

const POLICY = "org: desk\nregistration: invite\nisolation: sessions\nscopes:\n  general:\n    description: Anything.\nrules:\n  block: []\n  hold: []\n  redact: []\nguard:\n  judge: off\n";
const TOKEN = "session-token-of-dana";
const [DESK, OLD] = ["agent://desk/dana-pc", "agent://desk/old-pc"] as const;

let r: Awaited<ReturnType<typeof relay>>;
let site: Server;
let siteUrl = "";
let daemon: Daemon | undefined;
const dirs: string[] = [];
const homes = { desk: "", old: "" };

/** The relay's API as the hosted Worker calls it: the signed-in person's account in headers only it may set. */
async function asAccount(account: string, method: string, path: string, body?: unknown, admin = true): Promise<Response> {
  const api = createApi({ relay: r.relay, adminToken: ADMIN, name: "desk", trustForwardedBase: true });
  const headers = { ...(admin ? { authorization: `Bearer ${ADMIN}` } : {}), "x-a2a-account-id": account, "x-a2a-account-email": `${account}@example.test`, "x-a2a-account-name": account, "x-a2a-account-role": "owner", "content-type": "application/json" };
  return (await api.handle(new Request(`http://relay.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })))!;
}

/** `a2a join`, started the way the desktop app starts it: the sign-in in the environment, never in the arguments. */
function cliJoin(home: string, link: string, name: string, env: Record<string, string> = {}): Promise<string> {
  const args = ["--disable-warning=ExperimentalWarning", join(ROOT, "packages/client/src/cli.ts"), "join", link, "--name", name, "--runtime", "none", "--no-start", "--force"];
  assert.ok(!args.includes(TOKEN));
  return new Promise((done, fail) =>
    execFile(process.execPath, args, { env: { ...process.env, A2A_HOME: home, A2A_NO_AUTOSTART: "1", A2A_NO_BROWSER: "1", ...env }, windowsHide: true, timeout: 30_000 }, (err, out, errOut) => (err ? fail(new Error(String(errOut || err.message))) : done(String(out)))),
  );
}

const ownerInvite = (): string => `${siteUrl}/join/${r.relay.createInvite({ owner: true, max_uses: 1, ttl_hours: 1, note: "Desktop app on test" }, "admin").code}`;
const owner = (address: string): string | undefined => (r.relay.db.prepare("SELECT account_id FROM agent_accounts WHERE address = ?").get(address) as { account_id: string } | undefined)?.account_id;

before(async () => {
  const policyDir = tempDir("desk-policy");
  dirs.push(policyDir);
  writeFileSync(join(policyDir, "policy.yaml"), POLICY);
  r = await relay({ policyPath: join(policyDir, "policy.yaml"), judges: null });
  // A stand-in for the hosted site in front of the relay (packages/cloud/src/worker.ts): a registration
  // that carries a sign-in reaches the relay with that person's account; nothing else a client sends does.
  site = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    let out: Response;
    if (req.url === "/v1/register" && bearer) {
      out = bearer === TOKEN ? await asAccount("acct_dana", "POST", "/v1/register", JSON.parse(body ?? "{}"), false) : Response.json({ error: "signed_out" }, { status: 401 });
    } else {
      out = await fetch(r.url + req.url, { method: req.method, headers: body ? { "content-type": "application/json" } : {}, body });
    }
    res.writeHead(out.status, { "content-type": "application/json" }).end(await out.text());
  });
  await new Promise<void>((ok) => site.listen(0, "127.0.0.1", ok));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  homes.desk = tempDir("desk-new");
  homes.old = tempDir("desk-old");
});

after(async () => {
  await daemon?.stop();
  await new Promise((ok) => site.close(ok));
  await r?.close();
  cleanup(r.dataDir, ...dirs, homes.desk, homes.old);
});

test("an agent joined with the person's sign-in belongs to their account; one joined with the invite alone belongs to nobody", async () => {
  const out = await cliJoin(homes.desk, ownerInvite(), "dana-pc", { A2A_ACCOUNT_TOKEN: TOKEN });
  assert.match(out, /Joined .* as agent:\/\/desk\/dana-pc \(active\)/);
  await cliJoin(homes.old, ownerInvite(), "old-pc");
  assert.equal(owner(DESK), "acct_dana");
  assert.equal(owner(OLD), undefined);
  // The sign-in is used once, for the registration: it is not kept in the agent's folder.
  assert.ok(!readFileSync(join(homes.desk, "config.yaml"), "utf8").includes(TOKEN));
  // A sign-in the site no longer accepts joins nothing.
  dirs.push(tempDir("desk-bad"));
  await assert.rejects(cliJoin(dirs.at(-1)!, ownerInvite(), "bad-pc", { A2A_ACCOUNT_TOKEN: "expired" }), /signed_out/);
  assert.equal(r.relay.getAgent("agent://desk/bad-pc"), undefined);
});

test("its owner's page can switch its auto-reply, and sees what it asks them to approve", async () => {
  const session = r.relay.createSession({ name: "Build" }, "admin").id;
  const switchOn = async (address: string) => {
    const res = await asAccount("acct_dana", "POST", "/v1/admin/auto-reply", { address, session_id: session, on: true });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  // The stand-in site only speaks HTTP; the agent's live connection goes straight to the relay behind it.
  saveConfig(homes.desk, { ...loadConfig(homes.desk), server: r.url });
  daemon = new Daemon({ home: homes.desk, log: () => {} });
  await daemon.start();
  await waitFor(() => daemon!.info().connected === true, 5000, "the desktop agent to connect");

  const mine = await switchOn(DESK);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const notMine = await switchOn(OLD);
  assert.equal(notMine.status, 403);
  assert.equal(notMine.body.error, "not_your_agent");

  // A headless run asks its owner before a sensitive step: the request lands on that person's page, and nobody else's.
  const key = (home: string, address: string) => loadPrivateKey(readFileSync(keyPath(home, loadConfig(home).agents.find((a) => a.address === address)!), "utf8"));
  await signedSend(r.url, DESK, key(homes.desk, DESK), "POST", "/v1/approvals", { action: "Deploy the site", session_id: session });
  await signedSend(r.url, OLD, key(homes.old, OLD), "POST", "/v1/approvals", { action: "Deploy the old site", session_id: session });
  const listed = async (account: string) => ((await (await asAccount(account, "GET", "/v1/admin/approvals")).json()) as { approvals: Record<string, any>[] }).approvals;
  const asked = await listed("acct_dana");
  assert.deepEqual(asked.map((a) => [a.agent, a.action]), [[DESK, "Deploy the site"]]);
  assert.deepEqual(await listed("acct_eve"), []);
  // The other agent's request is tied to no account, so no signed-in person is ever shown it.
  assert.equal((r.relay.db.prepare("SELECT account_id FROM approvals WHERE agent = ?").get(OLD) as { account_id: string | null }).account_id, null);
  const ok = await asAccount("acct_dana", "POST", `/v1/admin/approvals/${asked[0]!.id}`, { decision: "approve" });
  assert.equal(ok.status, 200);
});
