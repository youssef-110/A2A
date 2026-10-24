import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ADDRESS_RE, generateAgentKeyPair, loadPrivateKey } from "@a2a/protocol";
import { configPath, keyPath, loadConfig, resolveHome, saveConfig, writeKey, type AgentConfig, type RuntimeKind } from "./config.ts";
import { registerAgent, relayInfo } from "./relay-api.ts";
import { ipc, NotRunningError } from "./ipc.ts";
import { Daemon } from "./daemon.ts";
import { runMcpServer } from "./mcp.ts";
import { installService } from "./install.ts";
import { joinNetwork } from "./join.ts";
import { readAttachments } from "./attachments.ts";
import { daemonRunning, ensureDaemon } from "./launcher.ts";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileAsMicArgs, loadVoiceEnv, microphoneArgs, startRecorder, transcribeFile, transcribeLive, VoiceError } from "./voice.ts";

const HELP = `a2a: send and receive agent messages through an A2A relay.

Usage: a2a [--home DIR] <command> [options]

Setup
  join <invite-link> [--name NAME]        Join a relay with an invite link, then start in the background
      [--runtime none|claude|codex|opencode] [--workdir DIR] [--display-name NAME] [--no-start] [--force]
  init --server URL [--name NAME]         Create the client config and pin the relay's key
  agents add <address> [options]          Create a key for an agent on this machine and register it
      --runtime none|claude|codex|opencode|command   What to start when a message arrives (default none)
      --command "prog args"                 For runtime command (or to replace \`codex exec\`)
      --workdir DIR  --allowed-tools Read,Grep  --model NAME  --instructions TEXT
      --display-name NAME  --description TEXT  --admin-token TOKEN (registers as active)
      --default                             Make it the default sender
  agents list                             Show the agents configured here
  install [--load]                        Run \`a2a run\` as a launchd/systemd service

Running
  start                                   Run \`a2a run\` in the background (restart with --restart)
  stop                                    Stop the background \`a2a run\`
  run                                     Connect to the relay, receive messages, start agents (foreground)
  info                                    Show connection and agent status
  runs                                    Show recent agent runs
  mcp [--agent ADDRESS]                   MCP server over stdio for Claude Code, Codex and others
  hook                                    One-line note about new messages, for Claude Code hooks

Messaging
  send <to> <text|-> [--from A] [--scope S] [--thread T] [--wait SECONDS] [--notify] [--json]
      [--attach FILE ...]                   Send files along, e.g. a context capsule (180 KiB total)
  send <to> --voice [--language en] [--seconds N] [--yes]   Speak the message (Reson8 speech-to-text)
  transcribe <audio-file> [--language en] [--send <to>]     Transcribe a recording, optionally send it
  transcribe --live [--language en] [--seconds N]           Transcribe the microphone until Enter
      (--input <audio-file> on --voice or --live streams a recording instead of the microphone)
  reply <message-id> <text|-> [--from A]
  status <message-id>
  thread <thread-id> [--agent A]
  inbox [--agent A] [--next [--wait SECONDS]]
  directory [--agent A]

The home directory defaults to ~/.a2a, or A2A_HOME.`;

