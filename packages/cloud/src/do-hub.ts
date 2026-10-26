import { helloSigningString, verifyString } from "@a2a/protocol";
import type { Delivery, Outbound, Relay, StatusUpdate } from "@a2a/server/core";

interface Attachment {
  nonce: string;
  agents: string[];
  client: string;
}

/**
 * The delivery stream inside the Durable Object, using the hibernation API: sockets survive the
 * object sleeping, and each socket's authenticated agents live in its attachment rather than in memory.
 * Same wire protocol as the Node hub: challenge, hello, welcome, deliver, status, ack.
 */
export class DoHub implements Outbound {
  private readonly ctx: DurableObjectState;
  private readonly relay: () => Relay;

  constructor(ctx: DurableObjectState, relay: () => Relay) {
    this.ctx = ctx;
    this.relay = relay;
  }

  accept(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const nonce = crypto.randomUUID().replaceAll("-", "");
    server.serializeAttachment({ nonce, agents: [], client: "unknown" } satisfies Attachment);
    server.send(JSON.stringify({ type: "challenge", nonce, relay_public_key: this.relay().relayPublicKey }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private att(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { nonce: "", agents: [], client: "unknown" };
  }

  private send(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already closing */
    }
  }

  onMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      ws.close(4002, "invalid json");
      return;
    }
    const relay = this.relay();
    const att = this.att(ws);
    if (msg.type === "hello") {
      const accepted: string[] = [];
      const rejected: { address: string; reason: string }[] = [];
      for (const a of Array.isArray(msg.agents) ? (msg.agents as { address?: unknown; sig?: unknown }[]) : []) {
        const address = typeof a.address === "string" ? a.address : "";
        const agent = address ? relay.getAgent(address) : undefined;
        if (!agent) rejected.push({ address, reason: "unknown_agent" });
        else if (agent.status !== "active") rejected.push({ address, reason: `agent_${agent.status}` });
        else if (typeof a.sig !== "string" || !verifyString(helloSigningString(att.nonce, address), a.sig, agent.public_key)) rejected.push({ address, reason: "bad_signature" });
        else accepted.push(address);
      }
      ws.serializeAttachment({ ...att, agents: [...new Set([...att.agents, ...accepted])], client: typeof msg.client === "string" ? msg.client.slice(0, 80) : att.client } satisfies Attachment);
      this.send(ws, { type: "welcome", accepted, rejected });
      if (accepted.length === 0) {
        ws.close(4003, "no agents authenticated");
        return;
      }
      for (const address of accepted) relay.onAgentOnline(address);
    } else if (msg.type === "ack" && typeof msg.id === "string") {
      relay.ack(msg.id, new Set(att.agents));
    } else if (msg.type === "ping") {
      this.send(ws, { type: "pong" });
    }
  }

  onClose(ws: WebSocket): void {
    const relay = this.relay();
    for (const address of this.att(ws).agents) {
      if (!this.sockets(address).some((other) => other !== ws)) relay.onAgentOffline(address);
    }
  }

  private sockets(address: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN && this.att(ws).agents.includes(address));
  }

  deliver(address: string, delivery: Delivery): number {
    const list = this.sockets(address);
    for (const ws of list) this.send(ws, { type: "deliver", message: delivery });
    return list.length;
  }

  status(address: string, update: StatusUpdate): void {
    for (const ws of this.sockets(address)) this.send(ws, { type: "status", ...update });
  }

  notice(address: string, notice: Record<string, unknown>): void {
    for (const ws of this.sockets(address)) this.send(ws, { type: "notice", address, ...notice });
  }

  isOnline(address: string): boolean {
    return this.sockets(address).length > 0;
  }

  disconnect(address: string): void {
    for (const ws of this.sockets(address)) ws.close(4004, "agent disabled");
  }

  onlineAgents(): string[] {
    const out = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) if (ws.readyState === WebSocket.OPEN) for (const a of this.att(ws).agents) out.add(a);
    return [...out];
  }
}
