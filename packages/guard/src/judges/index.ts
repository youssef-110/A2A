import { spawnSync } from "node:child_process";
import type { JudgeMode } from "../policy.ts";
import { AnthropicJudge } from "./anthropic.ts";
import { ClaudeCliJudge } from "./claude-cli.ts";
import { HeuristicJudge } from "./heuristic.ts";
import type { JudgeSet } from "./types.ts";

export * from "./types.ts";
export { AnthropicJudge, ClaudeCliJudge, HeuristicJudge };

export const FAST_MODEL = process.env.A2A_GUARD_FAST_MODEL ?? "claude-haiku-5-5";
export const STRONG_MODEL = process.env.A2A_GUARD_STRONG_MODEL ?? "claude-sonnet-5-5";

let claudeAvailable: boolean | undefined;
function hasClaudeCli(): boolean {
  if (claudeAvailable === undefined) {
    const r = spawnSync(process.env.A2A_CLAUDE_BIN ?? "claude", ["--version"], { stdio: "ignore", timeout: 10_000 });
    claudeAvailable = r.status === 0;
  }
  return claudeAvailable;
}

/**
 * Picks the judges. `auto` prefers the Anthropic API when ANTHROPIC_API_KEY is set, then a
 * signed-in Claude Code CLI, then the offline heuristic judge. Returns null for `off`.
 */
export function createJudges(mode: JudgeMode): JudgeSet | null {
  if (mode === "off") return null;
  if (mode === "anthropic" || (mode === "auto" && process.env.ANTHROPIC_API_KEY)) {
    return { fast: new AnthropicJudge(FAST_MODEL, "low"), strong: new AnthropicJudge(STRONG_MODEL, "medium") };
  }
  if (mode === "claude-cli" || (mode === "auto" && hasClaudeCli())) {
    return { fast: new ClaudeCliJudge(process.env.A2A_GUARD_FAST_MODEL ?? "haiku"), strong: new ClaudeCliJudge(process.env.A2A_GUARD_STRONG_MODEL ?? "sonnet") };
  }
  return { fast: new HeuristicJudge() };
}
