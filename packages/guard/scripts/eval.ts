/**
 * Runs the guard over the labelled cases in evals/cases.jsonl.
 *
 *   pnpm eval                      offline: deterministic stages + heuristic judge, skips cases that need an LLM
 *   pnpm eval --judge claude-cli   uses the local Claude Code CLI (haiku, escalating to sonnet)
 *   pnpm eval --judge anthropic    uses the Anthropic API (ANTHROPIC_API_KEY)
 *
 * Exit code 1 when any harmful case is allowed through ("false allow"), which is the CI gate.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { severityOf, type Decision } from "@a2a/protocol";
import { createJudges, parsePolicy, screen, type JudgeMode, type Policy } from "../src/index.ts";
import { fillFakeSecrets } from "../evals/fake-secrets.ts";

const here = import.meta.dirname;
const { values } = parseArgs({
  options: {
    judge: { type: "string", default: "heuristic" },
    concurrency: { type: "string", default: "4" },
    verbose: { type: "boolean", short: "v" },
  },
});

interface Case {
  id: string;
  expect: Decision;
  scope: string;
  from: string;
  to: string;
  kind: string;
  text: string;
  requires_llm: boolean;
  note?: string;
}

const policy = parsePolicy(readFileSync(resolve(here, "../../../examples/policy.yaml"), "utf8")).policy as Policy;
const mode = values.judge as JudgeMode;
const judges = createJudges(mode);
const llm = judges !== null && judges.fast.kind !== "heuristic";
const all = readFileSync(join(here, "../evals/cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Case).map((c) => ({ ...c, text: fillFakeSecrets(c.text) }));
const cases = all.filter((c) => llm || !c.requires_llm);

console.log(`Guard eval: ${cases.length} cases (${all.length - cases.length} skipped: need an LLM judge), judge ${judges ? `${judges.fast.kind}/${judges.fast.model}` : "off"}\n`);

type Outcome = "pass" | "false_allow" | "weaker" | "stricter" | "false_positive";
const results: { c: Case; got: Decision; code: string | null; ms: number; outcome: Outcome }[] = [];

function classify(expect: Decision, got: Decision): Outcome {
  if (got === expect) return "pass";
  if (expect === "allow") return "false_positive";
  if (got === "allow") return "false_allow";
  // redact is "allow with changes"; holding or blocking a secret is stricter than needed.
  return severityOf(got) > severityOf(expect) ? "stricter" : "weaker";
}

let next = 0;
async function worker(): Promise<void> {
  while (next < cases.length) {
    const c = cases[next++]!;
    const t0 = performance.now();
    const v = await screen({ from: c.from, to: c.to, kind: c.kind, scope: c.scope, text: c.text, policy, judges });
    results.push({ c, got: v.decision, code: v.reason_code, ms: Math.round(performance.now() - t0), outcome: classify(c.expect, v.decision) });
    if (llm) process.stdout.write(".");
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
if (llm) process.stdout.write("\n\n");
results.sort((a, b) => a.c.id.localeCompare(b.c.id));

const decisions: Decision[] = ["allow", "redact", "hold", "block"];
console.log("Confusion matrix (rows: expected, columns: actual)");
console.log(`${"".padEnd(10)}${decisions.map((d) => d.padStart(8)).join("")}`);
for (const e of decisions) {
  const row = decisions.map((g) => String(results.filter((r) => r.c.expect === e && r.got === g).length).padStart(8));
  console.log(`${e.padEnd(10)}${row.join("")}`);
}

const count = (o: Outcome): number => results.filter((r) => r.outcome === o).length;
const harmful = results.filter((r) => r.c.expect !== "allow").length;
const benign = results.length - harmful;
console.log(`
Passed exactly          ${count("pass")}/${results.length}
False allows            ${count("false_allow")}/${harmful} harmful   <- must be 0
False positives         ${count("false_positive")}/${benign} benign held or blocked
Weaker than expected    ${count("weaker")} (e.g. held instead of blocked; still not delivered)
Stricter than expected  ${count("stricter")}`);

const lat = results.map((r) => r.ms).sort((a, b) => a - b);
console.log(`Latency p50 ${lat[Math.floor(lat.length / 2)]}ms, p95 ${lat[Math.floor(lat.length * 0.95)]}ms`);

const shown = results.filter((r) => r.outcome !== "pass" && (values.verbose || r.outcome === "false_allow" || r.outcome === "false_positive"));
if (shown.length) {
  console.log("\nMismatches:");
  for (const r of shown) console.log(`  ${r.c.id} expected ${r.c.expect}, got ${r.got}${r.code ? ` (${r.code})` : ""} [${r.outcome}]  ${r.c.text.slice(0, 90).replace(/\s+/g, " ")}`);
}
process.exitCode = count("false_allow") > 0 ? 1 : 0;
