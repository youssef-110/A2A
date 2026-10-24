import { randomBytes } from "node:crypto";

// Crockford base32, as used by ULID.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48-bit millisecond timestamp + 80 random bits, lexicographically sortable. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(10);
  let rand = "";
  // 80 bits -> 16 base32 chars
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET[Number(acc & 31n)] + rand;
    acc >>= 5n;
  }
  return time + rand;
}

export const newMessageId = (): string => `msg_${ulid()}`;
export const newThreadId = (): string => `thr_${ulid()}`;
export const newRunId = (): string => `run_${ulid()}`;
