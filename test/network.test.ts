import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKeyPair } from "@a2a/protocol";
import { Daemon } from "../packages/client/src/daemon.ts";
import { joinNetwork, parseInviteLink } from "../packages/client/src/join.ts";
import { registerAgent } from "../packages/client/src/relay-api.ts";
import { adminFetch, cleanup, ECHO_AGENT, relay, tempDir, waitFor } from "./helpers.ts";

// The open policy the Cloudflare relay starts with: anyone in the org may message anyone about anything.
const OPEN_POLICY = `org: acme
registration: invite
scopes:
  general:
    description: Anything.
links:
  - from: agent://acme/*
    to: agent://acme/*
    scopes: ["*"]
rules:
  block: []
  hold: []
  redact: [secret_detected]
guard:
  judge: off
`;

async function openRelay() {
  const dir = tempDir("open-policy");
  const policyPath = join(dir, "policy.yaml");
  writeFileSync(policyPath, OPEN_POLICY);
  const r = await relay({ policyPath, judges: null });
  return { r, dir };
}

test("invite links activate new agents, respect their use limit and can be revoked", async () => {
  const { r, dir } = await openRelay();
  try {
    const created = await adminFetch(r.url, "POST", "/v1/admin/invites", { note: "two people", max_uses: 2 });
    assert.equal(created.status, 201);
    const { code, url } = created.body as { code: string; url: string };
    assert.deepEqual(parseInviteLink(url), { server: r.url, code });

    const pub = await fetch(`${r.url}/v1/invites/${code}`).then((x) => x.json() as Promise<{ valid: boolean }>);
    assert.equal(pub.valid, true);

    for (const name of ["anna", "raj"]) {
      const k = generateAgentKeyPair();
      assert.equal((await registerAgent(r.url, `agent://acme/${name}`, k.privateKeyPem, { invite: code })).status, "active");
    }
    const third = generateAgentKeyPair();
    await assert.rejects(registerAgent(r.url, "agent://acme/third", third.privateKeyPem, { invite: code }), /invalid_invite/);

    // Without an invite, registration under "invite" mode waits for approval.
    assert.equal((await registerAgent(r.url, "agent://acme/walk-in", third.privateKeyPem, {})).status, "pending");

    const second = (await adminFetch(r.url, "POST", "/v1/admin/invites", {})).body as { code: string };
    assert.equal((await adminFetch(r.url, "DELETE", `/v1/admin/invites/${second.code}`)).status, 200);
    await assert.rejects(registerAgent(r.url, "agent://acme/late", generateAgentKeyPair().privateKeyPem, { invite: second.code }), /invalid_invite/);

    // Nobody can claim the relay's own console address.
    await assert.rejects(registerAgent(r.url, "agent://acme/console", generateAgentKeyPair().privateKeyPem, { adminToken: "test-admin-token" }), /reserved_address/);
  } finally {
    await r.close();
    cleanup(r.dataDir, dir);
  }
});

test("joining with a link, sending by name, and an open policy that lets anything through", async () => {
  const { r, dir } = await openRelay();
  const homes = [tempDir("join-sam"), tempDir("join-david")];
  const daemons: Daemon[] = [];
  try {
    const { url } = (await adminFetch(r.url, "POST", "/v1/admin/invites", { max_uses: 2 })).body as { url: string };
    const sam = await joinNetwork(homes[0]!, url, { name: "sam" });
    const david = await joinNetwork(homes[1]!, url, { name: "guest-david", runtime: "command" });
    assert.equal(sam.address, "agent://acme/sam");
    assert.equal(david.status, "active");

    // david answers with the echo agent so we can see the round trip.
    const { saveConfig, loadConfig } = await import("../packages/client/src/config.ts");
    const cfg = loadConfig(homes[1]!);
    cfg.agents[0]!.command = [process.execPath, ECHO_AGENT];
    saveConfig(homes[1]!, cfg);

    for (const home of homes) {
      const d = new Daemon({ home, log: () => {} });
      await d.start();
      daemons.push(d);
    }
    await waitFor(() => daemons.every((d) => d.info().connected === true), 5000, "both connected");

    // "guest-david" resolves to the full address, the free-form scope is accepted, and the question isn't blocked.
    const r1 = await daemons[0]!.send({ to: "guest-david", text: "Which MCP servers do you have on your machine?", scope: "engineering-chat" }, 10_000);
    assert.equal(r1.reply?.from, "agent://acme/guest-david");
    assert.match(r1.reply!.text, /MCP servers/);

    await assert.rejects(daemons[0]!.send({ to: "nobody-here", text: "hi" }), /No agent called "nobody-here"/);
  } finally {
    for (const d of daemons) await d.stop();
    await r.close();
    cleanup(r.dataDir, dir, ...homes);
  }
});

