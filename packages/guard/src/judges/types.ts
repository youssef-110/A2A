import type { Finding } from "../scanners.ts";

export const JUDGE_CATEGORIES = [
  "none",
  "out_of_scope",
  "instruction_override",
  "credential_request",
  "data_exfiltration",
  "dangerous_action",
  "secret_detected",
  "pii",
  "social_engineering",
  "harassment",
  "other_policy",
] as const;

export type JudgeDecision = "allow" | "hold" | "block";

export interface JudgeInput {
  org: string;
  from: string;
  to: string;
  kind: string;
  scope: { name: string; description: string; keywords?: string[] };
  /** Earlier delivered messages in the thread, oldest first, already trimmed. Untrusted. */
  thread: { from: string; text: string }[];
  findings: Finding[];
  /** Normalized text with secrets masked. */
  text: string;
}

export interface JudgeOutput {
  decision: JudgeDecision;
  categories: string[];
  confidence: number;
  reason: string;
}

export interface Judge {
  /** e.g. "anthropic", "claude-cli", "heuristic" */
  kind: string;
  /** Model the judge runs on, for the audit trail. */
  model: string;
  judge(input: JudgeInput, opts: { timeoutMs: number }): Promise<JudgeOutput>;
}

export interface JudgeSet {
  fast: Judge;
  /** Stronger judge for low-confidence results. Optional. */
  strong?: Judge;
}

export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["allow", "hold", "block"] },
    categories: { type: "array", items: { type: "string", enum: [...JUDGE_CATEGORIES] } },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["decision", "categories", "confidence", "reason"],
} as const;

/** Validates whatever the model returned. Anything malformed throws, and the pipeline fails closed. */
export function coerceJudgeOutput(raw: unknown): JudgeOutput {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new Error("judge output is not an object");
  if (o.decision !== "allow" && o.decision !== "hold" && o.decision !== "block") throw new Error(`invalid judge decision: ${String(o.decision)}`);
  if (!Array.isArray(o.categories)) throw new Error("judge categories missing");
  if (typeof o.confidence !== "number" || Number.isNaN(o.confidence)) throw new Error("judge confidence missing");
  if (typeof o.reason !== "string") throw new Error("judge reason missing");
  const allowed = new Set<string>(JUDGE_CATEGORIES);
  const categories = (o.categories as unknown[]).filter((c): c is string => typeof c === "string" && allowed.has(c) && c !== "none");
  return {
    decision: o.decision,
    categories,
    confidence: Math.min(1, Math.max(0, o.confidence > 1 ? o.confidence / 100 : o.confidence)),
    reason: o.reason.slice(0, 600),
  };
}
