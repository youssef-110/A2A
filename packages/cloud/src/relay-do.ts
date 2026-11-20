import { DurableObject } from "cloudflare:workers";
import { generateAgentKeyPair } from "@a2a/protocol";
import { AnthropicJudge, HeuristicJudge, type JudgeMode, type JudgeSet } from "@a2a/guard/core";
import { createApi, Relay, SCHEMA, type Api, type Db } from "@a2a/server/core";
import { doDb } from "./do-db.ts";
import { DoHub } from "./do-hub.ts";
import { defaultPolicy, workspacePolicy } from "./policy.ts";
import type { AccountsEnv } from "./accounts.ts";
import { sendEmail, type EmailEnv } from "./email.ts";
import type { StatsEnv } from "./stats.ts";

export interface Env extends AccountsEnv, EmailEnv, StatsEnv {
  RELAY: DurableObjectNamespace;
  ASSETS: Fetcher;
  A2A_ADMIN_TOKEN?: string;
  A2A_ORG?: string;
  A2A_RELAY_NAME?: string;
  A2A_JUDGE?: string;
  RESON8_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

const SWEEP_MS = 15_000;

function cloudJudges(env: Env): (mode: JudgeMode) => JudgeSet | null {
  return (mode) => {
    if (mode === "off") return null;
    if ((mode === "anthropic" || mode === "auto") && env.ANTHROPIC_API_KEY) {
      return { fast: new AnthropicJudge("claude-haiku-5-5", "low"), strong: new AnthropicJudge("claude-sonnet-5-5", "medium") };
    }
    // No claude CLI on Workers: claude-cli, and auto without an API key, use the offline judge.
    return { fast: new HeuristicJudge() };
  };
}

/**
 * One relay in one Durable Object: SQLite state, the guard, and every agent's WebSocket.
 * The original relay ("relay") serves agent://acme. Workspace relays learn their org and name from
 * the Worker's x-a2a-* headers on their first request and keep them, so they can wake up on their own.
 */
export class WorkspaceRelay extends DurableObject<Env> {
  private readonly db: Db;
  private relay?: Relay;
  private hub?: DoHub;
  private api?: Api;
  private name: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = doDb(ctx.storage);
    this.db.exec(SCHEMA);
    this.name = this.getMeta("name") ?? env.A2A_RELAY_NAME ?? "a2a-relay";
    // A ping from the client is answered at the edge, so idle connections don't wake the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    // Start lazily: a brand-new workspace relay learns its org from the Worker's first request.
  }

  private getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** The original relay has no stored org; workspace relays store theirs on first use. */
  private isWorkspace(): boolean {
    return this.getMeta("kind") === "workspace";
  }

  private start(): Relay {
    if (this.relay) return this.relay;
    const env = this.env;
    let relayKeyPem = this.getMeta("relay_key_pem");
    if (!relayKeyPem) {
      relayKeyPem = generateAgentKeyPair().privateKeyPem.trim();
      this.setMeta("relay_key_pem", relayKeyPem);
    }
    // Without the A2A_ADMIN_TOKEN secret the admin API stays locked: a random token nobody knows.
    if (!env.A2A_ADMIN_TOKEN) console.warn("A2A_ADMIN_TOKEN is not set; the admin API is locked. Run: wrangler secret put A2A_ADMIN_TOKEN");
    const adminToken = env.A2A_ADMIN_TOKEN || crypto.randomUUID() + crypto.randomUUID();
    const org = this.getMeta("org") ?? env.A2A_ORG ?? "acme";

    this.hub = new DoHub(this.ctx, () => this.relay!);
    this.relay = new Relay({
      db: this.db,
      relayKeyPem,
      initialPolicy: this.isWorkspace() ? workspacePolicy(org) : defaultPolicy(org),
      judgeOverride: env.A2A_JUDGE as JudgeMode | undefined,
      createJudges: cloudJudges(env),
      log: (m) => console.log(m),
      // Hosted workspaces: joining a session takes a signed-in account, so owners see who is in it.
      requireAccount: this.isWorkspace(),
    });
    this.relay.out = this.hub;
    this.api = createApi({
      relay: this.relay,
      adminToken,
      name: () => this.name,
      reson8ApiKey: env.RESON8_API_KEY,
      trustForwardedBase: true,
      // The owner hears about it even with the dashboard closed. No key or no address: nothing is sent.
      onApproval: (a, email, base) => {
        if (!email) return;
        const origin = new URL(base).origin;
        const who = String(a.agent).split("/").pop()!;
        this.ctx.waitUntil(
          sendEmail(env, origin, email, `${who} needs your OK`, {
            preview: `${who} is waiting for your answer before it goes on.`,
            heading: `${who} needs your OK`,
            paragraphs: [
              `Your agent ${who}${a.session ? ` in the session "${(a.session as { name: string }).name}"` : ""} stopped and is asking before it does this:`,
              String(a.action),
              ...(a.why ? [`Why: ${String(a.why)}`] : []),
              "Approving lets it do that one thing once. It doesn't hand over keys or passwords, and it changes no settings on your computer. The agent uses no tokens while it waits.",
            ],
            button: { label: "Approve or deny", url: `${origin}/app` },
            footer: "You got this because an agent connected to your a2a account asked for your approval.",
          }),
        );
      },
    });
    this.relay.recover();
    return this.relay;
  }

  /** Workspace details come from the Worker, which strips these headers from anything it didn't set. */
  private adopt(req: Request): void {
    const org = req.headers.get("x-a2a-org");
    const name = req.headers.get("x-a2a-name");
    if (org && !this.getMeta("org")) {
      this.setMeta("kind", "workspace");
      this.setMeta("org", org);
    }
    if (name && name !== this.name) {
      this.name = name;
      this.setMeta("name", name);
    }
  }

  private async keepSweeping(): Promise<void> {
    if (this.relay?.hasPendingWork() && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async fetch(req: Request): Promise<Response> {
    this.adopt(req);
    const relay = this.start();
    const url = new URL(req.url);
    if (url.pathname === "/v1/stream") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
      return this.hub!.accept();
    }
    const res = (await this.api!.handle(req)) ?? Response.json({ error: "not_found" }, { status: 404 });
    // Screening runs after the response for long guard calls; keep the object alive until it's done.
    this.ctx.waitUntil(relay.idle().then(() => this.keepSweeping()));
    return res;
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    this.start();
    this.hub!.onMessage(ws, data);
    await this.keepSweeping();
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.start();
    this.hub!.onClose(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.start();
    this.hub!.onClose(ws);
  }

  async alarm(): Promise<void> {
    const relay = this.start();
    relay.recover();
    await relay.idle();
    relay.sweep();
    await this.keepSweeping();
  }
}
