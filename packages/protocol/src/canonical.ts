import { createHash } from "node:crypto";

/**
 * Canonical JSON (RFC 8785 subset): object keys sorted by code unit, no whitespace,
 * `undefined` members dropped. Enough for the envelope, which only holds strings,
 * booleans, integers, null, arrays and plain objects.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number in canonical JSON");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`unsupported type in canonical JSON: ${typeof value}`);
}

export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
