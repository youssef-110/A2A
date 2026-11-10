/**
 * The auto-reply matrix as text, for the CLI and the MCP tool: per session, each of this person's
 * agents, whether it answers on its own, the runtime behind it, and the limits it runs within.
 */
export interface MatrixRow {
  session_id: string;
  session: string;
  agent: string;
  app: string;
  enabled: boolean;
  runtime: string;
  runtime_ready: boolean;
  workdir: string | null;
  tools: string[];
  model: string | null;
  limits: Record<string, unknown> | null;
  autopilot: boolean;
  running: number;
  recent: { runs: number; avg_delivery_ms: number; avg_start_ms: number; avg_model_ms: number } | null;
}

const ms = (n: number): string => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

export function formatMatrix(rows: MatrixRow[]): string {
  if (!rows.length) return "None of your agents is in a session yet, so nothing can auto-reply.";
  const bySession = new Map<string, MatrixRow[]>();
  for (const r of rows) bySession.set(r.session_id, [...(bySession.get(r.session_id) ?? []), r]);
  const out: string[] = [];
  for (const list of bySession.values()) {
    out.push(`${list[0]!.session}  (${list[0]!.session_id})`);
    for (const r of list) {
      const name = r.agent.split("/").pop();
      if (!r.enabled) {
        out.push(`  ○ ${r.app.padEnd(14)} ${name}  manual: messages wait in the inbox`);
        continue;
      }
      const l = r.limits ?? {};
      const caps = [
        `${l.max_per_hour}/h`,
        `${l.max_concurrent} at once`,
        l.cooldown_s ? `${l.cooldown_s}s cooldown` : null,
        `timeout ${l.timeout}`,
        l.max_tokens ? `${l.max_tokens} tokens max` : null,
        l.daily_usd != null ? `$${l.daily_usd}/day` : null,
        l.daily_tokens != null ? `${l.daily_tokens} tokens/day` : null,
      ].filter(Boolean);
      out.push(`  ● ${r.app.padEnd(14)} ${name}  auto-reply ON via ${r.runtime}${r.runtime_ready ? "" : " (NOT FOUND on this computer: runs will fail)"}${r.model ? `, model ${r.model}` : ""}`);
      out.push(`      tools: ${r.tools.join(", ") || "(none)"}; ${caps.join(", ")}${r.workdir ? `; in ${r.workdir}` : ""}`);
      if (r.recent) out.push(`      last ${r.recent.runs} runs: delivery ${ms(r.recent.avg_delivery_ms)}, agent start ${ms(r.recent.avg_start_ms)}, model ${ms(r.recent.avg_model_ms)}`);
    }
  }
  if (rows.some((r) => r.autopilot)) out.push("", `Autopilot (task work, any session): ${[...new Set(rows.filter((r) => r.autopilot).map((r) => r.agent.split("/").pop()))].join(", ")}`);
  out.push("", "Idle cost: one relay connection per workspace; no model runs until an enabled agent gets a new request.");
  return out.join("\n");
}
