import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { WebSocket } from "ws";

/**
 * Speech-to-text through Reson8 (https://docs.reson8.dev). The API key is read from
 * RESON8_API_KEY, which may come from a .env file; it is only ever sent in the Authorization
 * header and never printed or logged.
 */

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");

/** Loads KEY=VALUE lines from .env files into process.env without overriding what is already set. */
export function loadDotEnv(paths: string[]): void {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2]!.trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "");
      if (process.env[m[1]!] === undefined && value !== "") process.env[m[1]!] = value;
    }
  }
}

/** .env in the current folder, then the a2a home, then the repository root. */
export function loadVoiceEnv(home: string): void {
  loadDotEnv([join(process.cwd(), ".env"), join(home, ".env"), join(REPO_ROOT, ".env")]);
}

export class VoiceError extends Error {}

function apiKey(): string {
  const key = process.env.RESON8_API_KEY?.trim();
  if (!key) throw new VoiceError("RESON8_API_KEY is not set. Add it to .env in the A2A folder (see .env.example) or export it in your shell.");
  return key;
}

const apiBase = (): string => (process.env.RESON8_API_URL ?? "https://api.reson8.dev").replace(/\/$/, "");

export interface TranscribeOptions {
  /** e.g. "en", or "nl,en" to constrain auto-detection. Omitted: Reson8 detects per utterance. */
  language?: string;
}

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Transcribes a whole audio file with the prerecorded endpoint. Most formats are detected automatically. */
export async function transcribeFile(path: string, opts: TranscribeOptions = {}): Promise<string> {
  if (!existsSync(path)) throw new VoiceError(`No such file: ${path}`);
  const res = await fetch(`${apiBase()}/v1/speech-to-text/prerecorded${query({ language: opts.language, filler_mode: "clean" })}`, {
    method: "POST",
    headers: { authorization: `ApiKey ${apiKey()}`, "content-type": "application/octet-stream" },
    body: readFileSync(path),
    signal: AbortSignal.timeout(300_000),
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; code?: string; detail?: string; title?: string };
  if (!res.ok) throw new VoiceError(describeHttpError(res.status, body.code, body.detail ?? body.title));
  return (body.text ?? "").trim();
}

function describeHttpError(status: number, code?: string, detail?: string): string {
  const why: Record<number, string> = {
    400: "Reson8 could not use this audio or request",
    401: "Reson8 rejected the API key (check RESON8_API_KEY)",
    402: "the Reson8 account is over its credit limit",
    413: "the audio file is too large for Reson8",
    429: "too many Reson8 sessions at once; try again shortly",
  };
  return `Transcription failed: ${why[status] ?? `Reson8 returned ${status}`}${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}`;
}

/** ffmpeg arguments that capture the default microphone as raw 16 kHz mono PCM on stdout. */
export function microphoneArgs(os = platform()): string[] {
  const input = os === "darwin" ? ["-f", "avfoundation", "-i", process.env.A2A_MIC ?? ":0"] : os === "win32" ? ["-f", "dshow", "-i", `audio=${process.env.A2A_MIC ?? "default"}`] : ["-f", "pulse", "-i", process.env.A2A_MIC ?? "default"];
  return ["-hide_banner", "-loglevel", "error", "-nostdin", ...input, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"];
}

/** ffmpeg arguments that play an audio file in real time as raw PCM, as if it were the microphone. */
export function fileAsMicArgs(path: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-re", "-i", path, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"];
}

export function startRecorder(args: string[]): ChildProcess {
  const bin = process.env.A2A_FFMPEG ?? "ffmpeg";
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", () => {});
  return child;
}

export interface LiveOptions extends TranscribeOptions {
  /** Raw 16 kHz mono s16le audio. */
  audio: Readable;
  /** Called with the text so far plus the current interim phrase, for a live preview. */
  onUpdate?: (text: string) => void;
  /** Resolves when the speaker is done (Enter pressed, timer, end of file). */
  stop: Promise<void>;
}

/**
 * Streams audio to the realtime endpoint and returns the final transcript. On stop it sends a
 * flush request so the last words are finalized before the connection closes.
 */
export function transcribeLive(opts: LiveOptions): Promise<string> {
  const url = `${apiBase().replace(/^http/, "ws")}/v1/speech-to-text/realtime${query({ encoding: "pcm_s16le", sample_rate: "16000", include_interim: "true", filler_mode: "clean", language: opts.language })}`;
  return new Promise((resolvePromise, reject) => {
    const finals: string[] = [];
    let interim = "";
    let done = false;
    let stopped = false;
    const ws = new WebSocket(url, { headers: { authorization: `ApiKey ${apiKey()}` }, handshakeTimeout: 15_000 });
    const text = (): string => finals.join(" ").replace(/\s+/g, " ").trim();
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(flushTimer);
      opts.audio.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
      if (err) reject(err);
      else resolvePromise(text());
    };
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = (): void => {
      if (stopped) return;
      stopped = true;
      opts.audio.pause();
      if (ws.readyState !== ws.OPEN) return finish();
      ws.send(JSON.stringify({ type: "flush_request", id: "a2a-stop" }));
      flushTimer = setTimeout(() => finish(), 10_000);
    };

    ws.on("unexpected-response", (_req, res) => {
      const reason = res.headers["x-error-message"];
      finish(new VoiceError(describeHttpError(res.statusCode ?? 0, undefined, typeof reason === "string" ? reason : undefined)));
    });
    ws.on("error", (err) => finish(new VoiceError(`Could not reach Reson8: ${err.message}`)));
    ws.on("open", () => {
      opts.audio.on("data", (chunk: Buffer) => {
        if (!stopped && ws.readyState === ws.OPEN) ws.send(chunk);
      });
      opts.audio.on("end", flush);
      opts.audio.on("error", (err) => finish(new VoiceError(`Audio input failed: ${err.message}`)));
      void opts.stop.then(flush);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: { type?: string; text?: string; is_final?: boolean; id?: string | null };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "transcript") {
        if (msg.is_final === false) interim = msg.text ?? "";
        else {
          if (msg.text?.trim()) finals.push(msg.text.trim());
          interim = "";
        }
        opts.onUpdate?.([text(), interim].filter(Boolean).join(" "));
      } else if (msg.type === "flush_confirmation") {
        finish();
      }
    });
    ws.on("close", (code, reason) => {
      if (done) return;
      if (code === 1000 || code === 1005) finish();
      else finish(new VoiceError(`Reson8 closed the stream (${code}${reason.length ? ` ${reason}` : ""})`));
    });
  });
}
