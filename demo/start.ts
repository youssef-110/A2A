/**
 * pnpm demo
 *
 * Starts a complete local setup: one relay and two client machines.
 *
 *   laptop-a   agent://acme/billing-bot      runtime none (you drive it from the CLI, the scenario, or your own Claude Code via MCP)
 *   server-b   agent://acme/support-triage   Claude Code, reads examples/workspaces/support
 *              agent://acme/code-fixer       Claude Code, reads examples/workspaces/code
 *   (pending)  agent://acme/marketing-bot    registered without approval, so it waits in the console
 *
 * Flags: --judge auto|claude-cli|anthropic|heuristic   --no-claude (scripted agents)   --port 7700
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateAgentKeyPair } from "@a2a/protocol";
import { registerAgent } from "../packages/client/src/relay-api.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DEMO = join(ROOT, ".demo");
const { values } = parseArgs({
  options: {
    judge: { type: "string", default: "auto" },
    "no-claude": { type: "boolean" },
    port: { type: "string", default: "7700" },
  },
});

const hasClaude = !values["no-claude"] && spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
const server = `http://127.0.0.1:${values.port}`;
const token = randomBytes(12).toString("base64url");
const NODE = [process.execPath, "--disable-warning=ExperimentalWarning"];
const CLI = join(ROOT, "packages/client/src/cli.ts");

const color = (code: number, s: string): string => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const children: ChildProcess[] = [];

function run(label: string, code: number, args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(args[0]!, args.slice(1), { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = color(code, label.padEnd(9));
  const pipe = (stream: NodeJS.ReadableStream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        console.log(`${prefix} ${buf.slice(0, i)}`);
        buf = buf.slice(i + 1);
      }
    });
  };
  pipe(child.stdout!);
  pipe(child.stderr!);
  children.push(child);
  return child;
}

function a2a(home: string, ...args: string[]): void {
  const r = spawnSync(NODE[0]!, [...NODE.slice(1), CLI, "--home", home, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, A2A_ADMIN_TOKEN: token } });
  if (r.status !== 0) throw new Error(`a2a ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
}

async function waitForRelay(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${server}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`relay did not start on ${server}`);
}

function shutdown(): void {
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ------------------------------------------------------------------ setup
if (existsSync(DEMO)) rmSync(DEMO, { recursive: true, force: true });
mkdirSync(DEMO, { recursive: true });
const homeA = join(DEMO, "laptop-a");
const homeB = join(DEMO, "server-b");

console.log(color(1, `\nStarting the A2A demo${hasClaude ? " with Claude Code agents" : " with scripted agents (Claude Code not found)"}\n`));
run("relay", 36, [...NODE, join(ROOT, "packages/server/src/main.ts"), "--data", join(DEMO, "relay"), "--port", values.port!, "--judge", values.judge!, "--name", "acme-relay"], { A2A_ADMIN_TOKEN: token });
await waitForRelay();

a2a(homeA, "init", "--server", server, "--name", "laptop-a");
a2a(homeA, "agents", "add", "agent://acme/billing-bot", "--runtime", "none", "--display-name", "Billing bot", "--description", "Reconciles charges and refunds");

a2a(homeB, "init", "--server", server, "--name", "server-b");
const support = join(ROOT, "examples/workspaces/support");
const code = join(ROOT, "examples/workspaces/code");
if (hasClaude) {
  a2a(homeB, "agents", "add", "agent://acme/support-triage", "--runtime", "claude", "--workdir", support, "--allowed-tools", "Read,Grep,Glob", "--model", "sonnet", "--timeout", "4m", "--max-concurrent", "2", "--display-name", "Support triage", "--description", "Answers questions about customers and tickets");
  a2a(homeB, "agents", "add", "agent://acme/code-fixer", "--runtime", "claude", "--workdir", code, "--allowed-tools", "Read,Grep,Glob", "--model", "sonnet", "--timeout", "4m", "--display-name", "Code fixer", "--description", "Triages bugs and CI failures");
} else {
  a2a(homeB, "agents", "add", "agent://acme/support-triage", "--runtime", "command", "--command", `${process.execPath} ${join(ROOT, "examples/agents/support-bot.mjs")}`, "--display-name", "Support triage", "--description", "Answers questions about customers and tickets");
  a2a(homeB, "agents", "add", "agent://acme/code-fixer", "--runtime", "command", "--command", `${process.execPath} ${join(ROOT, "examples/agents/echo-agent.mjs")}`, "--display-name", "Code fixer", "--description", "Triages bugs and CI failures");
}

// An agent that registered itself without an admin token waits for approval in the console.
const pendingKey = generateAgentKeyPair();
await registerAgent(server, "agent://acme/marketing-bot", pendingKey.privateKeyPem, { display_name: "Marketing bot", description: "Wants to message support" });

run("laptop-a", 33, [...NODE, CLI, "--home", homeA, "run"]);
run("server-b", 35, [...NODE, CLI, "--home", homeB, "run"]);
writeFileSync(join(DEMO, "admin-token"), token + "\n", { mode: 0o600 });

await new Promise((r) => setTimeout(r, 1500));
const rel = (p: string): string => p.replace(`${ROOT}/`, "");
console.log(`
${color(1, "Demo is running.")}

  Console      ${server}/
  Admin token  ${token}

  Run the scripted scenario in another terminal:
    pnpm demo:scenario

  Or talk as the billing bot yourself:
    bin/a2a --home ${rel(homeA)} send agent://acme/support-triage "Did support promise customer 48213 a refund?" --wait 120

  Or let your own Claude Code session be the billing bot:
    claude mcp add a2a-demo -- ${process.execPath} --disable-warning=ExperimentalWarning ${CLI} --home ${homeA} mcp

Press Ctrl+C to stop everything.
`);
