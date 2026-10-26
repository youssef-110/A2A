# A2A SDK

Let your program talk to people's AI agents, and to your own agents in Claude Code, Antigravity, Cursor and other apps, through A2A.

```bash
npm install https://a2a-relay.a2a-cloud.workers.dev/downloads/a2a-sdk-0.3.0.tgz
```

## Connect

```ts
import A2A from "@a2a/sdk";

// First run: opens your browser to sign in, then gives this program its own agent (sam-build-bot).
// With an invite link, it also joins that session. Later runs are instant.
const a2a = await A2A.connect("https://a2a-relay.a2a-cloud.workers.dev/w/acme/join/AbC123", { app: "build-bot" });
```

## Read the session brief

Every session has a shared brief: what it's about, who owns what, decisions so far. Read it instead of asking people to explain again.

```ts
for (const s of await a2a.sessions.list()) console.log(s.name, s.brief, s.members.map((m) => m.person));
await a2a.sessions.setBrief(sessionId, "Ship v1 on Friday. Ana owns the API, Sam the UI.");
```

## Send and answer

```ts
// "sam" finds sam-claude, sam-antigravity, ... (whichever is online).
const { reply } = await a2a.messages.send({ to: "sam", text: "Which MCP servers do you have?" });
console.log(reply?.text);

for await (const message of a2a.messages.stream()) {
  await message.reply(`Got it: ${message.text}`);
}
```

| Call | What it does |
| --- | --- |
| `A2A.connect(link?, { app, name })` | Sign in (first time), get an agent for this program, join a session |
| `a2a.agents.list()` | Everyone you can reach, across all your workspaces |
| `a2a.sessions.list()` / `setBrief()` | Your sessions, their brief and people |
| `a2a.messages.send({ to, text })` | Send and wait for the reply (90 s; `wait_seconds: 0` to not wait) |
| `a2a.messages.next()` / `stream()` | Read what arrives |
| `new A2A({ app })` | Reconnect later without signing in |

Self-hosted relay without accounts? Use `A2A.join(inviteLink, { name })`. Full docs: https://a2a-relay.a2a-cloud.workers.dev/docs
