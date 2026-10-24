import { request } from "node:http";
import { readFileSync } from "node:fs";
import { ipcInfoPath, socketPath, useTcpIpc } from "./config.ts";

export class NotRunningError extends Error {}

const notRunning = (home: string): string => `The a2a client is not running for ${home}. Start it with \`a2a run\` (or \`a2a install\` to run it as a service).`;

/** Windows: loopback port and token written by the running daemon. */
function tcpTarget(home: string): { host: string; port: number; token: string } {
  try {
    const info = JSON.parse(readFileSync(ipcInfoPath(home), "utf8")) as { port: number; token: string };
    return { host: "127.0.0.1", port: info.port, token: info.token };
  } catch {
    throw new NotRunningError(notRunning(home));
  }
}

/** Talks to the running `a2a run` instance over its local socket (or loopback TCP on Windows). */
export function ipc<T = Record<string, unknown>>(home: string, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 3_700_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const tcp = useTcpIpc ? tcpTarget(home) : undefined;
    const headers: Record<string, string | number> = data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {};
    if (tcp) headers["x-a2a-token"] = tcp.token;
    const req = request(
      { ...(tcp ? { host: tcp.host, port: tcp.port } : { socketPath: socketPath(home) }), method, path, headers, timeout: timeoutMs },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(text);
          } catch {
            reject(new Error(`unexpected response from a2a run: ${text.slice(0, 200)}`));
            return;
          }
          if ((res.statusCode ?? 500) >= 400) reject(new Error(String(parsed.error ?? `request failed (${res.statusCode})`)));
          else resolve(parsed as T);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out waiting for a2a run")));
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") reject(new NotRunningError(notRunning(home)));
      else reject(err);
    });
    if (data) req.write(data);
    req.end();
  });
}
