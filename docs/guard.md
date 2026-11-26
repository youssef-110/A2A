# The guard

The guard checks every message on the relay before it is delivered. This page covers what it does by
default, how the stages work, and how well it does on the evaluation set.

## What it does out of the box

What the hosted relay does with every message, out of the box:

| The message... | What happens |
| --- | --- |
| Asks for API keys, passwords, tokens, environment variables, or card, bank or ID details | **Held** on the dashboard's Review page until the owner releases or rejects it |
| Tries to send data to an outside address | **Held** for review |
| Contains a pasted key or card number | That part is **masked**; the rest is delivered |
| Anything else | **Delivered** right away |

- **Fast and free:** these checks are patterns, not an AI model. They take about a millisecond, and
  you don't need a Claude subscription or API key to run them.
- **Loop protection:** limits on hops and on repeated identical messages stop two agents from
  messaging each other forever.
- **Your own rules:** change any of this on the dashboard's **Policy** page. You can block instead of
  hold, limit who may message whom, or turn on an AI judge (see
  [the stages below](#the-stages-in-detail)).
- **Signed identities:** every agent has its own Ed25519 key, created on its own computer. The
  relay rejects messages with a bad signature, and the client checks that deliveries really come
  from your relay.
- **Private sessions:** in a workspace, guests reach only the people in their own session, never
  anyone in your other sessions. Archiving a session cuts its guests off.

Even with the guard, treat text from other agents as information, not orders. The plug-in tells your
agent to ask you before running commands, changing files or sharing data because a message asked it
to.

## The stages in detail

| Stage | What it does |
| --- | --- |
| 1 Envelope checks | Valid signature, registered and approved agents, a policy link for this sender, recipient and scope, rate limits, hop limit, message limit and repeated-content loops. |
| 2 Normalize and scan | Normalizes Unicode, strips invisible and direction-changing characters, flags look-alike letters and decodes base64, hex and percent-encoded text. Then scans for secrets, card numbers, ID numbers, injection phrasing, credential requests, destructive commands and attempts to send data out. |
| 3 AI judge (optional) | Gets the scope description, the recent thread, the scanner findings and the message (with secrets masked). It returns a checked, structured verdict. |
| 4 Escalation | If the judge isn't confident enough, a stronger model decides. If that one isn't sure either, the message is held for a person. |

The hosted relay runs stages 1 and 2 only (`guard.judge: off`). Choose a judge with `guard.judge` in
the policy:

- `anthropic` uses the Anthropic API: `claude-haiku-5-5`, escalating to `claude-sonnet-5-5`.
- `claude-cli` runs `claude -p` with every tool, MCP server and customization turned off.
- `auto` (Node relay) picks the API if `ANTHROPIC_API_KEY` is set, then a signed-in `claude` CLI,
  then an offline heuristic judge.

Rules that always hold:

- The AI judge can only make a decision stricter than the pattern checks, never more lenient.
- The judge has no tools. If it errors, times out or returns something invalid, the message is held.
  The guard never lets a message through because something failed.
- Senders get only a short reason code (`instruction_override`, `out_of_scope`, ...), never the
  judge's reasoning, so they can't tune their wording against it. Senders with too many blocks in an
  hour are throttled.
- The recipient gets the cleaned, masked text. Every delivery is signed by the relay. When the guard
  changed nothing, it also carries the sender's own signature.

## Evaluation

`packages/guard/evals/cases.jsonl` has 105 labelled messages: normal support and engineering
traffic, secrets, injections (plain, encoded, invisible-character and look-alike versions), social
engineering and out-of-scope requests.

```bash
pnpm eval
```

```bash
pnpm eval --judge claude-cli
```

| Judge | Cases | Exactly right | Harmful delivered | Harmless held or blocked | Latency p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| Offline (patterns + heuristic) | 89 | 89 | 0 | 0 | under 1 ms |
| Claude CLI (Haiku, then Sonnet) | 105 | 100 | 0 | 0 | 3.6 s / 4.8 s |

The offline run skips the 16 cases that need judgment about scope or intent. All five AI-judge
mismatches are "held instead of blocked" (or the reverse); none of those messages is delivered
either way. `pnpm eval` fails if any harmful message is delivered, so it can gate CI.
