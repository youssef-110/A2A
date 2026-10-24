import { spawn } from "node:child_process";
import { coerceJudgeOutput, VERDICT_SCHEMA, type Judge, type JudgeInput, type JudgeOutput } from "./types.ts";
import { systemPrompt, userPrompt } from "./prompt.ts";

/**
 * LLM judge that runs the local Claude Code CLI with every tool disabled, every customization
 * off, no MCP servers and no saved session. Useful when there is no API key but the machine
 * running the relay is signed in to Claude Code.
 */
export class ClaudeCliJudge implements Judge {
  readonly kind = "claude-cli";
  readonly model: string;
  private readonly bin: string;

  constructor(model: string, bin = process.env.A2A_CLAUDE_BIN ?? "claude") {
    this.model = model;
    this.bin = bin;
  }

  judge(input: JudgeInput, opts: { timeoutMs: number }): Promise<JudgeOutput> {
    const { text } = userPrompt(input);
    const args = [
      "-p",
      "--tools", "",
      "--strict-mcp-config",
      "--safe-mode",
      "--no-session-persistence",
      "--model", this.model,
      "--output-format", "json",
      "--system-prompt", systemPrompt(input.org),
      "--json-schema", JSON.stringify(VERDICT_SCHEMA),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude judge timed out after ${opts.timeoutMs} ms`));
      }, opts.timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const out = JSON.parse(stdout) as { is_error?: boolean; structured_output?: unknown; result?: string };
          if (out.is_error) throw new Error(`claude judge error: ${out.result ?? "unknown"}`);
          resolve(coerceJudgeOutput(out.structured_output ?? JSON.parse(out.result ?? "null")));
        } catch (err) {
          reject(new Error(`claude judge failed (exit ${code}): ${(err as Error).message} ${stderr.slice(0, 300)}`));
        }
      });
      child.stdin.end(text);
    });
  }
}
