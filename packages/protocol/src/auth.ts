import type { KeyObject } from "node:crypto";
import { signString, verifyString } from "./crypto.ts";

/**
 * Agents authenticate read requests by signing `METHOD\nPATH\nTIMESTAMP` with their key.
 * Headers: a2a-agent, a2a-timestamp, a2a-signature.
 */
export const AUTH_WINDOW_MS = 5 * 60 * 1000;

export function requestSigningString(method: string, path: string, timestamp: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}`;
}

export function signRequestHeaders(agent: string, key: KeyObject | string, method: string, path: string): Record<string, string> {
  const ts = new Date().toISOString();
  return {
    "a2a-agent": agent,
    "a2a-timestamp": ts,
    "a2a-signature": signString(requestSigningString(method, path, ts), key),
  };
}

export function verifyRequestSignature(
  publicKeyB64: string,
  method: string,
  path: string,
  timestamp: string,
  signature: string,
  now = Date.now(),
): boolean {
  const t = Date.parse(timestamp);
  if (Number.isNaN(t) || Math.abs(now - t) > AUTH_WINDOW_MS) return false;
  return verifyString(requestSigningString(method, path, timestamp), signature, publicKeyB64);
}

/** What a daemon signs to prove it holds an agent's key when opening the delivery stream. */
export const helloSigningString = (nonce: string, address: string): string => `a2a-hello\n${nonce}\n${address}`;

/** What a new agent signs to prove possession of its key when it asks to be registered. */
export const registerSigningString = (address: string, publicKey: string, timestamp: string): string =>
  `a2a-register\n${address}\n${publicKey}\n${timestamp}`;
