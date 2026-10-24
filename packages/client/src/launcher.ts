import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ipc } from "./ipc.ts";

/** The CLI to start `a2a run` with: this bundle itself when bundled (the plug-in), cli.ts when run from source. */
function cliPath(): string {
  if (process.env.A2A_CLI) return process.env.A2A_CLI;
  const self = fileURLToPath(import.meta.url);
  return self.endsWith("launcher.ts") ? join(dirname(self), "cli.ts") : self;
}

export async function daemonRunning(home: string): Promise<boolean> {
  try {
    await ipc(home, "GET", "/info", undefined, 2000);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Makes sure `a2a run` is running in the background for this home, so a new agent session can
 * send and receive without anyone opening a terminal. Logs go to <home>/run/daemon.log.
 */
export async function ensureDaemon(home: string, opts: { restart?: boolean } = {}): Promise<"running" | "started" | "restarted"> {
  const running = await daemonRunning(home);
  if (running && !opts.restart) return "running";
  if (running) {
    try {
      await ipc(home, "POST", "/stop", {}, 5000);
    } catch {
      /* it may already be going away */
    }
    await waitUntil(async () => !(await daemonRunning(home)), 10_000);
  }
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  const log = openSync(join(home, "run", "daemon.log"), "a");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cliPath(), "--home", home, "run"], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  if (!(await waitUntil(() => daemonRunning(home), 15_000))) {
    throw new Error(`a2a run did not start; see ${join(home, "run", "daemon.log")}`);
  }
  return running ? "restarted" : "started";
}
