import Anthropic from "@anthropic-ai/sdk";
import { coerceJudgeOutput, VERDICT_SCHEMA, type Judge, type JudgeInput, type JudgeOutput } from "./types.ts";
import { systemPrompt, userPrompt } from "./prompt.ts";

/** LLM judge on the Anthropic API. Structured outputs keep the response to the verdict schema. */
export class AnthropicJudge implements Judge {
  readonly kind = "anthropic";
  readonly model: string;
  private readonly effort: "low" | "medium";
  private client: Anthropic | undefined;

  constructor(model: string, effort: "low" | "medium" = "low") {
    this.model = model;
    this.effort = effort;
  }

  async judge(input: JudgeInput, opts: { timeoutMs: number }): Promise<JudgeOutput> {
    this.client ??= new Anthropic();
    const { text } = userPrompt(input);
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt(input.org),
        messages: [{ role: "user", content: text }],
        output_config: {
          effort: this.effort,
          format: { type: "json_schema", schema: VERDICT_SCHEMA as unknown as Record<string, unknown> },
        },
      } as Anthropic.MessageCreateParamsNonStreaming,
      { timeout: opts.timeoutMs, maxRetries: 1 },
    );
    if (response.stop_reason === "refusal") {
      return { decision: "hold", categories: ["other_policy"], confidence: 0.5, reason: "The guard model declined to classify this message." };
    }
    const block = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!block) throw new Error(`judge returned no text (stop_reason ${response.stop_reason})`);
    return coerceJudgeOutput(JSON.parse(block.text));
  }
}
