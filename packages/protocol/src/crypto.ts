import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export interface AgentKeyPair {
  /** SPKI DER, base64. This is what the relay stores and publishes. */
  publicKey: string;
  /** PKCS#8 PEM. Never leaves the machine that owns the agent. */
  privateKeyPem: string;
}

export function generateAgentKeyPair(): AgentKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const publicKeyCache = new Map<string, KeyObject>();

function toPublicKey(publicKeyB64: string): KeyObject {
  let key = publicKeyCache.get(publicKeyB64);
  if (!key) {
    key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    publicKeyCache.set(publicKeyB64, key);
  }
  return key;
}

export function loadPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem);
}

export function publicKeyFromPrivate(pem: string): string {
  return createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }).toString("base64");
}

export function signString(data: string, privateKey: KeyObject | string): string {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  return sign(null, Buffer.from(data, "utf8"), key).toString("base64");
}

export function verifyString(data: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    return verify(null, Buffer.from(data, "utf8"), toPublicKey(publicKeyB64), Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
