// The "try the guard" box on the landing page. It runs the relay's real first-pass checks (the
// normalizer and the pattern scanners from packages/guard) in the browser, with the hosted relay's
// default rules. Build: pnpm build:guard-demo (writes packages/web/public/guard-demo.js).
import "./buffer-shim.ts";
import { normalize } from "../../packages/guard/src/normalize.ts";
import { scan, type Finding } from "../../packages/guard/src/scanners.ts";

// Mirrors the rules in packages/cloud/src/policy.ts: nothing blocked, these held, these masked.
const HOLD = new Set(["credential_request", "data_exfiltration", "pii"]);
const MASK = new Set(["secret_detected", "payment_card"]);

export type Verdict = "delivered" | "masked" | "held";

export interface Check {
  verdict: Verdict;
  /** The text as the relay normalizes it; spans below index into this. */
  text: string;
  spans: { start: number; end: number; kind: "held" | "masked"; detail: string }[];
  reasons: string[];
  ms: number;
}

export function check(input: string): Check {
  const t = performance.now();
  const n = normalize(input);
  const findings: Finding[] = scan(n);
  let verdict: Verdict = "delivered";
  const spans: Check["spans"] = [];
  const reasons = new Set<string>();
  for (const f of findings) {
    const held = HOLD.has(f.category);
    const masked = MASK.has(f.category);
    if (!held && !masked) continue;
    // A secret the scanner cannot locate cannot be masked, so the relay holds the whole message.
    if (held || f.start === undefined) verdict = "held";
    else if (verdict === "delivered") verdict = "masked";
    reasons.add(f.detail);
    if (f.start !== undefined && f.end !== undefined) spans.push({ start: f.start, end: f.end, kind: held ? "held" : "masked", detail: f.detail });
  }
  spans.sort((a, b) => a.start - b.start);
  return { verdict, text: n.text, spans, reasons: [...reasons], ms: performance.now() - t };
}
