import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { WebSocketServer } from "ws";
import { loadDotEnv, microphoneArgs, transcribeFile, transcribeLive, VoiceError } from "../packages/client/src/voice.ts";
import { cleanup, tempDir } from "./helpers.ts";

// A stand-in for api.reson8.dev, so tests never use a real key or credits.
let server: Server;
const seen: { auth?: string; contentType?: string; url?: string; bytes: number; wsUrl?: string; wsAuth?: string; wsBytes: number; flushed: boolean } = { bytes: 0, wsBytes: 0, flushed: false };
const dir = tempDir("voice");
const savedKey = process.env.RESON8_API_KEY;

before(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer(async (req, res) => {
    seen.auth = req.headers.authorization;
    seen.contentType = req.headers["content-type"];
    seen.url = req.url;
    let n = 0;
    for await (const c of req) n += (c as Buffer).length;
    seen.bytes = n;
    if (req.headers.authorization !== "ApiKey test-key") {
      res.writeHead(401, { "content-type": "application/problem+json" }).end(JSON.stringify({ code: "unauthorized", title: "Unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: " the patient presented with chest pain " }));
  });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    if (req.headers.authorization !== "ApiKey test-key") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nX-Error-Message: invalid credentials\r\n\r\n");
      return;
    }
    seen.wsUrl = req.url;
    seen.wsAuth = req.headers.authorization;
    wss.handleUpgrade(req, socket, head, (ws) => {
      let sentInterim = false;
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          seen.wsBytes += (data as Buffer).length;
          if (!sentInterim) {
            sentInterim = true;
            ws.send(JSON.stringify({ type: "transcript", text: "hi sam", is_final: false }));
            ws.send(JSON.stringify({ type: "transcript", text: "Hi Sam,", is_final: true }));
            ws.send(JSON.stringify({ type: "transcript", text: "could you", is_final: false }));
          }
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.type === "flush_request") {
          seen.flushed = true;
          ws.send(JSON.stringify({ type: "transcript", text: "could you send the logo?", is_final: true }));
          ws.send(JSON.stringify({ type: "flush_confirmation", id: msg.id ?? null }));
        }
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.RESON8_API_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.RESON8_API_KEY = "test-key";
});

after(() => {
  server.close();
  cleanup(dir);
  delete process.env.RESON8_API_URL;
  if (savedKey === undefined) delete process.env.RESON8_API_KEY;
  else process.env.RESON8_API_KEY = savedKey;
});

test(".env files fill in unset variables without overriding the environment", () => {
  const file = join(dir, ".env");
  writeFileSync(file, `# comment\nexport A2A_T1="quoted value"\nA2A_T2=plain # trailing comment\nA2A_T3=\nA2A_T4=from-file\n`);
  process.env.A2A_T4 = "from-env";
  loadDotEnv([file, join(dir, "missing.env")]);
  assert.equal(process.env.A2A_T1, "quoted value");
  assert.equal(process.env.A2A_T2, "plain");
  assert.equal(process.env.A2A_T3, undefined);
  assert.equal(process.env.A2A_T4, "from-env");
  for (const k of ["A2A_T1", "A2A_T2", "A2A_T4"]) delete process.env[k];
});

test("a file is sent to the prerecorded endpoint with the API key and transcribed", async () => {
  const audio = join(dir, "clip.wav");
  writeFileSync(audio, Buffer.alloc(3200));
  assert.equal(await transcribeFile(audio, { language: "en" }), "the patient presented with chest pain");
  assert.equal(seen.auth, "ApiKey test-key");
  assert.equal(seen.contentType, "application/octet-stream");
  assert.equal(seen.bytes, 3200);
  assert.match(seen.url!, /^\/v1\/speech-to-text\/prerecorded\?.*language=en/);
});

test("a rejected key produces a clear error, without printing the key", async () => {
  const audio = join(dir, "clip2.wav");
  writeFileSync(audio, Buffer.alloc(10));
  process.env.RESON8_API_KEY = "wrong-key";
  try {
    await assert.rejects(transcribeFile(audio), (err: Error) => err instanceof VoiceError && /rejected the API key/.test(err.message) && !err.message.includes("wrong-key"));
    await assert.rejects(transcribeLive({ audio: new PassThrough(), stop: new Promise(() => {}) }), /rejected the API key/);
  } finally {
    process.env.RESON8_API_KEY = "test-key";
  }
});

test("live audio is streamed as raw PCM, previewed as it is recognised, and flushed on stop", async () => {
  const audio = new PassThrough();
  const updates: string[] = [];
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const result = transcribeLive({ audio, stop: stopped, language: "en", onUpdate: (t) => updates.push(t) });
  audio.write(Buffer.alloc(6400));
  await new Promise((r) => setTimeout(r, 150));
  stop();
  assert.equal(await result, "Hi Sam, could you send the logo?");
  assert.ok(seen.flushed);
  assert.equal(seen.wsBytes, 6400);
  assert.equal(seen.wsAuth, "ApiKey test-key");
  assert.match(seen.wsUrl!, /encoding=pcm_s16le/);
  assert.match(seen.wsUrl!, /sample_rate=16000/);
  assert.match(seen.wsUrl!, /include_interim=true/);
  assert.ok(updates.includes("Hi Sam, could you"), `interim text shown live: ${updates.join(" | ")}`);
});

test("the microphone is captured as 16 kHz mono PCM on each platform", () => {
  for (const os of ["darwin", "linux"] as const) {
    const args = microphoneArgs(os);
    assert.deepEqual(args.slice(-7), ["-ac", "1", "-ar", "16000", "-f", "s16le", "-"]);
  }
  assert.deepEqual(microphoneArgs("darwin").slice(4, 8), ["-f", "avfoundation", "-i", ":0"]);
  assert.deepEqual(microphoneArgs("linux").slice(4, 8), ["-f", "pulse", "-i", "default"]);
});
