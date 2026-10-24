import { performance } from "node:perf_hooks";
import { severityOf, stricter, type Decision } from "@a2a/protocol";
import { normalize } from "./normalize.ts";
import { scan, type AttachmentInput, type Finding } from "./scanners.ts";
import { actionFor, type Policy } from "./policy.ts";
import type { Judge, JudgeInput, JudgeOutput, JudgeSet } from "./judges/types.ts";

export type StageName = "envelope" | "scanners" | "judge" | "escalation";

export interface StageResult {
  stage: StageName;
  decision: Decision;
  categories: string[];
  reason: string;
  latency_ms: number;
  confidence?: number;
  model?: string;
  error?: boolean;
}

export interface Redaction {
  start: number;
  end: number;
  category: string;
  detail: string;
}

export interface Verdict {
  decision: Decision;
  /** Short code the sender is told. Never the full reasoning, so it can't be used to tune around the guard. */
  reason_code: string | null;
  /** Full reason, for admins. */
  reason: string;
  categories: string[];
  stages: StageResult[];
  findings: Finding[];
  normalized_text: string;
  /** What the recipient receives: normalized, with redactions applied. */
  delivered_text: string;
  redactions: Redaction[];
}

export interface ScreenInput {
  from: string;
  to: string;
  kind: string;
  scope: string;
  text: string;
  attachments?: AttachmentInput[];
  thread?: { from: string; text: string }[];
  policy: Policy;
  judges: JudgeSet | null;
}

const elapsed = (t0: number): number => Math.round(performance.now() - t0);

