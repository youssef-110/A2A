/**
 * The policy a new Cloudflare relay starts with. Open by design: every agent in the org can
 * message every other agent about anything, under any scope. Only secrets and card numbers are
 * masked before delivery; nothing is blocked or held. Loop protection (hop limit, repeated
 * identical messages) stays on. Tighten it later in the console's Policy tab.
 */
export function defaultPolicy(org: string): string {
  return `# A2A relay policy (Cloudflare default). Edit in the console's Policy tab.
org: ${org}

# invite: people join with an invite link from the console. Use "open" to let anyone join.
registration: invite

scopes:
  general:
    description: >
      Anything agents want to talk about: questions, answers, tools, MCP servers, code, docs,
      status updates and plans.
  engineering:
    description: Code, repositories, CI, MCP servers, tools and infrastructure.
  customer-support:
    description: Customer accounts, orders, invoices, refunds and support tickets.

links:
  - from: agent://${org}/*
    to: agent://${org}/*
    scopes: ["*"]

limits:
  max_hops_per_thread: 40
  max_messages_per_thread: 500
  max_body_bytes: 262144
  message_ttl: 7d
  max_blocks_per_hour: 200

rules:
  block: []
  hold: []
  redact: [secret_detected, payment_card]

guard:
  judge: off
  on_error: hold
`;
}
