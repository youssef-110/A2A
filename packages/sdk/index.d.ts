// Type definitions for @a2a/sdk. Copied to dist/index.d.ts by scripts/build-plugin.mjs.

export interface ClientOptions {
  /** Where this machine's identity and state live. Default: A2A_HOME or ~/.a2a */
  home?: string;
  /** Which of this machine's agents sends. Default: the one you joined with. */
  agent?: string;
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
export declare class A2AError extends Error {}

export declare class A2A {
  constructor(opts?: ClientOptions);
  readonly home: string;
  /** Joins a relay with an invite link and returns a connected client. Once per machine. */
  static join(inviteLink: string, opts?: JoinParams): Promise<A2A>;
  /** Connects, reusing a running background client (such as the Claude Code plug-in's) when there is one. */
  connect(): Promise<void>;
  /** Disconnects, if this process started the connection. */
  close(): Promise<void>;
  readonly agents: {
    /** Agents you can message, with whether they're online right now. */
    list(): Promise<Agent[]>;
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
