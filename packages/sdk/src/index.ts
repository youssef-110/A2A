import { Daemon } from "../../client/src/daemon.ts";
import { ipc, NotRunningError } from "../../client/src/ipc.ts";
import { resolveHome } from "../../client/src/config.ts";
import { joinNetwork, type JoinOptions } from "../../client/src/join.ts";
import { daemonRunning } from "../../client/src/launcher.ts";
import { readAttachments } from "../../client/src/attachments.ts";
import { DEFAULT_ORIGIN, finishLogin, loadAccount, openBrowser, pendingLogin, startLogin, validAccount } from "../../client/src/account.ts";
import { connectApps } from "../../client/src/connect.ts";
import { parseInviteLink } from "../../client/src/join.ts";

export interface ClientOptions {
  /** Where this machine's identity and state live. Default: A2A_HOME or ~/.a2a */
  home?: string;
  /** Which of this machine's agents sends. Default: the one you joined with. */
  agent?: string;
  /** Speak as this app's agents (one per workspace), e.g. "build-bot". Set by A2A.connect. */
  app?: string;
}

export interface ConnectOptions extends ClientOptions {
  /** Your name in agent addresses: "sam" gives sam-<app>. Default: your account's first name. */
  name?: string;
  /** Shows the sign-in code (first time only). Default: prints it and opens the browser. */
  onSignIn?: (info: { code: string; url: string }) => void;
}

export interface Session {
  id: string;
  name: string;
  /** What the session is about, who owns what, decisions so far. */
  brief: string | null;
  workspace: string;
  /** The agent you are in this session. */
  you: string;
  members: { address: string; display_name: string | null; person: string | null; online: boolean; role: string }[];
}

export interface Agent {
  address: string;
  display_name: string | null;
  description: string | null;
  online: boolean;
}

export interface Reply {
  from: string;
  text: string;
  redacted: boolean;
}

export interface SendParams {
  /** "david", "guest-david" or "agent://acme/guest-david" */
  to: string;
  text: string;
  /** Continue a conversation. */
  thread_id?: string;
  /** Wait this long for the answer. Default 90; 0 sends without waiting. */
  wait_seconds?: number;
  /** Files to send along, by path, e.g. a context capsule. 180 KiB in total. */
  attachments?: string[];
}

export interface SentMessage {
  id: string;
  thread_id: string;
  /** delivered, queued, held (waiting for review) or blocked */
  state: string;
  reason_code: string | null;
  reply: Reply | null;
}

export interface IncomingMessage {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  text: string;
  expects_reply: boolean;
  files: { name: string; path: string; bytes: number }[];
  /** Answer this message in the same conversation. */
  reply(text: string): Promise<SentMessage>;
}

/** Thrown for anything the relay or the client refused, with the reason the server gave. */
export class A2AError extends Error {}

/**
 * The A2A client. Talks to other people's agents through your A2A relay.
 *
 * ```ts
 * import A2A from "@a2a/sdk";
 * const a2a = await A2A.join("https://a2a.example/w/acme/join/AbC123", { name: "build-bot" });
 * const { reply } = await a2a.messages.send({ to: "david", text: "Which MCP servers do you have?" });
 * ```
 */
export class A2A {
  readonly home: string;
  private readonly agentFlag?: string;
  private readonly app?: string;
  private daemon?: Daemon;
  private ready?: Promise<void>;

  readonly agents = {
    /** Agents you can message, with whether they're online right now. */
    list: async (): Promise<Agent[]> => (await this.call<{ agents: Agent[] }>("GET", `/directory${this.agentQuery("?")}`)).agents,
  };

  readonly sessions = {
    /** The sessions you are in, each with its shared brief and people. */
    list: async (): Promise<Session[]> => (await this.call<{ sessions: Session[] }>("GET", `/sessions${this.agentQuery("?")}`)).sessions,
    /** Rewrites a session's brief, which every agent in it reads. */
    setBrief: async (sessionId: string, text: string): Promise<void> => {
      await this.call("POST", "/sessions/brief", { ...this.who(), session_id: sessionId, text });
    },
  };

  readonly messages = {
    /** Sends a message and, unless wait_seconds is 0, waits for the reply. */
    send: async (params: SendParams): Promise<SentMessage> => {
      const wait = params.wait_seconds ?? 90;
      const r = await this.call<Record<string, unknown>>(
        "POST",
        "/send",
        {
          ...this.who(),
          to: params.to,
          text: params.text,
          thread_id: params.thread_id,
          kind: wait ? "request" : "notify",
          expects_reply: wait > 0,
          wait_seconds: wait,
          attachments: params.attachments?.length ? readAttachments(params.attachments) : undefined,
        },
        (wait + 90) * 1000,
      );
      return { id: String(r.id), thread_id: String(r.thread_id), state: String(r.state), reason_code: (r.reason_code as string | null) ?? null, reply: (r.reply as Reply | undefined) ?? null };
    },

    /** The next message sent to you, or null if none arrives within wait_seconds (default 0). */
    next: async (opts: { wait_seconds?: number } = {}): Promise<IncomingMessage | null> => {
      const r = await this.call<{ message: Record<string, unknown> | null }>("POST", "/inbox/next", { ...this.who(), wait_seconds: opts.wait_seconds ?? 0 }, ((opts.wait_seconds ?? 0) + 30) * 1000);
      return r.message ? this.incoming(r.message) : null;
    },

    /** Every message sent to you, as it arrives. Stop with `break`. */
    stream: (): AsyncGenerator<IncomingMessage> => this.streamMessages(),
  };

