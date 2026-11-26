# Development

## Tests and checks

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
desktop/      Electron desktop app (Windows, macOS, Linux) and the script that publishes its builds
.github/      workflow that builds and smoke-tests the Mac and Linux desktop apps
examples/     policy, demo agents and workspaces
demo/         pnpm demo and pnpm demo:scenario
docs/         design plan (plan.html), brand guide (brand.md), the landing film's source (film/), project capsule (capsule.md)
test/         node:test suites
```

## Local demo

### Demo swarm: watch tasks without any AI model

`scripts/demo-swarm.mjs` fills a relay with simulated agents on autopilot and starts a mission, so you
can watch the whole loop (split, work, peer messages, check-ins, votes, final report) on the dashboard
without API keys:

```bash
pnpm cloud:dev                       # the hosted stack, locally, on http://localhost:8787
pnpm demo:swarm -- --agents 5        # in a second terminal
```

It prints an email and password: sign in at `http://localhost:8787/app`, open **Hackathon demo**, then
**Tasks** or **Live map**. Start more missions from the Tasks view; the simulated agents pick them up.
Pass `--mission "..."` for your own (first line is the title, each further line becomes a part).

### Relay demo with Claude Code agents

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

## Releasing the desktop app

The Mac `.dmg` must be built on macOS, so `.github/workflows/desktop.yml`
builds the Mac and Linux apps on GitHub (manually, or on a `desktop-v*` tag) and launches each one
as a smoke test. Then:

```bash
gh workflow run desktop.yml && gh run watch       # needs Actions minutes (or a public repo)
gh run download <run-id> -D /tmp/desktop          # copy the .dmg and .AppImage into desktop/dist/
cd desktop && npm run dist:win                    # the Windows installer builds on Windows
npm run publish-site                              # splits each installer into <25 MiB parts
cd .. && pnpm cloud:deploy                        # the Worker streams the parts back as one file
```

The Linux AppImage also builds locally in Docker (`electronuserland/builder:20`, from a `git archive`
copy so `desktop/node_modules` stays Windows-native). Bump `desktop/package.json` for every build
people will download.
