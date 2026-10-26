import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKeyPair, newMessageId, newThreadId, registerSigningString, signEnvelope, signString, type Envelope } from "@a2a/protocol";
import { Relay, type Account } from "../packages/server/src/relay.ts";
import { openDb } from "../packages/server/src/db-node.ts";
import { cleanup, tempDir } from "./helpers.ts";

const POLICY = "org: team\nregistration: invite\nisolation: sessions\nscopes:\n  general:\n    description: Anything.\nrules:\n  block: []\n  hold: []\n  redact: []\nguard:\n  judge: off\n";

function setup(requireAccount = true): { relay: Relay; dir: string } {
  const dir = tempDir("sessions");
  writeFileSync(join(dir, "policy.yaml"), POLICY);
  const { privateKeyPem } = generateAgentKeyPair();
  const relay = new Relay({ db: openDb(join(dir, "relay.db")), relayKeyPem: privateKeyPem, initialPolicy: POLICY, judges: null, requireAccount });
  return { relay, dir };
}

/** Registers agent://team/<name> the way a client does, optionally as a signed-in account. */
function join_(relay: Relay, name: string, opts: { invite?: string; account?: Account } = {}) {
  const { privateKeyPem, publicKey } = generateAgentKeyPair();
  const address = `agent://team/${name}`;
  const timestamp = new Date().toISOString();
  const proof = signString(registerSigningString(address, publicKey, timestamp), privateKeyPem);
  return relay.register({ address, public_key: publicKey, timestamp, proof, invite: opts.invite }, false, opts.account);
}

const sam: Account = { id: "usr_sam", email: "sam@example.com", name: "Sam", role: "member" };
const ana: Account = { id: "usr_ana", email: "ana@example.com", name: "Ana", role: "member" };
const kim: Account = { id: "usr_kim", email: "kim@example.com", name: "Kim", role: "member" };
const owner: Account = { id: "usr_lena", email: "lena@example.com", name: "Lena", role: "owner" };

test("session links need a signed-in account on the hosted relay, and let in several people up to the size", () => {
  const { relay, dir } = setup();
  try {
    const s = relay.createSession({ name: "Launch", max_members: 2 }, "admin");
    const code = relay.createInvite({ session_id: s.id, max_uses: s.max_members }, "admin").code;
    assert.equal(join_(relay, "anon", { invite: code }).body.error, "sign_in_required");
    assert.equal(join_(relay, "sam-claude", { invite: code, account: sam }).body.status, "active");
    assert.equal(join_(relay, "ana-claude", { invite: code, account: ana }).body.status, "active");
    // Sam's second agent doesn't take another place; a third person does not fit.
    assert.equal(join_(relay, "sam-antigravity", { invite: code, account: sam }).body.status, "active");
    assert.equal(join_(relay, "kim-claude", { invite: code, account: kim }).body.error, "session_full");
    assert.equal(relay.sessionDetail(s.id)!.people, 2);
    // Guests in the same session reach each other, including another person's second agent.
    assert.ok(relay.canTalk("agent://team/ana-claude", "agent://team/sam-antigravity"));
    assert.equal(relay.inviteInfo(code).sign_in_required, true);
  } finally {
    relay.db.close?.();
    cleanup(dir);
  }
});

test("a signed-in person's new agents join their sessions and the owner's agents without a new link", () => {
  const { relay, dir } = setup();
  try {
    const s = relay.createSession({ name: "Launch" }, "admin");
    const code = relay.createInvite({ session_id: s.id, max_uses: 10 }, "admin").code;
    join_(relay, "sam-claude", { invite: code, account: sam });
    // No invite: Sam already belongs here, so the new agent is active and in the same session.
    const r = join_(relay, "sam-gemini", { account: sam });
    assert.equal(r.body.status, "active");
    assert.deepEqual((r.body.sessions as { name: string }[]).map((x) => x.name), ["Launch"]);
    // The workspace owner's agents become owner agents and can all talk to each other.
    assert.equal(join_(relay, "lena-claude", { account: owner }).body.status, "active");
    assert.equal(join_(relay, "lena-antigravity", { account: owner }).body.status, "active");
    assert.ok(relay.isOwnerAgent("agent://team/lena-antigravity"));
    assert.ok(relay.canTalk("agent://team/lena-claude", "agent://team/lena-antigravity"));
    assert.ok(relay.canTalk("agent://team/lena-claude", "agent://team/sam-gemini"));
    // A stranger with no invite and no sessions waits for approval.
    assert.equal(join_(relay, "kim-claude", { account: kim }).body.status, "pending");
    // Someone else's account can't take over a name.
    assert.equal(join_(relay, "sam-claude", { account: kim }).body.error, "key_conflict");
  } finally {
    relay.db.close?.();
    cleanup(dir);
  }
});