  private async *streamMessages(): AsyncGenerator<IncomingMessage> {
    for (;;) {
      const m = await this.messages.next({ wait_seconds: 30 });
      if (m) yield m;
    }
  }

  constructor(opts: ClientOptions = {}) {
    this.home = resolveHome(opts.home);
    this.agentFlag = opts.agent;
    this.app = opts.agent ? undefined : opts.app;
  }

  /**
   * Signs in (in the browser, first time only), gives this program its own agent in your workspace,
   * and with an invite link joins that session. Later runs are instant.
   *
   * ```ts
   * const a2a = await A2A.connect("https://a2a.example/w/acme/join/AbC123", { app: "build-bot" });
   * ```
   */
  static async connect(inviteLink?: string, opts: ConnectOptions = {}): Promise<A2A> {
    const home = resolveHome(opts.home);
    const app = opts.app ?? "sdk";
    const origin = inviteLink ? new URL(parseInviteLink(inviteLink).server).origin : (loadAccount(home)?.origin ?? DEFAULT_ORIGIN);
    let account = await validAccount(home, origin);
    if (!account) {
      const start = pendingLogin(home, origin) ?? (await startLogin(home, origin));
      if (opts.onSignIn) opts.onSignIn({ code: start.user_code, url: start.verify_url });
      else {
        process.stderr.write(`Sign in to A2A: open ${start.verify_url} and enter ${start.user_code}\n`);
        openBrowser(start.verify_url);
      }
      while (!account) account = await finishLogin(home, origin, 60_000);
    }
    await connectApps(home, account, { link: inviteLink, tools: [app], person: opts.name, install: false });
    const client = new A2A({ home, app });
    await client.connect();
    if (client.daemon === undefined) await ipc(home, "POST", "/reload", {}).catch(() => {});
    return client;
  }

  private who(): { from?: string; tool?: string } {
    return this.agentFlag ? { from: this.agentFlag } : this.app ? { tool: this.app } : {};
  }

  /**
   * Joins a relay with an invite link and returns a connected client. Only needed once per
   * machine: the identity is saved under `home`, and later runs use `new A2A()`.
   */
  static async join(inviteLink: string, opts: ClientOptions & Pick<JoinOptions, "name" | "description"> & { displayName?: string } = {}): Promise<A2A> {
    const home = resolveHome(opts.home);
    const r = await joinNetwork(home, inviteLink, { name: opts.name, description: opts.description, displayName: opts.displayName });
    const client = new A2A({ home, agent: opts.agent ?? r.address });
    await client.connect();
    return client;
  }

  /**
   * Connects to the relay. Uses the background client if one is already running for this home
   * (for example the Claude Code plug-in's), otherwise runs one inside this process.
   */
  connect(): Promise<void> {
    this.ready ??= (async () => {
      if (await daemonRunning(this.home)) return;
      this.daemon = new Daemon({ home: this.home, log: () => {} });
      await this.daemon.start();
      const until = Date.now() + 10_000;
      while (!(this.daemon.info().connected as boolean) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    })();
    return this.ready;
  }

  /** Disconnects, if this process started the connection. */
  async close(): Promise<void> {
    await this.daemon?.stop();
    this.daemon = undefined;
    this.ready = undefined;
  }

  private agentQuery(sep: "?" | "&"): string {
    if (this.agentFlag) return `${sep}agent=${encodeURIComponent(this.agentFlag)}`;
    return this.app ? `${sep}tool=${encodeURIComponent(this.app)}` : "";
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    await this.connect();
    try {
      return await ipc<T>(this.home, method, path, body, timeoutMs);
    } catch (err) {
      if (err instanceof NotRunningError) throw new A2AError("Not connected. Call A2A.connect(<invite link>) once on this computer.");
      throw new A2AError((err as Error).message);
    }
  }

  private incoming(m: Record<string, unknown>): IncomingMessage {
    return {
      id: String(m.id),
      thread_id: String(m.thread_id),
      from: String(m.from),
      to: String(m.to),
      text: String(m.text),
      expects_reply: Boolean(m.expects_reply),
      files: (m.files as IncomingMessage["files"]) ?? [],
      reply: async (text: string) => {
        const r = await this.call<Record<string, unknown>>("POST", "/reply", { from: m.to, in_reply_to: m.id, text });
        return { id: String(r.id), thread_id: String(r.thread_id), state: String(r.state), reason_code: (r.reason_code as string | null) ?? null, reply: null };
      },
    };
  }
}

export default A2A;
