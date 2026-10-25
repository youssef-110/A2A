import { Daemon } from "../../client/src/daemon.ts";
import { ipc, NotRunningError } from "../../client/src/ipc.ts";
import { resolveHome } from "../../client/src/config.ts";
import { joinNetwork, type JoinOptions } from "../../client/src/join.ts";
import { daemonRunning } from "../../client/src/launcher.ts";
import { readAttachments } from "../../client/src/attachments.ts";

export interface ClientOptions {
  /** Where this machine's identity and state live. Default: A2A_HOME or ~/.a2a */
  home?: string;
  /** Which of this machine's agents sends. Default: the one you joined with. */
  agent?: string;
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
  private daemon?: Daemon;
  private ready?: Promise<void>;

  readonly agents = {
    /** Agents you can message, with whether they're online right now. */
    list: async (): Promise<Agent[]> => (await this.call<{ agents: Agent[] }>("GET", `/directory${this.agentQuery("?")}`)).agents,
  };

  readonly messages = {
    /** Sends a message and, unless wait_seconds is 0, waits for the reply. */
    send: async (params: SendParams): Promise<SentMessage> => {
      const wait = params.wait_seconds ?? 90;
      const r = await this.call<Record<string, unknown>>(
        "POST",
        "/send",
        {
          from: this.agentFlag,
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
      const r = await this.call<{ message: Record<string, unknown> | null }>("POST", "/inbox/next", { agent: this.agentFlag, wait_seconds: opts.wait_seconds ?? 0 }, ((opts.wait_seconds ?? 0) + 30) * 1000);
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
    return this.agentFlag ? `${sep}agent=${encodeURIComponent(this.agentFlag)}` : "";
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    await this.connect();
    try {
      return await ipc<T>(this.home, method, path, body, timeoutMs);
    } catch (err) {
      if (err instanceof NotRunningError) throw new A2AError("Not connected. Call A2A.join(<invite link>) once on this machine, then connect().");
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
