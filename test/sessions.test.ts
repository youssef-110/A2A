import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAgentKeyPair, registerSigningString, signString } from "@a2a/protocol";
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

const robin: Account = { id: "usr_sam", email: "robin@example.com", name: "Robin", role: "member" };
const juno: Account = { id: "usr_ana", email: "juno@example.com", name: "Juno", role: "member" };
const kim: Account = { id: "usr_kim", email: "kim@example.com", name: "Kim", role: "member" };
const owner: Account = { id: "usr_lena", email: "ivy@example.com", name: "Ivy", role: "owner" };

test("session links need a signed-in account on the hosted relay, and let in several people up to the size", () => {
  const { relay, dir } = setup();
  try {
    const s = relay.createSession({ name: "Launch", max_members: 2 }, "admin");
    const code = relay.createInvite({ session_id: s.id, max_uses: s.max_members }, "admin").code;
    assert.equal(join_(relay, "anon", { invite: code }).body.error, "sign_in_required");
    assert.equal(join_(relay, "robin-claude", { invite: code, account: robin }).body.status, "active");
    assert.equal(join_(relay, "juno-claude", { invite: code, account: juno }).body.status, "active");
    // Robin's second agent doesn't take another place; a third person does not fit.
    assert.equal(join_(relay, "robin-antigravity", { invite: code, account: robin }).body.status, "active");
    assert.equal(join_(relay, "kim-claude", { invite: code, account: kim }).body.error, "session_full");
    assert.equal(relay.sessionDetail(s.id)!.people, 2);
    // Guests in the same session reach each other, including another person's second agent.
    assert.ok(relay.canTalk("agent://team/juno-claude", "agent://team/robin-antigravity"));
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
    join_(relay, "robin-claude", { invite: code, account: robin });
    // No invite: Robin already belongs here, so the new agent is active and in the same session.
    const r = join_(relay, "robin-gemini", { account: robin });
    assert.equal(r.body.status, "active");
    assert.deepEqual((r.body.sessions as { name: string }[]).map((x) => x.name), ["Launch"]);
    // The workspace owner's agents become owner agents and can all talk to each other.
    assert.equal(join_(relay, "ivy-claude", { account: owner }).body.status, "active");
    assert.equal(join_(relay, "ivy-antigravity", { account: owner }).body.status, "active");
    assert.ok(relay.isOwnerAgent("agent://team/ivy-antigravity"));
    assert.ok(relay.canTalk("agent://team/ivy-claude", "agent://team/ivy-antigravity"));
    assert.ok(relay.canTalk("agent://team/ivy-claude", "agent://team/robin-gemini"));
    // A stranger with no invite and no sessions waits for approval.
    assert.equal(join_(relay, "kim-claude", { account: kim }).body.status, "pending");
    // Someone else's account can't take over a name.
    assert.equal(join_(relay, "robin-claude", { account: kim }).body.error, "key_conflict");
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
    const s = relay.createSession({ name: "Launch", brief: "Ship v1 on Friday. Robin owns the API." }, "admin");
    const code = relay.createInvite({ session_id: s.id, max_uses: 10 }, "admin").code;
    join_(relay, "robin-claude", { invite: code, account: robin });
    join_(relay, "juno-claude", { invite: code, account: juno });
    assert.equal(relay.sessionsFor("agent://team/robin-claude")[0]!.brief, "Ship v1 on Friday. Robin owns the API.");
    assert.ok(relay.agentSetBrief("agent://team/juno-claude", s.id, "Ship v1 on Friday. Juno owns the UI."));
    assert.equal(relay.sessionDetail(s.id)!.brief, "Ship v1 on Friday. Juno owns the UI.");

    assert.ok(relay.deleteSession(s.id, "admin"));
    assert.equal(relay.sessionDetail(s.id), null);
    assert.equal(relay.canTalk("agent://team/robin-claude", "agent://team/juno-claude"), false);
    assert.deepEqual(notices.map((n) => n.kind), ["session_deleted", "session_deleted"]);
    assert.equal(relay.inviteInfo(code).valid, false);
    assert.equal(join_(relay, "kim-claude", { invite: code, account: kim }).body.error, "invalid_invite");
    assert.deepEqual(relay.sessionsFor("agent://team/robin-claude"), []);
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
    join_(relay, "robin-claude", { invite: code, account: robin });
    join_(relay, "robin-codex", { account: robin });
    assert.ok(relay.removeAccountFromSession(s.id, robin.id, "admin"));
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
    join_(relay, "juno-claude", { invite: c1, account: juno });
    join_(relay, "robin-claude", { invite: c1, account: robin });
    join_(relay, "robin-claude", { invite: c2, account: robin }); // Robin is in both sessions
    // The owner talks to Robin about session Two's business.
    const r = relay.consoleSend({ to: "agent://team/robin-claude", text: "Two's secret plan", scope: "general" }, "admin");
    assert.equal(r.status < 300, true, JSON.stringify(r.body));
    const anaView = relay.sessionDetail(s1.id, juno.id)!.messages as { text: string }[];
    assert.equal(anaView.length, 0, "Juno, only in One, must not see the owner's conversation with Robin");
    const samView = relay.sessionDetail(s1.id, robin.id)!.messages as unknown[];
    assert.equal(samView.length, 1, "Robin sees his own conversation");
  } finally {
    relay.db.close?.();
    cleanup(dir);
  }
});
