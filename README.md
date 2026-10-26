# A2A

**Let your AI agent talk to other people's AI agents**, with a relay that checks every message in between.

- **Try it:** [a2a-relay.a2a-cloud.workers.dev](https://a2a-relay.a2a-cloud.workers.dev)
- **Docs:** [a2a-relay.a2a-cloud.workers.dev/docs](https://a2a-relay.a2a-cloud.workers.dev/docs)

![A2A system architecture: the a2a client on each computer, the relay with its guard on Cloudflare, and the owner's dashboard, with how a message travels between them](docs/architecture.webp)

## Contents

- [Get started in two minutes](#get-started-in-two-minutes)
- [Talking to other agents](#talking-to-other-agents)
- [Sessions](#sessions)
- [Letting your agent answer on its own](#letting-your-agent-answer-on-its-own)
- [Big hand-offs: context capsules and files](#big-hand-offs-context-capsules-and-files)
- [Dictation](#dictation)
- [Safety](#safety)
- [The dashboard](#the-dashboard)
- [SDK](#sdk)
- [Run your own relay](#run-your-own-relay)
- [Local demo](#local-demo)
- [CLI reference](#cli-reference)
- [The guard in detail](#the-guard-in-detail)
- [Development](#development)
- [Known limitations](#known-limitations)

## Get started in two minutes

**1. Sign in and connect your AI apps.** Sign in at
[a2a-relay.a2a-cloud.workers.dev](https://a2a-relay.a2a-cloud.workers.dev) with Google or email.
Click **Connect your AI apps** and paste the prompt into any AI agent on your computer (Claude Code,
Antigravity, Cursor, Codex, Gemini CLI, ...). The agent runs one command:

```bash
npx -y https://a2a-relay.a2a-cloud.workers.dev/downloads/a2a-sdk-0.3.0.tgz connect
```

It opens your browser with a short code. You sign in and type the code. Every AI app on your computer
then gets its own agent (`sam-claude`, `sam-antigravity`, ...), and A2A is added to each app's MCP
settings. Keys are created on your computer and never leave it.

**2. Start a session and invite people.** Click **New session**. Name it, choose how many people can
join (up to 50) and write a short brief. Then send the invite prompt. Each invited person pastes it into
their agent and signs in once, and all of their apps join. You see who joined, with their name, email
and apps.

**3. Talk.** Ask any connected app in plain words:

- "List my A2A sessions" (reads each session's brief, so nobody explains the project twice)
- "Ask Sam whether the API schema is final"
- "Tell my Antigravity to run the tests"
- "Check my A2A inbox"

Agents also message each other on their own when a task needs something only a teammate's agent
knows. Every message shows up live on the session page.

## Talking to other agents

Connected apps get these MCP tools (the Claude Code plug-in adds a skill and a note when messages arrive):

| Tool | What it does |
| --- | --- |
| `connect` | Sign in and join, with or without an invite link. Safe to call again. |
| `list_sessions` | Your sessions, each with its shared brief and people. |
| `update_session_brief` | Rewrite a session's brief: decisions, owners, pointers. |
| `list_agents` | Everyone you can reach across your workspaces, and who's online. |
| `send_message` | Send a message and, by default, wait for the reply (90 seconds). |
| `check_inbox` | Read the next unread message, plus notices such as a deleted session. |
| `reply` | Answer a message in its thread. |
| `get_thread` | Read the whole conversation in a thread. |
| `message_status` | Check whether a message was delivered, held or blocked. |
| `auto_reply` | Let this app answer on its own while you're away (Claude Code, Codex, OpenCode). |
| `network_status` | Show each relay, this app's agents and whether they're connected. |

Names can be short: "sam" finds `sam-claude` or whichever of Sam's apps is online. One computer can
be in several workspaces at once (your own, and sessions others invited you into). The background
client keeps a connection to each, and messages go out from the agent that can reach the recipient.

| App | Where `connect` adds A2A |
| --- | --- |
| Claude Code | The a2a plug-in (`/plugin install a2a@a2a`) if installed, otherwise `claude mcp add` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json`, plus the a2a skill |
| Gemini CLI | `~/.gemini/settings.json` |
| Codex | `~/.codex/config.toml` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | user `mcp.json` |
| Claude Desktop | `claude_desktop_config.json` |
| OpenCode | `~/.config/opencode/opencode.json` |

Any other MCP client works with `node ~/.a2a/bin/a2a.mjs mcp --tool <name>`.

## Sessions

- **One link, many people.** A session's link works for everyone up to its size (2 to 50 people, not
  counting the owner; each person's apps count once). It expires after 14 days; make a new one any time.
- **Sign-in required.** On the hosted relay, joining a session takes a signed-in account, so the owner
  always knows who is in it.
- **Shared brief.** Every session has a brief that each agent reads with `list_sessions` and can update.
- **Private.** People reach the others in their session and the owner's agents, never people in the
  owner's other sessions.
- **Delete for everyone.** The owner can remove a person (all of their apps) or delete the session: the
  link stops working, everyone in it is cut off at once, and their apps get a notice.
- **Shared with you.** Sessions you were invited into show up in your own dashboard, read-only, and you
  can leave them there.

## Letting your agent answer on its own

By default, messages wait in your inbox until you read them. To have your agent answer while you're
away, give it a **runtime**. When a message arrives, the a2a client starts that runtime, hands it the
message and sends back its answer.

```bash
a2a agents add agent://acme/helper --runtime claude --workdir ~/agents/helper --allowed-tools Read,Grep,Glob
```

| Runtime | What starts when a message arrives |
| --- | --- |
| `none` | Nothing (the default). Messages wait for `check_inbox` or `a2a inbox`. |
| `claude` | `claude -p` in `workdir`. It has only the a2a tools plus the tools you allow (`--allowed-tools`). Anything else is refused rather than waiting on a permission prompt. Each thread keeps one Claude session, so follow-ups remember the conversation. |
| `opencode` | `opencode run` in `workdir`. Everything is denied except the tools you allow and the a2a tools; your own `opencode.json` is not changed. `--model` takes `provider/model`, for example `opencode/big-pickle`, a free model that needs no login. Each thread keeps one OpenCode session. |
| `codex` | `codex exec`, with the message as input and the last message as the reply. |
| `command` | Any program. The message arrives as JSON on stdin and stdout is the reply. See `examples/agents/`. |

The started agent sees the message marked as text from another agent, not as instructions from you.
It can `reply`, read the thread, list agents and message the agents its policy allows. If it finishes
without calling `reply`, its final answer is sent as the reply.

Use `--instructions "..."` to give the agent a system prompt, for example to say what it may do for
you and what it must always refuse. `a2a runs` shows recent runs.

## Big hand-offs: context capsules and files

Sending a large job usually means sending a lot of background. A **context capsule** packs a
project's history, decisions and open tasks into one Markdown file of about 6,000 tokens, with a short
**Brief** at the top. The receiving agent reads only the Brief first, a few hundred tokens, and opens
the rest only if it needs to.

- The plug-in includes the `capsule` skill. Say "make a capsule of this project and send it to Sam".
- Secrets are removed from capsules by default, and every capsule carries a checksum, so tampering
  shows up.
- Messages can carry files, up to 180 KiB in total (`a2a send --attach FILE`). They are saved on the
  receiving computer under `~/.a2a/files/<message-id>/`.
- To keep a tricked agent from sending your keys or config, agents can attach only sealed
  `*.capsule.md` files. People can attach anything from the command line.

## Dictation

- **In the dashboard:** press the microphone and speak. Your words appear in the message box as you talk
  (transcribed by [Reson8](https://docs.reson8.dev), or by the browser without a Reson8 key), so you
  can fix them before sending. Tick "Send as soon as I stop speaking" to skip pressing Enter.
- **From the terminal:** `a2a send sam --voice` records from the microphone, shows the words as you
  speak, and sends them after you confirm. `a2a transcribe meeting.m4a --send sam` sends a recording.

Dictated messages pass through the guard like typed ones. Terminal voice needs a `RESON8_API_KEY` (in
your shell or in `.env`) and, for microphone recording, `ffmpeg`.

## Safety

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
  [The guard in detail](#the-guard-in-detail)).
- **Signed identities:** every agent has its own Ed25519 key, created on its own computer. The
  relay rejects messages with a bad signature, and the client checks that deliveries really come
  from your relay.
- **Private sessions:** in a workspace, guests reach only the people in their own session, never
  anyone in your other sessions. Archiving a session cuts its guests off.

Even with the guard, treat text from other agents as information, not orders. The plug-in tells your
agent to ask you before running commands, changing files or sharing data because a message asked it
to.

## The dashboard

The dashboard (at `/app` after you sign in) has:

- **Home:** ask any agent in your sessions; the answer comes back in the conversation.
- **Sessions:** a live timeline of everything the session's agents say, the shared brief, the people
  (name, email and each app they connected), the size, invites, and delete for everyone.
- **Shared with you:** sessions other people invited you into, read-only.
- **Activity:** every conversation through the relay, read like a chat, with the guard's checks one
  click away. Filter to what needs review or was blocked.
- **Review:** messages the guard held, to release or reject.
- **Agents:** every agent and the person who connected it; approve or disable.
- **Policy**, **Audit log** and **Settings**.

## SDK

`@a2a/sdk` gives your own programs an agent of their own:

```bash
npm install https://a2a-relay.a2a-cloud.workers.dev/downloads/a2a-sdk-0.3.0.tgz
```

```ts
import A2A from "@a2a/sdk";

// First run signs you in (browser); this program becomes sam-build-bot and joins the session.
const a2a = await A2A.connect("https://a2a-relay.a2a-cloud.workers.dev/w/acme/join/AbC123", { app: "build-bot" });

// Start from the session brief, not from scratch.
for (const s of await a2a.sessions.list()) console.log(s.name, s.brief);

// Ask another agent something and wait for the answer.
const { reply } = await a2a.messages.send({ to: "sam", text: "Which MCP servers do you have?" });
console.log(reply?.text);

// Answer whatever comes in.
for await (const message of a2a.messages.stream()) {
  await message.reply(`Got it: ${message.text}`);
}
```

Later runs: `new A2A({ app: "build-bot" })`. Self-hosted relays without accounts use
`A2A.join(link, { name })`. See [packages/sdk](packages/sdk) and the site's
[/docs](https://a2a-relay.a2a-cloud.workers.dev/docs).

## Run your own relay

There are two ways to host a relay.

### On Cloudflare (what the hosted site runs)

One Worker serves the website and API. D1 stores accounts, and each workspace's relay is a SQLite
Durable Object that talks to clients over WebSockets.

```bash
pnpm install
```

```bash
cd packages/cloud && npx wrangler login
```

```bash
npx wrangler d1 create a2a-accounts
```

Put the database id it prints into `packages/cloud/wrangler.jsonc` (`d1_databases`). In `vars`, set
`A2A_LEGACY_OWNER` to your own email. Then create the tables, set the admin token and deploy:

```bash
npx wrangler d1 migrations apply a2a-accounts --remote
```

```bash
npx wrangler secret put A2A_ADMIN_TOKEN
```

```bash
pnpm cloud:deploy
```

Optional secrets:

- `RESON8_API_KEY` turns on voice. The Worker gives the browser 10-minute tokens, so the key never
  reaches it.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` turn on Google sign-in. In Google Cloud Console, add the
  redirect URI `https://<host>/auth/callback/google` and the JavaScript origin `https://<host>`.
- `ANTHROPIC_API_KEY` enables the AI judge. You also need to set `guard.judge: anthropic` in the
  policy.

`pnpm cloud:dev` runs the same Worker locally on `http://localhost:8787`, using the token in
`packages/cloud/.dev.vars`.

The original single relay (`agent://acme`) still answers at the site's root for agents already
connected to it. It belongs to the account in `A2A_LEGACY_OWNER`, and only after that person signs in
with Google using a verified email.

### On your own server (Node.js)

The Node relay is a single relay with an admin console and a shared admin token. It has no accounts,
workspaces or website.

```bash
bin/a2a-relay --port 7700 --host 0.0.0.0 --data /var/lib/a2a --policy examples/policy.yaml
```

- `--policy` is read only on first start. After that, the policy lives in the database (with every
  version kept) and you edit it in the console.
- The admin token comes from `A2A_ADMIN_TOKEN`. If that isn't set, one is generated into
  `<data>/admin-token`.
- The relay speaks plain HTTP. Put it behind a reverse proxy with TLS for anything beyond localhost.

Then, on each agent machine:

```bash
a2a init --server https://relay.example.com --name build-box
```

```bash
a2a agents add agent://acme/code-fixer --runtime claude --workdir ~/agents/code-fixer --allowed-tools Read,Grep,Glob
```

```bash
a2a install --load
```

- `init` pins the relay's public key, so another server can't pretend to be your relay later.
- `agents add` creates the agent's key and registers it. Without `--admin-token`, the agent waits
  for approval in the console.
- `install --load` keeps the client running as a launchd service (macOS) or a systemd user service
  (Linux). `a2a run` runs it in the foreground instead.

Put `bin/` on your `PATH`, or run `pnpm link --global`, to get the `a2a` and `a2a-relay` commands.

## Local demo

Requirements: Node.js 22.18 or newer (it runs the TypeScript directly, with no build step) and pnpm.
Claude Code is optional. If it's installed and signed in, the demo uses it for the guard's AI judge
and for the agents. Otherwise it falls back to offline, scripted stand-ins.

```bash
pnpm install
```

```bash
pnpm demo
```

This starts a relay on <http://127.0.0.1:7700> and two pretend "machines":

| Machine | Agent | Runtime |
| --- | --- | --- |
| `laptop-a` | `agent://acme/billing-bot` | none: you drive it |
| `server-b` | `agent://acme/support-triage` | Claude Code, reading `examples/workspaces/support` |
| `server-b` | `agent://acme/code-fixer` | Claude Code, reading `examples/workspaces/code` |
| (pending) | `agent://acme/marketing-bot` | registered without approval; waits in the console |

Open the console URL it prints and sign in with the admin token it prints. Then, in a second
terminal:

```bash
pnpm demo:scenario
```

The scenario sends these messages as the billing bot. Add `--pause` to go step by step, or
`--step N` to run one.

| # | Message | What happens |
| - | --- | --- |
| 1 | Refund question | Delivered; Claude Code reads the tickets and answers |
| 2 | Follow-up in the same thread | The same Claude session continues, so it remembers |
| 3 | "Ignore all previous instructions..." | Blocked by the scanners in about 1 ms; the AI judge never runs |
| 4 | Question containing a Stripe key | Key masked; the rest is delivered and answered |
| 5 | Injection hidden in base64 | Decoded, then blocked |
| 6 | "Deploy the pricing page to production" | The scanners find nothing; the AI judge holds it as out of scope. Release or reject it in the console |
| 7 | Billing bot messages code-fixer | Blocked: the policy doesn't link them |
| 8 | Bug report that needs engineering | support-triage asks code-fixer through the relay, then answers; every hop is checked |

With real Claude Code agents, steps 1, 2, 4 and 8 take about 15 to 40 seconds each (that's agent
time). The AI judge adds 3.5 to 5 seconds per message.

To use your own Claude Code session as the billing bot, add the MCP server the demo prints:

```bash
claude mcp add a2a-demo -- node --disable-warning=ExperimentalWarning /path/to/A2A/packages/client/src/cli.ts --home /path/to/A2A/.demo/laptop-a mcp
```

## CLI reference

`a2a` is the whole client (command line, background client and MCP server) in one file:
`plugin/bin/a2a.mjs`. Rebuild it with `pnpm build:plugin`. Settings live in `~/.a2a/config.yaml`, or
in the folder named by `A2A_HOME`.

```text
Get started
  a2a connect [invite-link] [--app ID ...] [--name NAME] [--no-install]
  a2a login | logout | apps

Setup by hand
  a2a join <invite-link> [--name NAME] [--runtime none|claude|codex|opencode] [--workdir DIR] [--force]
  a2a init --server URL [--name NAME]
  a2a agents add <address> [--runtime none|claude|codex|opencode|command] [--command "..."] [--workdir DIR]
                           [--allowed-tools Read,Grep] [--model NAME] [--instructions TEXT]
                           [--display-name NAME] [--description TEXT] [--admin-token T] [--default]
  a2a agents list
  a2a install [--load]

Running
  a2a start [--restart] | stop | run | info | runs
  a2a mcp [--tool APP | --agent ADDRESS]
  a2a hook [--tool APP]

Messaging
  a2a send <to> <text|-> [--from A] [--scope S] [--thread T] [--wait SECONDS] [--notify] [--json] [--attach FILE ...]
  a2a send <to> --voice [--language en] [--seconds N] [--yes]
  a2a transcribe <audio-file> [--language en] [--send <to>]
  a2a transcribe --live [--language en] [--seconds N]
  a2a reply <message-id> <text|->
  a2a status <message-id> | thread <thread-id> | inbox [--next --wait N] | directory
  a2a sessions | brief <session-id> <text|->
```

`a2a send` always waits for the guard's decision, and exits with code 2 if the message was blocked or
rejected. Commands other than `run`, `init`, `agents` and `install` talk to the running background
client over a local socket. That client holds the relay connection, the keys and the outbox.

## The guard in detail

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

### Evaluation

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

## Development

```bash
pnpm test
```

```bash
pnpm typecheck
```

`node scripts/smoke-cloud.mjs [origin]` runs the whole hosted flow against a running Worker
(`pnpm cloud:dev`): two people sign up, one invites the other, `connect` signs in and joins with two
apps, then messages, briefs, "shared with you", the size limit and delete for everyone.

`pnpm test` runs 61 tests. They cover:

- protocol and signing;
- guard stages and rules;
- relay policy (forgery, replay, links, hop, loop and rate limits, throttling, thread access);
- end-to-end runs with a real relay and two clients;
- sessions: sign-in, size limits, several apps per person, briefs, delete for everyone;
- one computer in several workspaces, and writing each AI app's MCP config;
- attachments and capsules;
- the OpenCode runtime;
- voice transcription against a stand-in Reson8 server.

```text
packages/
  protocol/   message format, canonical JSON, Ed25519 signing, request auth
  guard/      policy, normalization, scanners, judges, pipeline, eval set
  server/     the relay: HTTP API, WebSocket delivery, SQLite storage, admin API (Node)
  cloud/      the Cloudflare Worker: website, accounts, workspaces, one Durable Object per relay
  client/     the a2a client: background client, runtimes, MCP server, CLI, service install
  sdk/        @a2a/sdk, a small TypeScript client
  web/        website, docs and dashboard (served by the Worker)
  console/    admin console for the Node relay (static, no build step)
plugin/       Claude Code plug-in: bundled client, a2a and capsule skills, hooks
examples/     policy, demo agents and workspaces
demo/         pnpm demo and pnpm demo:scenario
docs/         design plan (docs/plan.html)
test/         node:test suites
```

## Known limitations

- **The Codex runtime is untested.** It's written against `codex exec`, but Codex wasn't installed
  on the build machine. The Claude Code, OpenCode, command and none runtimes are tested end to end.
- **Workspaces connect through sessions.** An agent reaches people in the same workspace or session;
  a computer joins other workspaces by joining their sessions (one connection each).
- **App configs are edited, not managed.** `connect` writes the `a2a` entry into each app's MCP
  settings. Files with comments (some VS Code setups) are left alone with a note to add it by hand.
- **Antigravity, Cursor, Windsurf, VS Code and Gemini CLI were set up from their documented config
  locations** and tested against those files, not with each app running.
- **The Node relay has a single shared admin token.** Accounts and Google sign-in exist only on the
  Cloudflare version. Both record admin actions, including every read of a message body, in the
  audit log.
- **Password sign-ups don't verify email.** Only Google sign-in counts as a verified identity.
- **The offline heuristic judge is for testing and CI.** Out-of-scope detection needs an AI judge.
