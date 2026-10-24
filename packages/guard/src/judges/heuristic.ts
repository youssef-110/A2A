import type { Judge, JudgeInput, JudgeOutput } from "./types.ts";

const STOPWORDS = new Set("a an and are as at be by can could do for from has have how i in is it me my of on or our please the this to us we what when where which who why will with you your".split(" "));

const OFF_TOPIC_ACTIONS =
  /\b(?:deploy|release to prod(?:uction)?|merge (?:the|this|my) (?:pr|pull request)|change (?:the )?(?:prices?|pricing)|wire|transfer (?:funds|money|\$)|approve (?:the )?(?:payment|invoice|purchase)|grant (?:admin|access)|delete (?:the |all )?(?:users?|accounts?|records?|data)|reset (?:the )?(?:password|database))\b/i;

/**
 * Offline judge for tests, CI and machines without an LLM. It only adds scope checking by
 * keyword overlap and a few action patterns on top of the deterministic scanners, so it is
 * deliberately less capable than the LLM judges and reports lower confidence.
 */
export class HeuristicJudge implements Judge {
  readonly kind = "heuristic";
  readonly model = "heuristic-v1";

  async judge(input: JudgeInput): Promise<JudgeOutput> {
    const text = input.text.toLowerCase();
    // Replies answer something that was already screened; they still pass every scanner, but the
    // topic checks below would mostly catch an agent quoting or declining the request.
    if (input.kind === "reply") return { decision: "allow", categories: [], confidence: 0.8, reason: "Reply with no scanner findings." };
    if (OFF_TOPIC_ACTIONS.test(text) && !(input.scope.keywords ?? []).some((k) => OFF_TOPIC_ACTIONS.test(k))) {
      return { decision: "hold", categories: ["out_of_scope"], confidence: 0.75, reason: "The message asks for an action that is not part of this scope." };
    }
    const keywords = input.scope.keywords ?? [];
    if (keywords.length > 0 && input.kind === "request") {
      const words = new Set(text.match(/[a-z][a-z0-9-]+/g)?.filter((w) => !STOPWORDS.has(w)) ?? []);
      const hit = keywords.some((k) => (k.includes(" ") ? text.includes(k) : words.has(k) || words.has(`${k}s`)));
      if (!hit && words.size > 3) {
        return { decision: "hold", categories: ["out_of_scope"], confidence: 0.75, reason: `None of the scope's topics appear in this request (scope: ${input.scope.name}).` };
      }
    }
    return { decision: "allow", categories: [], confidence: 0.8, reason: "No policy concerns found by the heuristic judge." };
  }
}
