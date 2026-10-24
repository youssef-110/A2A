import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { extname, join, normalize as normalizePath, sep } from "node:path";
import { createApi } from "./api.ts";
import type { Relay } from "./relay.ts";
import type { Hub } from "./hub.ts";

const MAX_BODY = 1 << 20;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

export interface HttpOptions {
  relay: Relay;
  hub: Hub;
  adminToken: string;
  consoleDir: string;
  name: string;
  reson8ApiKey?: string;
}

async function readRaw(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) break;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Turns a Node request into a web Request for the shared API. */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
  const url = new URL(req.url ?? "/", `${proto}://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const value of Array.isArray(v) ? v : [v]) headers.append(k, value);
  }
  const body = await readRaw(req);
  return new Request(url, { method: req.method, headers, body: body && body.length ? body : undefined });
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.end());
  stream.pipe(res);
}

export function createRelayServer(opts: HttpOptions): Server {
  const { hub, consoleDir } = opts;
  const api = createApi({ relay: opts.relay, adminToken: opts.adminToken, name: opts.name, reson8ApiKey: opts.reson8ApiKey ?? process.env.RESON8_API_KEY });

  async function serveStatic(url: URL, res: ServerResponse): Promise<boolean> {
    // /join/<code> is one page; it reads the code from the path.
    const rel = url.pathname === "/" ? "index.html" : url.pathname.startsWith("/join/") ? "join.html" : url.pathname.slice(1);
    const file = normalizePath(join(consoleDir, rel));
    if (!file.startsWith(consoleDir + sep) && file !== join(consoleDir, "index.html")) return false;
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const request = await toRequest(req);
      const response = await api.handle(request);
      if (response) return await sendResponse(res, response);
      const url = new URL(request.url);
      if (req.method === "GET" && !url.pathname.startsWith("/v1/") && (await serveStatic(url, res))) return;
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "not_found" }));
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "internal_error" }));
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    if (url.pathname !== "/v1/stream") {
      socket.destroy();
      return;
    }
    hub.wss.handleUpgrade(req, socket, head, (ws) => hub.wss.emit("connection", ws, req));
  });

  return server;
}
