#!/usr/bin/env node
// Scripted stand-in for the support triage agent, used by the demo when Claude Code is not
// installed. It answers from the same ticket files the Claude agent reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.SUPPORT_DATA ?? join(import.meta.dirname, "../workspaces/support");
const customers = JSON.parse(readFileSync(join(dir, "customers.json"), "utf8"));
const tickets = JSON.parse(readFileSync(join(dir, "tickets.json"), "utf8"));

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const m = JSON.parse(input);
  const ids = [...m.text.matchAll(/\b(\d{5})\b/g)].map((x) => Number(x[1]));
  const ticketIds = [...m.text.matchAll(/\bT-\d{4}\b/g)].map((x) => x[0]);
  const found = tickets.filter((t) => ids.includes(t.customer_id) || ticketIds.includes(t.id));
  if (!found.length) {
    process.stdout.write("I couldn't find a matching customer or ticket. Send a customer id (e.g. 48213) or ticket id (e.g. T-1042).");
    return;
  }
  const lines = found.map((t) => {
    const c = customers.find((x) => x.id === t.customer_id);
    const last = t.history.at(-1);
    return `${t.id} for ${c?.name ?? t.customer_id} (${t.status}): "${t.subject}". Latest note from ${last.by}: ${last.text}`;
  });
  process.stdout.write(lines.join("\n"));
});