test("deleting a session cuts everyone off, tells connected guests, and kills its link", () => {
  const { relay, dir } = setup();
  const notices: { address: string; kind: unknown }[] = [];
  relay.out = { deliver: () => 0, status: () => {}, isOnline: () => false, disconnect: () => {}, onlineAgents: () => [], notice: (address, n) => notices.push({ address, kind: n.kind }) };
  try {
    const s = relay.createSession({ name: "Launch", brief: "Ship v1 on Friday. Sam owns the API." }, "admin");
    const code = relay.createInvite({ session_id: s.id, max_uses: 10 }, "admin").code;
    join_(relay, "sam-claude", { invite: code, account: sam });
    join_(relay, "ana-claude", { invite: code, account: ana });
    assert.equal(relay.sessionsFor("agent://team/sam-claude")[0]!.brief, "Ship v1 on Friday. Sam owns the API.");
    assert.ok(relay.agentSetBrief("agent://team/ana-claude", s.id, "Ship v1 on Friday. Ana owns the UI."));
    assert.equal(relay.sessionDetail(s.id)!.brief, "Ship v1 on Friday. Ana owns the UI.");

    assert.ok(relay.deleteSession(s.id, "admin"));
    assert.equal(relay.sessionDetail(s.id), null);
    assert.equal(relay.canTalk("agent://team/sam-claude", "agent://team/ana-claude"), false);
    assert.deepEqual(notices.map((n) => n.kind), ["session_deleted", "session_deleted"]);
    assert.equal(relay.inviteInfo(code).valid, false);
    assert.equal(join_(relay, "kim-claude", { invite: code, account: kim }).body.error, "invalid_invite");
    assert.deepEqual(relay.sessionsFor("agent://team/sam-claude"), []);
  } finally {
    relay.db.close?.();
    cleanup(dir);
  }
});

test("removing a person takes all of their agents out; the Node relay doesn't ask for accounts", () => {
  const { relay, dir } = setup();
  try {
    const s = relay.createSession({ name: "Launch" }, "admin");
    const code = relay.createInvite({ session_id: s.id, max_uses: 10 }, "admin").code;
    join_(relay, "sam-claude", { invite: code, account: sam });
    join_(relay, "sam-codex", { account: sam });
    assert.ok(relay.removeAccountFromSession(s.id, sam.id, "admin"));
    assert.equal(relay.sessionDetail(s.id)!.people, 0);
  } finally {
    relay.db.close?.();
    cleanup(dir);
  }
  const node = setup(false);
  try {
    const s = node.relay.createSession({ name: "Open" }, "admin");
    const code = node.relay.createInvite({ session_id: s.id }, "admin").code;
    assert.equal(join_(node.relay, "guest", { invite: code }).body.status, "active");
  } finally {
    node.relay.db.close?.();
    cleanup(node.dir);
  }
});

test("a guest's view of a session shows only conversations their own agents took part in", () => {
  const { relay, dir } = setup();
  try {
    const s1 = relay.createSession({ name: "One" }, "admin");
    const s2 = relay.createSession({ name: "Two" }, "admin");
    const c1 = relay.createInvite({ session_id: s1.id }, "admin").code;
    const c2 = relay.createInvite({ session_id: s2.id }, "admin").code;
    join_(relay, "ana-claude", { invite: c1, account: ana });
    join_(relay, "sam-claude", { invite: c1, account: sam });
    join_(relay, "sam-claude", { invite: c2, account: sam }); // Sam is in both sessions
    // The owner talks to Sam about session Two's business.
    const r = relay.consoleSend({ to: "agent://team/sam-claude", text: "Two's secret plan", scope: "general" }, "admin");
    assert.equal(r.status < 300, true, JSON.stringify(r.body));
    const anaView = relay.sessionDetail(s1.id, ana.id)!.messages as { text: string }[];
    assert.equal(anaView.length, 0, "Ana, only in One, must not see the owner's conversation with Sam");
    const samView = relay.sessionDetail(s1.id, sam.id)!.messages as unknown[];
    assert.equal(samView.length, 1, "Sam sees his own conversation");
  } finally {
    relay.db.close?.();
    cleanup(dir);
  }
});

/** Like join_, but keeps the key so the test can send as the agent. */
function agent(relay: Relay, name: string, opts: { invite?: string; account?: Account } = {}) {
  const { privateKeyPem, publicKey } = generateAgentKeyPair();
  const address = `agent://team/${name}`;
  const timestamp = new Date().toISOString();
  const proof = signString(registerSigningString(address, publicKey, timestamp), privateKeyPem);
  const r = relay.register({ address, public_key: publicKey, timestamp, proof, invite: opts.invite }, false, opts.account);
  return { address, key: privateKeyPem, status: r.body.status as string };
}

