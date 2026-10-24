import { DurableObject } from "cloudflare:workers";
import { generateAgentKeyPair } from "@a2a/protocol";
import { AnthropicJudge, HeuristicJudge, type JudgeMode, type JudgeSet } from "@a2a/guard/core";
import { createApi, Relay, SCHEMA, type Api } from "@a2a/server/core";
import { doDb } from "./do-db.ts";
import { DoHub } from "./do-hub.ts";
import { defaultPolicy } from "./policy.ts";

export interface Env {
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

/** The whole relay in one Durable Object: SQLite state, the guard, and every agent's WebSocket. */
export class RelayDO extends DurableObject<Env> {
  private readonly relay: Relay;
  private readonly hub: DoHub;
  private readonly api: Api;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = doDb(ctx.storage);
    db.exec(SCHEMA);
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const meta = (key: string, create: () => string): string => {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
      if (row) return row.value;
      const value = create();
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, value);
      return value;
    };
    const relayKeyPem = meta("relay_key_pem", () => generateAgentKeyPair().privateKeyPem.trim());
    // Without the A2A_ADMIN_TOKEN secret the admin console stays locked: a random token nobody knows.
    if (!env.A2A_ADMIN_TOKEN) console.warn("A2A_ADMIN_TOKEN is not set; the admin console is locked. Run: wrangler secret put A2A_ADMIN_TOKEN");
    const adminToken = env.A2A_ADMIN_TOKEN || crypto.randomUUID() + crypto.randomUUID();

    this.hub = new DoHub(ctx, () => this.relay);
    this.relay = new Relay({
      db,
      relayKeyPem,
      initialPolicy: defaultPolicy(env.A2A_ORG || "acme"),
      judgeOverride: env.A2A_JUDGE as JudgeMode | undefined,
      createJudges: cloudJudges(env),
      log: (m) => console.log(m),
    });
    this.relay.out = this.hub;
    this.api = createApi({ relay: this.relay, adminToken, name: env.A2A_RELAY_NAME || "a2a-relay", reson8ApiKey: env.RESON8_API_KEY });
    // A ping from the client is answered at the edge, so idle connections don't wake the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    this.relay.recover();
  }

  private async keepSweeping(): Promise<void> {
    if (this.relay.hasPendingWork() && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/v1/stream") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
      return this.hub.accept();
    }
    const res = (await this.api.handle(req)) ?? Response.json({ error: "not_found" }, { status: 404 });
    // Screening runs after the response for long guard calls; keep the object alive until it's done.
    this.ctx.waitUntil(this.relay.idle().then(() => this.keepSweeping()));
    return res;
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    this.hub.onMessage(ws, data);
    await this.keepSweeping();
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.hub.onClose(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, "closed");
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.hub.onClose(ws);
  }

  async alarm(): Promise<void> {
    this.relay.recover();
    await this.relay.idle();
    this.relay.sweep();
    await this.keepSweeping();
  }
}