function mergeSpans(spans: Redaction[]): Redaction[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Redaction[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export function applyRedactions(text: string, spans: Redaction[], label: (r: Redaction) => string): string {
  let out = "";
  let pos = 0;
  for (const r of mergeSpans(spans)) {
    out += text.slice(pos, r.start) + label(r);
    pos = r.end;
  }
  return out + text.slice(pos);
}

async function runJudge(judge: Judge, input: JudgeInput, timeoutMs: number): Promise<{ out?: JudgeOutput; error?: string; ms: number }> {
  const t0 = performance.now();
  try {
    return { out: await judge.judge(input, { timeoutMs }), ms: elapsed(t0) };
  } catch (err) {
    return { error: (err as Error).message, ms: elapsed(t0) };
  }
}

/**
 * Stages 2 to 4 of the guard. Stage 1 (envelope checks) runs on the relay, which owns the
 * database, and is passed in through `priorStages` only for the audit trail.
 *
 * Invariants:
 * - The LLM can only make a decision stricter than the deterministic stages, never more lenient.
 * - Any judge failure (error, timeout, unparseable output) resolves to policy.guard.on_error.
 */
export async function screen(input: ScreenInput, priorStages: StageResult[] = []): Promise<Verdict> {
  const { policy } = input;
  const stages: StageResult[] = [...priorStages];
  const deciding: { decision: Decision; category: string; reason: string }[] = [];

  // Stage 2: normalization and deterministic scanners.
  const t2 = performance.now();
  const n = normalize(input.text);
  const findings = scan(n, input.attachments);
  let scannerDecision: Decision = "allow";
  const scannerCats = new Set<string>();
  const redactions: Redaction[] = [];
  for (const f of findings) {
    let action = actionFor(policy.rules, f.category);
    if (!action) continue;
    if (action === "redact") {
      if (f.start === undefined || f.end === undefined) action = "hold";
      else redactions.push({ start: f.start, end: f.end, category: f.category, detail: f.detail });
    }
    scannerDecision = stricter(scannerDecision, action);
    scannerCats.add(f.category);
    deciding.push({ decision: action, category: f.category, reason: f.detail });
  }
  const scannerReason = findings.length
    ? [...new Set(findings.map((f) => f.detail))].slice(0, 6).join("; ")
    : "No deterministic findings.";
  stages.push({ stage: "scanners", decision: scannerDecision, categories: [...scannerCats], reason: scannerReason, latency_ms: elapsed(t2) });

  let decision: Decision = stricter("allow", scannerDecision);
  for (const s of priorStages) decision = stricter(decision, s.decision);

  // Stages 3 and 4: the LLM judge, skipped when the deterministic stages already block.
  if (decision !== "block" && input.judges) {
    const secretSpans: Redaction[] = findings
      .filter((f) => f.category === "secret_detected" && f.start !== undefined)
      .map((f) => ({ start: f.start!, end: f.end!, category: f.category, detail: f.detail }));
    const scopeDef = policy.scopes[input.scope];
    const judgeInput: JudgeInput = {
      org: policy.org,
      from: input.from,
      to: input.to,
      kind: input.kind,
      scope: { name: input.scope, description: scopeDef?.description ?? "(unknown scope)", keywords: scopeDef?.keywords },
      thread: (input.thread ?? []).slice(-6),
      // Findings the policy already handles by redaction are not the judge's concern.
      findings: findings.filter((f) => !(f.category === "secret_detected" && f.start !== undefined && actionFor(policy.rules, f.category) === "redact")),
      text: applyRedactions(n.text, secretSpans, () => "[SECRET]"),
    };

    const { fast, strong } = input.judges;
    const first = await runJudge(fast, judgeInput, policy.guard.timeout_ms);
    let final: JudgeOutput | undefined = first.out;
    stages.push(
      first.out
        ? { stage: "judge", decision: first.out.decision, categories: first.out.categories, confidence: first.out.confidence, reason: first.out.reason, model: fast.model, latency_ms: first.ms }
        : { stage: "judge", decision: policy.guard.on_error, categories: ["guard_unavailable"], reason: `Judge failed: ${first.error}`, model: fast.model, latency_ms: first.ms, error: true },
    );

    const unsure = !first.out || first.out.confidence < policy.guard.min_confidence;
    if (unsure && policy.guard.escalate && strong) {
      const second = await runJudge(strong, judgeInput, policy.guard.timeout_ms);
      stages.push(
        second.out
          ? { stage: "escalation", decision: second.out.decision, categories: second.out.categories, confidence: second.out.confidence, reason: second.out.reason, model: strong.model, latency_ms: second.ms }
          : { stage: "escalation", decision: policy.guard.on_error, categories: ["guard_unavailable"], reason: `Escalation judge failed: ${second.error}`, model: strong.model, latency_ms: second.ms, error: true },
      );
      final = second.out;
    }

    if (!final) {
      decision = stricter(decision, policy.guard.on_error);
      deciding.push({ decision: policy.guard.on_error, category: "guard_unavailable", reason: "The guard could not reach a verdict, so the message was not delivered automatically." });
    } else {
      let judged: Decision = final.decision;
      const cats = final.categories.length ? final.categories : judged === "allow" ? [] : ["other_policy"];
      if (final.confidence < policy.guard.min_confidence && judged === "allow") {
        judged = "hold";
        cats.push("low_confidence");
      }
      decision = stricter(decision, judged);
      for (const c of cats) deciding.push({ decision: judged, category: c, reason: final.reason });
      if (judged !== "allow" && cats.length === 0) deciding.push({ decision: judged, category: "other_policy", reason: final.reason });
    }
  }

  // The reason code comes from the most severe thing that drove the decision.
  const driver = deciding
    .filter((d) => d.decision === decision)
    .sort((a, b) => severityOf(b.decision) - severityOf(a.decision))[0];
  const priorDriver = priorStages.find((s) => s.decision === decision && s.categories.length);
  const reason_code = decision === "allow" ? null : (priorDriver?.categories[0] ?? driver?.category ?? "policy");
  const reason = decision === "allow"
    ? (stages.findLast((s) => s.stage === "judge" || s.stage === "escalation")?.reason ?? "No policy concerns found.")
    : (priorDriver?.reason ?? driver?.reason ?? "Policy decision.");

  const categories = [...new Set(deciding.filter((d) => severityOf(d.decision) > 0).map((d) => d.category))];
  const delivered_text = redactions.length ? applyRedactions(n.text, redactions, (r) => `[REDACTED ${r.detail.toLowerCase()}]`) : n.text;

  return { decision, reason_code, reason, categories, stages, findings, normalized_text: n.text, delivered_text, redactions: mergeSpans(redactions) };
}
