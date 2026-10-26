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