async function send(relay: Relay, from: { address: string; key: string }, to: string, text: string, reply?: { thread_id: string; id: string }): Promise<{ id: string; thread_id: string; state: string; reason_code: string | null }> {
  const env: Envelope = signEnvelope(
    { v: 1, id: newMessageId(), thread_id: reply?.thread_id ?? newThreadId(), in_reply_to: reply?.id || null, from: from.address, to, scope: "general", kind: reply?.id ? "reply" : "request", body: { text }, expects_reply: !reply?.id, created_at: new Date().toISOString() },
    from.key,
  );
  const r = relay.submit(env);
  await relay.idle();
  const row = relay.getMessage(env.id);
  return { id: env.id, thread_id: env.thread_id, state: row?.state ?? String(r.body.error), reason_code: row?.reason_code ?? null };
}

test("a registration proof with an unparseable timestamp is refused, so it can't be replayed forever", () => {
  const { relay, dir } = setup(false);
  try {
    const { privateKeyPem, publicKey } = generateAgentKeyPair();
    const address = "agent://team/replay";
    for (const timestamp of ["not-a-date", ""]) {
      const proof = signString(registerSigningString(address, publicKey, timestamp), privateKeyPem);
      const r = relay.register({ address, public_key: publicKey, timestamp, proof }, true);
      assert.equal(r.body.error, "stale_timestamp", `timestamp ${JSON.stringify(timestamp)}`);
    }
    assert.equal(relay.getAgent(address), undefined);
  } finally {
    relay.db.close?.();
    cleanup(dir);
  }
});

test("someone removed from a session can't keep talking by replying, or keep reading the thread", async () => {
  const { relay, dir } = setup();
  try {
    const s = relay.createSession({ name: "Launch" }, "admin");
    const code = relay.createInvite({ session_id: s.id, max_uses: 10 }, "admin").code;
    const lena = agent(relay, "lena-claude", { account: owner });
    const samA = agent(relay, "sam-claude", { invite: code, account: sam });
    const anaA = agent(relay, "ana-claude", { invite: code, account: ana });

    const ask = await send(relay, lena, samA.address, "Is the API schema final?");
    assert.equal(ask.state, "queued");
    const answer = await send(relay, samA, lena.address, "Yes, frozen since Monday.", ask);
    assert.equal(answer.state, "queued");
    // Lena also brings Ana into the same thread.
    const toAna = await send(relay, lena, anaA.address, "Ana, can you start on the UI?", { thread_id: ask.thread_id, id: "" });
    assert.equal(toAna.state, "queued");

    assert.ok(relay.removeAccountFromSession(s.id, sam.id, "admin"));
    // Replying to an old message is no longer a way back in.
    const late = await send(relay, samA, lena.address, "Still here, one more thing.", ask);
    assert.equal(late.state, "blocked");
    assert.equal(late.reason_code, "not_in_session");

    // The thread goes on between Lena and Ana; Sam, still a participant, no longer sees their messages.
    const more = await send(relay, lena, anaA.address, "Mockups are in the brief.", { thread_id: ask.thread_id, id: "" });
    assert.equal(more.state, "queued");
    const samSees = (relay.threadFor(samA.address, ask.thread_id)!.messages as { id: string }[]).map((m) => m.id);
    assert.deepEqual(samSees.sort(), [ask.id, answer.id, late.id].sort(), "Sam keeps only the messages he sent or received");
    const anaSees = (relay.threadFor(anaA.address, ask.thread_id)!.messages as { id: string }[]).map((m) => m.id);
    assert.deepEqual(anaSees.sort(), [toAna.id, more.id].sort(), "Ana no longer shares a session with Sam either");
  } finally {
    relay.db.close?.();
    cleanup(dir);
  }
});

test("resetting a taken-over account disables its agents and revokes owner links", () => {
  const { relay, dir } = setup();
  try {
    const s = relay.createSession({ name: "Launch" }, "admin");
    const code = relay.createInvite({ session_id: s.id, max_uses: 10 }, "admin").code;
    const planted = agent(relay, "lena-claude", { account: owner });
    const guest = agent(relay, "lena-guest", { invite: code, account: owner });
    const other = agent(relay, "sam-claude", { invite: code, account: sam });
    const ownerLink = relay.createInvite({ owner: true, max_uses: 1 }, "admin").code;
    assert.equal(planted.status, "active");

    const r = relay.resetAccount(owner.id, "admin", { revokeOwnerInvites: true });
    assert.deepEqual(r.disabled.sort(), [guest.address, planted.address].sort());
    assert.equal(relay.getAgent(planted.address)!.status, "disabled");
    assert.equal(relay.getAgent(other.address)!.status, "active", "other people's agents are untouched");
    assert.equal(relay.inviteInfo(ownerLink).valid, false);
    assert.equal(relay.inviteInfo(code).valid, true, "session links stay");
    // The old key can't bring the agent back by registering again.
    const timestamp = new Date().toISOString();
    const publicKey = relay.getAgent(planted.address)!.public_key;
    const again = relay.register({ address: planted.address, public_key: publicKey, timestamp, proof: signString(registerSigningString(planted.address, publicKey, timestamp), planted.key) }, false, owner);
    assert.equal(again.body.status, "disabled");
  } finally {
    relay.db.close?.();
    cleanup(dir);
  }
});
