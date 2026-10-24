import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { helloSigningString, verifyString } from "@a2a/protocol";
import type { Delivery, Outbound, Relay, StatusUpdate } from "./relay.ts";

interface Conn {
  ws: WebSocket;
  agents: Set<string>;
  client: string;
  alive: boolean;
}

/**
 * Delivery stream. A client proves it holds each agent's key by signing a per-connection
 * nonce, then receives deliveries and status updates for those agents and acks deliveries.
 */
export class Hub implements Outbound {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  private readonly byAgent = new Map<string, Set<Conn>>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly relay: Relay;

  constructor(relay: Relay) {
    this.relay = relay;
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.heartbeat = setInterval(() => {
      for (const set of this.byAgent.values()) {
        for (const c of set) {
          if (!c.alive) c.ws.terminate();
          else {
            c.alive = false;
            c.ws.ping();
          }
        }
      }
    }, 25_000);
    this.heartbeat.unref();
  }

  private closed = false;

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const nonce = randomBytes(18).toString("base64url");
    const conn: Conn = { ws, agents: new Set(), client: "unknown", alive: true };
    ws.on("pong", () => (conn.alive = true));
    this.send(ws, { type: "challenge", nonce, relay_public_key: this.relay.relayPublicKey });
    const helloTimer = setTimeout(() => conn.agents.size === 0 && ws.close(4001, "hello timeout"), 10_000);

    ws.on("message", (data) => {
      if (this.closed) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.close(4002, "invalid json");
        return;
      }
      if (msg.type === "hello") {
        clearTimeout(helloTimer);
        const accepted: string[] = [];
        const rejected: { address: string; reason: string }[] = [];
        conn.client = typeof msg.client === "string" ? msg.client.slice(0, 80) : `${req.socket.remoteAddress}`;
        for (const a of Array.isArray(msg.agents) ? (msg.agents as { address?: unknown; sig?: unknown }[]) : []) {
          const address = typeof a.address === "string" ? a.address : "";
          const agent = address ? this.relay.getAgent(address) : undefined;
          if (!agent) rejected.push({ address, reason: "unknown_agent" });
          else if (agent.status !== "active") rejected.push({ address, reason: `agent_${agent.status}` });
          else if (typeof a.sig !== "string" || !verifyString(helloSigningString(nonce, address), a.sig, agent.public_key)) rejected.push({ address, reason: "bad_signature" });
          else accepted.push(address);
        }
        for (const address of accepted) {
          conn.agents.add(address);
          let set = this.byAgent.get(address);
          if (!set) this.byAgent.set(address, (set = new Set()));
          set.add(conn);
        }
        this.send(ws, { type: "welcome", accepted, rejected });
        if (accepted.length === 0) {
          ws.close(4003, "no agents authenticated");
          return;
        }
        for (const address of accepted) this.relay.onAgentOnline(address);
      } else if (msg.type === "ack" && typeof msg.id === "string") {
        this.relay.ack(msg.id, conn.agents);
      } else if (msg.type === "ping") {
        this.send(ws, { type: "pong" });
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.closed) return;
      for (const address of conn.agents) {
        const set = this.byAgent.get(address);
        set?.delete(conn);
        if (set && set.size === 0) {
          this.byAgent.delete(address);
          this.relay.onAgentOffline(address);
        }
      }
    });
  }

  deliver(address: string, delivery: Delivery): number {
    const set = this.byAgent.get(address);
    if (!set) return 0;
    for (const c of set) this.send(c.ws, { type: "deliver", message: delivery });
    return set.size;
  }

  status(address: string, update: StatusUpdate): void {
    for (const c of this.byAgent.get(address) ?? []) this.send(c.ws, { type: "status", ...update });
  }

  isOnline(address: string): boolean {
    return (this.byAgent.get(address)?.size ?? 0) > 0;
  }

  disconnect(address: string): void {
    for (const c of this.byAgent.get(address) ?? []) c.ws.close(4004, "agent disabled");
  }

  onlineAgents(): string[] {
    return [...this.byAgent.keys()];
  }
}