function splitCommand(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const readText = (parts: string[]): string => (parts.length === 1 && parts[0] === "-" ? readFileSync(0, "utf8") : parts.join(" "));

function print(json: boolean, value: unknown, human: () => string): void {
  console.log(json ? JSON.stringify(value, null, 2) : human());
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Records from the microphone (or plays an audio file in real time with --input) through ffmpeg
 * and streams it to Reson8, showing the words as they are recognised. Stops on Enter, after
 * --seconds, or at the end of the input file.
 */
async function recordVoice(home: string, opts: { language?: string; seconds?: string; input?: string }): Promise<string> {
  loadVoiceEnv(home);
  if (!process.env.RESON8_API_KEY) throw new VoiceError("RESON8_API_KEY is not set. Add it to .env in the A2A folder (see .env.example).");
  const recorder = startRecorder(opts.input ? fileAsMicArgs(resolve(opts.input)) : microphoneArgs());
  let stderr = "";
  recorder.stderr!.on("data", (d) => (stderr += d));
  const failed = new Promise<never>((_, reject) => {
    recorder.on("error", (err: NodeJS.ErrnoException) =>
      reject(new VoiceError(err.code === "ENOENT" ? "ffmpeg is needed to record audio. Install it (macOS: brew install ffmpeg) and try again." : `Could not start ffmpeg: ${err.message}`)),
    );
    recorder.on("exit", (code) => {
      if (code && code !== 255 && !stopped) {
        const hint = process.platform === "darwin" ? " On macOS, allow microphone access for your terminal app in System Settings > Privacy & Security > Microphone." : "";
        reject(new VoiceError(`Recording failed: ${stderr.trim().split("\n").at(-1) ?? `ffmpeg exited ${code}`}.${hint}`));
      }
    });
  });

  let stopped = false;
  const tty = process.stderr.isTTY;
  const width = (process.stderr.columns ?? 100) - 4;
  const stop = new Promise<void>((done) => {
    const end = (): void => {
      if (stopped) return;
      stopped = true;
      recorder.kill("SIGINT");
      done();
    };
    if (opts.seconds) setTimeout(end, Number(opts.seconds) * 1000).unref();
    recorder.on("exit", end);
    if (process.stdin.isTTY && !opts.input) {
      process.stdin.resume();
      process.stdin.once("data", () => {
        process.stdin.pause();
        end();
      });
    }
  });
  process.stderr.write(opts.input ? `Streaming ${opts.input}…\n` : `Recording${opts.seconds ? ` for ${opts.seconds}s` : ""}. Speak now${process.stdin.isTTY ? ", then press Enter" : ""}.\n`);

  const text = await Promise.race([
    transcribeLive({
      audio: recorder.stdout!,
      language: opts.language ?? process.env.A2A_VOICE_LANGUAGE,
      stop,
      onUpdate: (t) => {
        if (tty) process.stderr.write(`\r\x1b[2K› ${t.length > width ? `…${t.slice(-width + 1)}` : t}`);
      },
    }),
    failed,
  ]);
  if (!stopped) recorder.kill("SIGINT");
  if (tty) process.stderr.write("\r\x1b[2K");
  return text;
}

async function main(argv: string[]): Promise<number> {
  let home: string | undefined;
  const rest = [...argv];
  const hi = rest.indexOf("--home");
  if (hi >= 0) {
    home = rest[hi + 1];
    rest.splice(hi, 2);
  }
  const H = resolveHome(home);
  const [cmd, ...args] = rest;

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;

    case "join": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          name: { type: "string" },
          runtime: { type: "string" },
          workdir: { type: "string" },
          "allowed-tools": { type: "string" },
          "display-name": { type: "string" },
          description: { type: "string" },
          "no-start": { type: "boolean" },
          force: { type: "boolean" },
        },
      });
      if (!positionals[0]) throw new Error("usage: a2a join <invite-link> [--name NAME]");
      const r = await joinNetwork(H, positionals[0], {
        name: values.name,
        runtime: values.runtime as RuntimeKind | undefined,
        workdir: values.workdir ? resolve(values.workdir) : undefined,
        allowedTools: values["allowed-tools"]?.split(",").map((x) => x.trim()).filter(Boolean),
        displayName: values["display-name"],
        description: values.description,
        force: values.force,
      });
      console.log(`Joined ${r.server} as ${r.address} (${r.status}).`);
      if (!values["no-start"]) console.log(`Background client: ${await ensureDaemon(H, { restart: true })}. Logs: ${join(H, "run", "daemon.log")}`);
      console.log(`Try: a2a directory`);
      return 0;
    }

    case "start": {
      const { values } = parseArgs({ args, options: { restart: { type: "boolean" } } });
      loadConfig(H);
      console.log(`a2a run: ${await ensureDaemon(H, { restart: values.restart })} (logs in ${join(H, "run", "daemon.log")})`);
      return 0;
    }

    case "stop": {
      if (!(await daemonRunning(H))) {
        console.log("a2a run is not running.");
        return 0;
      }
      await ipc(H, "POST", "/stop", {});
      console.log("Stopped a2a run.");
      return 0;
    }

    case "hook": {
      // For Claude Code SessionStart/UserPromptSubmit hooks: says something only when there is news, and never fails.
      try {
        if (!existsSync(configPath(H))) return 0;
        const r = await ipc<{ messages: { id: string; from: string; text: string; handled: number }[] }>(H, "GET", "/inbox", undefined, 800);
        const seenFile = join(H, "run", "hook-seen.json");
        let seen: string[] = [];
        try {
          seen = JSON.parse(readFileSync(seenFile, "utf8")) as string[];
        } catch {
          /* first run */
        }
        const fresh = r.messages.filter((m) => !m.handled && !seen.includes(m.id));
        if (fresh.length) {
          // Only who wrote, never what: message text reaches the model through check_inbox, framed as untrusted.
          const senders = [...new Set(fresh.map((m) => m.from))].slice(0, 5).join(", ");
          console.log(`[A2A] ${fresh.length} new message${fresh.length > 1 ? "s" : ""} from ${senders}. Tell the user, and read them with the a2a check_inbox tool if they want.`);
          writeFileSync(seenFile, JSON.stringify([...seen, ...fresh.map((m) => m.id)].slice(-500)));
        }
      } catch {
        /* client not running: stay quiet */
      }
      return 0;
    }

    case "init": {
      const { values } = parseArgs({ args, options: { server: { type: "string" }, name: { type: "string" }, force: { type: "boolean" } } });
      if (!values.server) throw new Error("--server is required, e.g. a2a init --server http://localhost:7700");
      if (existsSync(configPath(H)) && !values.force) throw new Error(`${configPath(H)} already exists (use --force to replace it)`);
      const server = values.server.replace(/\/$/, "");
      const info = await relayInfo(server);
      saveConfig(H, { server, name: values.name ?? "a2a-client", relay_public_key: info.relay_public_key, agents: [] });
      console.log(`Connected to ${info.name} (org ${info.org}, policy v${info.policy_version}).\nPinned relay key and wrote ${configPath(H)}.\nNext: a2a agents add agent://${info.org}/<name> --runtime claude`);
      return 0;
    }

    case "agents": {
      const [sub, ...a] = args;
      const config = loadConfig(H);
      if (sub === "list" || sub === undefined) {
        if (!config.agents.length) console.log("No agents configured. Add one with `a2a agents add`.");
        for (const ag of config.agents) console.log(`${ag.address}${ag.address === config.default_agent ? " (default)" : ""}\n  runtime: ${ag.runtime}${ag.workdir ? `  workdir: ${ag.workdir}` : ""}`);
        return 0;
      }
      if (sub !== "add") throw new Error(`unknown agents command: ${sub}`);
      const { values, positionals } = parseArgs({
        args: a,
        allowPositionals: true,
        options: {
          runtime: { type: "string", default: "none" },
          command: { type: "string" },
          workdir: { type: "string" },
          "allowed-tools": { type: "string" },
          model: { type: "string" },
          instructions: { type: "string" },
          "display-name": { type: "string" },
          description: { type: "string" },
          "admin-token": { type: "string" },
          "max-concurrent": { type: "string" },
          timeout: { type: "string" },
          default: { type: "boolean" },
        },
      });
      const address = positionals[0];
      if (!address || !ADDRESS_RE.test(address)) throw new Error("usage: a2a agents add agent://<org>/<name> [options]");
      const runtime = values.runtime as RuntimeKind;
      if (!["none", "claude", "codex", "opencode", "command"].includes(runtime)) throw new Error("--runtime must be none, claude, codex, opencode or command");
      if (runtime === "command" && !values.command) throw new Error("--runtime command needs --command");

      let entry = config.agents.find((x) => x.address === address);
      let pem: string;
      if (entry) {
        pem = readFileSync(keyPath(H, entry), "utf8");
      } else {
        pem = generateAgentKeyPair().privateKeyPem;
        entry = { address, key: writeKey(H, address.split("/").pop()!, pem), runtime };
        config.agents.push(entry);
      }
      const updated: AgentConfig = {
        ...entry,
        runtime,
        ...(values.command ? { command: splitCommand(values.command) } : {}),
        ...(values.workdir ? { workdir: resolve(values.workdir) } : {}),
        ...(values["allowed-tools"] ? { allowed_tools: values["allowed-tools"].split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.instructions ? { instructions: values.instructions } : {}),
        ...(values["display-name"] ? { display_name: values["display-name"] } : {}),
        ...(values.description ? { description: values.description } : {}),
        ...(values["max-concurrent"] ? { max_concurrent: Number(values["max-concurrent"]) } : {}),
        ...(values.timeout ? { timeout: values.timeout } : {}),
      };
      if (!values.command && runtime !== "command" && runtime !== "codex") delete updated.command;
      const index = config.agents.indexOf(entry);
      config.agents[index] = entry = updated;
      if (values.default || !config.default_agent) config.default_agent = address;
      const r = await registerAgent(config.server, address, loadPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString(), {
        display_name: entry.display_name,
        description: entry.description,
        adminToken: values["admin-token"] ?? process.env.A2A_ADMIN_TOKEN,
      });
      saveConfig(H, config);
      console.log(`${address} registered on ${config.server}: ${r.status}${r.status === "pending" ? "\nAn admin must approve it in the relay console before it can send or receive." : ""}\nRestart \`a2a run\` to pick up the change.`);
      return 0;
    }

    case "run": {
      const daemon: Daemon = new Daemon({ home: H, onStopRequest: () => void daemon.stop().then(() => process.exit(0)) });
      await daemon.start();
      const cfg = daemon.config;
      console.log(`a2a client "${cfg.name}" running for ${cfg.agents.map((x) => `${x.address} [${x.runtime}]`).join(", ")}`);
      let stopping = false;
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, async () => {
          if (stopping) process.exit(1);
          stopping = true;
          await daemon.stop();
          process.exit(0);
        });
      }
      await new Promise(() => {});
      return 0;
    }

    case "install": {
      const { values } = parseArgs({ args, options: { load: { type: "boolean" } } });
      console.log(installService(H, loadConfig(H).name, !!values.load));
      return 0;
    }

    case "mcp": {
      const { values } = parseArgs({ args, options: { agent: { type: "string" } } });
      await runMcpServer(H, values.agent);
      return -1;
    }

    case "info": {
      const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
      const r = await ipc<{ name: string; server: string; connected: boolean; outbox_pending: number; agents: { address: string; runtime: string; online: boolean; rejected: string | null; running: number; queued: number }[] }>(H, "GET", "/info");
      print(!!values.json, r, () =>
        [
          `${r.name} -> ${r.server}: ${r.connected ? "connected" : "not connected"}${r.outbox_pending ? `, ${r.outbox_pending} message(s) waiting to send` : ""}`,
          ...r.agents.map((a) => `  ${a.online ? "●" : "○"} ${a.address} [${a.runtime}]${a.rejected ? ` not accepted: ${a.rejected}` : ""}${a.running ? `, ${a.running} running` : ""}${a.queued ? `, ${a.queued} queued` : ""}`),
        ].join("\n"),
      );
      return 0;
    }

    case "runs": {
      const r = await ipc<{ runs: Record<string, unknown>[] }>(H, "GET", "/runs");
      for (const x of r.runs) console.log(`${x.started_at} ${x.id} ${x.agent} [${x.runtime}] ${x.status}${x.error ? `: ${x.error}` : ""}`);
      if (!r.runs.length) console.log("No runs yet.");
      return 0;
    }

    case "send": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          from: { type: "string" }, scope: { type: "string" }, thread: { type: "string" }, wait: { type: "string" }, notify: { type: "boolean" }, json: { type: "boolean" },
          voice: { type: "boolean" }, language: { type: "string" }, seconds: { type: "string" }, yes: { type: "boolean", short: "y" }, input: { type: "string" },
          attach: { type: "string", multiple: true },
        },
      });
      const [to, ...words] = positionals;
      const attachments = values.attach?.length ? readAttachments(values.attach) : undefined;
      if (!to || (!words.length && !values.voice)) throw new Error("usage: a2a send <to> <text|->   or   a2a send <to> --voice");
      if (values.voice && words.length) throw new Error("use either --voice or message text, not both");
      let text = values.voice ? "" : readText(words);
      if (values.voice) {
        await ipc(H, "GET", "/info"); // fail before recording if the client isn't running
        text = await recordVoice(H, { language: values.language, seconds: values.seconds, input: values.input });
        if (!text) throw new VoiceError("No speech was recognised, so nothing was sent.");
        process.stderr.write(`\nTranscript:\n  ${text}\n\n`);
        if (!values.yes) {
          if (!process.stdin.isTTY) throw new Error("pass --yes to send a voice message without confirming");
          if (!(await confirm(`Send this to ${to}? [Y/n] `))) {
            console.log("Not sent.");
            return 0;
          }
        }
      }
      const wait = values.notify ? 0 : Number(values.wait ?? 0);
      const r = await ipc<Record<string, unknown>>(H, "POST", "/send", {
        from: values.from,
        to,
        text,
        scope: values.scope,
        thread_id: values.thread,
        kind: values.notify ? "notify" : "request",
        expects_reply: !values.notify,
        wait_seconds: wait,
        attachments,
      });
      const reply = r.reply as { from: string; text: string; redacted: boolean } | undefined;
      print(!!values.json, r, () => {
        const head = `${r.id} (thread ${r.thread_id}): ${r.state}${r.reason_code ? ` (${r.reason_code})` : ""}`;
        if (reply) return `${head}\n\nReply from ${reply.from}${reply.redacted ? " (redacted by relay)" : ""}:\n${reply.text}`;
        if (r.timed_out) return `${head}\nNo reply within ${wait}s. Check later with: a2a thread ${r.thread_id}`;
        return head;
      });
      return r.state === "blocked" || r.state === "rejected" ? 2 : 0;
    }

    case "transcribe": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          live: { type: "boolean" }, language: { type: "string" }, seconds: { type: "string" }, json: { type: "boolean" }, input: { type: "string" },
          send: { type: "string" }, from: { type: "string" }, scope: { type: "string" }, wait: { type: "string" },
        },
      });
      const file = positionals[0];
      if (!file && !values.live) throw new Error("usage: a2a transcribe <audio-file>   or   a2a transcribe --live");
      loadVoiceEnv(H);
      const text = values.live ? await recordVoice(H, { language: values.language, seconds: values.seconds, input: values.input }) : await transcribeFile(resolve(file!), { language: values.language });
      if (!values.send) {
        print(!!values.json, { text }, () => (values.live ? `\n${text}` : text) || "(no speech recognised)");
        return text ? 0 : 1;
      }
      if (!text) throw new VoiceError("No speech was recognised, so nothing was sent.");
      const wait = Number(values.wait ?? 0);
      const r = await ipc<Record<string, unknown>>(H, "POST", "/send", { from: values.from, to: values.send, text, scope: values.scope, wait_seconds: wait });
      const reply = r.reply as { from: string; text: string } | undefined;
      print(!!values.json, { text, ...r }, () => `Transcript: ${text}\n${r.id} (thread ${r.thread_id}): ${r.state}${r.reason_code ? ` (${r.reason_code})` : ""}${reply ? `\n\nReply from ${reply.from}:\n${reply.text}` : ""}`);
      return r.state === "blocked" || r.state === "rejected" ? 2 : 0;
    }

    case "reply": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { from: { type: "string" }, json: { type: "boolean" } } });
      const [id, ...words] = positionals;
      if (!id || !words.length) throw new Error("usage: a2a reply <message-id> <text|->");
      const r = await ipc<Record<string, unknown>>(H, "POST", "/reply", { from: values.from, in_reply_to: id, text: readText(words) });
      print(!!values.json, r, () => `${r.id}: ${r.state}${r.reason_code ? ` (${r.reason_code})` : ""}`);
      return 0;
    }

    case "status": {
      const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
      console.log(JSON.stringify(await ipc(H, "GET", `/status?id=${encodeURIComponent(positionals[0] ?? "")}`), null, 2));
      return 0;
    }

    case "thread": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { agent: { type: "string" }, json: { type: "boolean" } } });
      const t = await ipc<{ id: string; scope: string; messages: { from: string; to: string; state: string; reason_code: string | null; text: string | null; created_at: string }[] }>(
        H, "GET", `/thread?id=${encodeURIComponent(positionals[0] ?? "")}${values.agent ? `&agent=${encodeURIComponent(values.agent)}` : ""}`,
      );
      print(!!values.json, t, () =>
        [`Thread ${t.id} (${t.scope})`, ...t.messages.map((m) => `\n[${m.created_at.slice(11, 19)}] ${m.from} -> ${m.to}  ${m.state}${m.reason_code ? ` (${m.reason_code})` : ""}\n${m.text ?? "(not delivered)"}`)].join("\n"),
      );
      return 0;
    }

    case "inbox": {
      const { values } = parseArgs({ args, options: { agent: { type: "string" }, next: { type: "boolean" }, wait: { type: "string" }, json: { type: "boolean" } } });
      if (values.next) {
        const r = await ipc<{ message: Record<string, unknown> | null }>(H, "POST", "/inbox/next", { agent: values.agent, wait_seconds: Number(values.wait ?? 0) });
        print(!!values.json, r, () => (r.message ? `${r.message.id} from ${r.message.from} (thread ${r.message.thread_id}):\n${r.message.text}` : "No new messages."));
        return 0;
      }
      const r = await ipc<{ messages: Record<string, unknown>[] }>(H, "GET", `/inbox${values.agent ? `?agent=${encodeURIComponent(values.agent)}` : ""}`);
      print(!!values.json, r, () => (r.messages.length ? r.messages.map((m) => `${m.handled ? " " : "•"} ${m.received_at} ${m.id} ${m.from} -> ${m.to}\n  ${String(m.text).replace(/\s+/g, " ").slice(0, 160)}`).join("\n") : "Inbox is empty."));
      return 0;
    }

    case "directory": {
      const { values } = parseArgs({ args, options: { agent: { type: "string" }, json: { type: "boolean" } } });
      const r = await ipc<{ agents: { address: string; online: boolean; display_name: string | null; scopes: { name: string }[] }[] }>(H, "GET", `/directory${values.agent ? `?agent=${encodeURIComponent(values.agent)}` : ""}`);
      print(!!values.json, r, () => (r.agents.length ? r.agents.map((a) => `${a.online ? "●" : "○"} ${a.address}${a.display_name ? ` (${a.display_name})` : ""}  scopes: ${a.scopes.map((s) => s.name).join(", ")}`).join("\n") : "This agent has no links to other agents in the relay policy."));
      return 0;
    }

    default:
      throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof NotRunningError || err instanceof VoiceError ? err.message : `a2a: ${(err as Error).message}`);
    process.exitCode = 1;
  },
);
