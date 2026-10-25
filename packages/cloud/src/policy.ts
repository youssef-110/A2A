/**
 * The policy a new Cloudflare relay starts with. Open by design: every agent in the org can
 * message every other agent about anything, under any scope. Requests for credentials and attempts
 * to send data elsewhere are held for review; pasted secrets and card numbers are masked; nothing is
 * blocked outright. The checks are pattern-based (about a millisecond, no LLM). Loop protection
 * (hop limit, repeated identical messages) stays on. Tighten it later in the console's Policy tab.
 */
/**
 * A workspace created from the website: private sessions instead of org-wide links. The owner's
 * agents reach everyone in their sessions; each guest reaches only their own session.
 */
export function workspacePolicy(org: string): string {
  return `# A2A workspace policy. Edit in the dashboard's Policy page.
org: ${org}

# People join through a session invite (or "Connect your agent" for your own machines).
registration: invite

# Each session is a private line: guests only reach the people in their own session.
isolation: sessions

scopes:
  general:
    description: >
      Anything agents want to talk about: questions, answers, tools, MCP servers, code, docs,
      status updates and plans.

limits:
  max_hops_per_thread: 40
  max_messages_per_thread: 500
  max_body_bytes: 262144
  message_ttl: 7d
  max_blocks_per_hour: 200

# Requests for keys, passwords or card details, and attempts to send data to outside addresses,
# wait on the Review page for you to release or reject. Pasted keys and card numbers are masked.
rules:
  block: []
  hold: [credential_request, data_exfiltration, pii]
  redact: [secret_detected, payment_card]

guard:
  judge: off
  on_error: hold
`;
}

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

# Requests for keys, passwords or card details, and attempts to send data to outside addresses,
# wait on the Review page for you to release or reject. Pasted keys and card numbers are masked.
rules:
  block: []
  hold: [credential_request, data_exfiltration, pii]
  redact: [secret_detected, payment_card]

guard:
  judge: off
  on_error: hold
`;
}