test("the console agent talks to agents and gets their replies", async () => {
  const { r, dir } = await openRelay();
  const home = tempDir("console-peer");
  let d: Daemon | undefined;
  try {
    const { url } = (await adminFetch(r.url, "POST", "/v1/admin/invites", {})).body as { url: string };
    await joinNetwork(home, url, { name: "echo", runtime: "command" });
    const { saveConfig, loadConfig } = await import("../packages/client/src/config.ts");
    const cfg = loadConfig(home);
    cfg.agents[0]!.command = [process.execPath, ECHO_AGENT];
    saveConfig(home, cfg);
    d = new Daemon({ home, log: () => {} });
    await d.start();
    await waitFor(() => d!.info().connected === true, 5000, "echo connected");

    const consoleEvents: Record<string, unknown>[] = [];
    r.relay.on("event", (e: { type: string; data: Record<string, unknown> }) => e.type === "console" && consoleEvents.push(e.data));

    const sent = await adminFetch(r.url, "POST", "/v1/admin/console/send", { to: "agent://acme/echo", text: "Are you there?" });
    assert.equal(sent.status, 202);
    await waitFor(() => consoleEvents.length > 0, 8000, "reply to the console");
    assert.equal(consoleEvents[0]!.from, "agent://acme/echo");
    assert.match(String(consoleEvents[0]!.text), /Are you there\?/);

    const list = await adminFetch(r.url, "GET", "/v1/admin/console/messages");
    const states = (list.body.messages as { state: string }[]).map((m) => m.state);
    assert.deepEqual(states, ["delivered", "delivered"]);
  } finally {
    await d?.stop();
    await r.close();
    cleanup(r.dataDir, dir, home);
  }
});

test("admin sessions are signed cookies, and logging out revokes them", async () => {
  const { r, dir } = await openRelay();
  try {
    const login = await fetch(`${r.url}/v1/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test-admin-token" }) });
    const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    const ok = await fetch(`${r.url}/v1/admin/session`, { headers: { cookie } }).then((x) => x.json() as Promise<{ admin: boolean }>);
    assert.equal(ok.admin, true);
    const forged = await fetch(`${r.url}/v1/admin/session`, { headers: { cookie: "a2a_session=9999999999.0.forged" } }).then((x) => x.json() as Promise<{ admin: boolean }>);
    assert.equal(forged.admin, false);

    // Logging out revokes the cookie on the server, not just in the browser.
    await fetch(`${r.url}/v1/admin/logout`, { method: "POST", headers: { cookie } });
    const after = await fetch(`${r.url}/v1/admin/session`, { headers: { cookie } }).then((x) => x.json() as Promise<{ admin: boolean }>);
    assert.equal(after.admin, false);
  } finally {
    await r.close();
    cleanup(r.dataDir, dir);
  }
});

test("a capsule rides along as an attachment, and the receiver gets a saved file and its Brief", async () => {
  const { readAttachments, readCapsuleAttachments, capsuleBrief } = await import("../packages/client/src/attachments.ts");
  const { readFileSync } = await import("node:fs");
  const { r, dir } = await openRelay();
  const homes = [tempDir("cap-sender"), tempDir("cap-receiver")];
  const daemons: Daemon[] = [];
  try {
    const { url } = (await adminFetch(r.url, "POST", "/v1/admin/invites", { max_uses: 2 })).body as { url: string };
    await joinNetwork(homes[0]!, url, { name: "sender" });
    await joinNetwork(homes[1]!, url, { name: "receiver" });
    for (const home of homes) {
      const d = new Daemon({ home, log: () => {} });
      await d.start();
      daemons.push(d);
    }
    await waitFor(() => daemons.every((d) => d.info().connected === true), 5000, "both connected");

    const capsule = join(homes[0]!, "dashboard.capsule.md");
    writeFileSync(capsule, '<!-- capsule {"v":1} -->\n# Capsule\n## Brief\n<!-- BRIEF:START -->\nA2A dashboard: Talk page needs push-to-talk polish.\n<!-- BRIEF:END -->\n## Sessions\n' + "lots of history\n".repeat(500));
    const sent = await daemons[0]!.send({ to: "receiver", text: "Can you take over this? Context attached.", attachments: readAttachments([capsule]), kind: "notify", expects_reply: false });
    assert.equal(sent.state === "queued" || sent.state === "delivered", true);

    const got = await ipcInbox(homes[1]!);
    const file = got.files![0]!;
    assert.equal(file.name, "dashboard.capsule.md");
    assert.equal(readFileSync(file.path, "utf8"), readFileSync(capsule, "utf8"));
    assert.equal(capsuleBrief(readFileSync(file.path, "utf8")), "A2A dashboard: Talk page needs push-to-talk polish.");

    // Agents (MCP) may only attach sealed capsules from outside the a2a folder.
    const outside = tempDir("cap-outside");
    const plain = join(outside, "id_ed25519");
    writeFileSync(plain, "-----BEGIN OPENSSH PRIVATE KEY-----");
    assert.throws(() => readCapsuleAttachments([plain], homes[0]!), /Only context capsules/);
    const unsealed = join(outside, "draft.capsule.md");
    writeFileSync(unsealed, "# not sealed");
    assert.throws(() => readCapsuleAttachments([unsealed], homes[0]!), /isn't a sealed capsule/);
    assert.throws(() => readCapsuleAttachments([capsule], homes[0]!), /inside the a2a folder/);
    cleanup(outside);

    assert.throws(() => readAttachments([capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule, capsule]), /limit is 180 KiB/);
  } finally {
    for (const d of daemons) await d.stop();
    await r.close();
    cleanup(r.dataDir, dir, ...homes);
  }
});

async function ipcInbox(home: string): Promise<{ files?: { name: string; path: string; bytes: number }[] }> {
  const { ipc } = await import("../packages/client/src/ipc.ts");
  let message: Record<string, unknown> | null = null;
  await waitFor(async () => !!(message = (await ipc<{ message: Record<string, unknown> | null }>(home, "POST", "/inbox/next", { wait_seconds: 0 })).message), 8000, "capsule delivered");
  return message as never;
}
