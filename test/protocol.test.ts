import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalize,
  generateAgentKeyPair,
  helloSigningString,
  newMessageId,
  newThreadId,
  signEnvelope,
  signRequestHeaders,
  signString,
  stricter,
  ulid,
  validateEnvelope,
  verifyEnvelope,
  verifyRequestSignature,
  verifyString,
} from "@a2a/protocol";

const keys = generateAgentKeyPair();
const base = () => ({
  v: 1,
  id: newMessageId(),
  thread_id: newThreadId(),
  in_reply_to: null,
  from: "agent://acme/a",
  to: "agent://acme/b",
  scope: "customer-support",
  kind: "request" as const,
  body: { text: "hello" },
  expects_reply: true,
  created_at: new Date().toISOString(),
});

test("canonical JSON sorts keys at every level and drops undefined", () => {
  assert.equal(canonicalize({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalize({ x: "é\n" }), '{"x":"é\\n"}');
});

test("ULIDs are 26 Crockford characters and sort by time", () => {
  const a = ulid(1_700_000_000_000);
  const b = ulid(1_700_000_000_001);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a < b);
});

test("a signed envelope verifies, and any change breaks the signature", () => {
  const env = signEnvelope(base(), keys.privateKeyPem);
  assert.equal(validateEnvelope(env), null);
  assert.ok(verifyEnvelope(env, keys.publicKey));
  assert.ok(!verifyEnvelope({ ...env, body: { text: "hellO" } }, keys.publicKey));
  assert.ok(!verifyEnvelope({ ...env, to: "agent://acme/c" }, keys.publicKey));
  assert.ok(!verifyEnvelope(env, generateAgentKeyPair().publicKey));
  // Key order in the transmitted JSON does not matter.
  const { sig, body, ...rest } = env;
  const reordered = JSON.parse(JSON.stringify({ sig, body, ...rest }));
  assert.ok(verifyEnvelope(reordered, keys.publicKey));
});

test("envelope validation rejects malformed input", () => {
  const env = signEnvelope(base(), keys.privateKeyPem);
  assert.match(validateEnvelope({ ...env, extra: 1 })!, /unknown field/);
  assert.match(validateEnvelope({ ...env, from: "acme/a" })!, /from must be/);
  assert.match(validateEnvelope({ ...env, to: env.from })!, /cannot message itself/);
  assert.match(validateEnvelope({ ...env, kind: "reply" })!, /needs in_reply_to/);
  assert.match(validateEnvelope({ ...env, id: "msg_123" })!, /id must be/);
  assert.match(validateEnvelope({ ...env, body: { text: "x", html: "<b>" } })!, /unknown body field/);
  assert.match(validateEnvelope({ ...env, v: 2 })!, /unsupported protocol version/);
});

test("request signatures are bound to method, path and a time window", () => {
  const h = signRequestHeaders("agent://acme/a", keys.privateKeyPem, "GET", "/v1/directory");
  assert.ok(verifyRequestSignature(keys.publicKey, "GET", "/v1/directory", h["a2a-timestamp"]!, h["a2a-signature"]!));
  assert.ok(!verifyRequestSignature(keys.publicKey, "GET", "/v1/threads/x", h["a2a-timestamp"]!, h["a2a-signature"]!));
  assert.ok(!verifyRequestSignature(keys.publicKey, "GET", "/v1/directory", h["a2a-timestamp"]!, h["a2a-signature"]!, Date.now() + 10 * 60_000));
});

test("hello signatures are bound to the nonce", () => {
  const sig = signString(helloSigningString("n1", "agent://acme/a"), keys.privateKeyPem);
  assert.ok(verifyString(helloSigningString("n1", "agent://acme/a"), sig, keys.publicKey));
  assert.ok(!verifyString(helloSigningString("n2", "agent://acme/a"), sig, keys.publicKey));
});

test("stricter() only moves toward block", () => {
  assert.equal(stricter("allow", "hold"), "hold");
  assert.equal(stricter("block", "allow"), "block");
  assert.equal(stricter("redact", "hold"), "hold");
  assert.equal(stricter("redact", "allow"), "redact");
});
