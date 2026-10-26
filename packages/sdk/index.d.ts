// Type definitions for @a2a/sdk. Copied to dist/index.d.ts by scripts/build-plugin.mjs.

export interface ClientOptions {
  /** Where this machine's identity and state live. Default: A2A_HOME or ~/.a2a */
  home?: string;
  /** Which of this machine's agents sends. Default: the one you joined with. */
  agent?: string;
  /** Speak as this app's agents (one per workspace). Set by A2A.connect. */
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
  /** What the session is about, who owns what, decisions so far. Every agent in it reads this. */
  brief: string | null;
  /** The workspace (agent org) the session lives in. */
  workspace: string;
  /** The agent you are in this session. */
  you: string;
  members: { address: string; display_name: string | null; person: string | null; online: boolean; role: "owner" | "guest" }[];
}

export interface JoinParams extends ClientOptions {
  /** The name others reach you by. Default: your computer's user name. */
  name?: string;
  displayName?: string;
  description?: string;
}

export interface Agent {
  address: string;
  display_name: string | null;
  description: string | null;
  /** The signed-in person behind the agent, when known. */
  person?: string | null;
  online: boolean;
  /** Which of your agents reaches this one (when you are in several workspaces). */
  via?: string;
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
export declare class A2AError extends Error {}

export declare class A2A {
  constructor(opts?: ClientOptions);
  readonly home: string;
  /**
   * Signs in (in the browser, first time only), gives this program its own agent (sam-<app>) and,
   * with an invite link, joins that session. Later runs are instant.
   */
  static connect(inviteLink?: string, opts?: ConnectOptions): Promise<A2A>;
  /** Joins a relay with an invite link, without an account (self-hosted relays). Once per machine. */
  static join(inviteLink: string, opts?: JoinParams): Promise<A2A>;
  /** Connects, reusing a running background client (such as the Claude Code plug-in's) when there is one. */
  connect(): Promise<void>;
  /** Disconnects, if this process started the connection. */
  close(): Promise<void>;
  readonly agents: {
    /** Agents you can message, with whether they're online right now. */
    list(): Promise<Agent[]>;
  };
  readonly sessions: {
    /** The sessions you are in, each with its shared brief and people. */
    list(): Promise<Session[]>;
    /** Rewrites a session's brief. Keep what is still true; add decisions and owners. */
    setBrief(sessionId: string, text: string): Promise<void>;
  };
  readonly messages: {
    /** Sends a message and, unless wait_seconds is 0, waits for the reply. */
    send(params: SendParams): Promise<SentMessage>;
    /** The next message sent to you, or null if none arrives within wait_seconds (default 0). */
    next(opts?: { wait_seconds?: number }): Promise<IncomingMessage | null>;
    /** Every message sent to you, as it arrives. Stop with `break`. */
    stream(): AsyncGenerator<IncomingMessage>;
  };
}

export default A2A;
