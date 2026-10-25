// a2a for the desktop. Signs this computer in through the browser (Google included), runs its
// agent in the background with the bundled a2a client, and shows the dashboard in a native window.
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, session, nativeImage, Notification } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// Development only: a separate profile, and no browser pop-up when testing the sign-in by script.
if (process.env.A2A_PROFILE) app.setPath("userData", process.env.A2A_PROFILE);
const RELAY = (process.env.A2A_URL || "https://a2a-relay.a2a-cloud.workers.dev").replace(/\/+$/, "");
const ORIGIN = new URL(RELAY).origin;
const DATA = app.getPath("userData");
const AGENT_HOME = path.join(DATA, "agent");
const STATE_FILE = path.join(DATA, "state.json");
const LOG_FILE = path.join(DATA, "agent.log");
const CLI = app.isPackaged ? path.join(process.resourcesPath, "a2a.mjs") : path.join(__dirname, "..", "plugin", "bin", "a2a.mjs");
const ICON = path.join(__dirname, "build", "icon.png");

let win = null;
let tray = null;
let daemon = null;
let quitting = false;
let restartDelay = 2000;
let poll = null;
let status = { connected: false, address: null, linked: false };

// ------------------------------------------------------------------ state

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeState(s) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
const linked = () => readState().linked === true;

// ------------------------------------------------------------------ the bundled client

const cliEnv = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1", A2A_HOME: AGENT_HOME });

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: cliEnv(), windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout), err: String(stderr || (err && err.message) || "") }),
    );
  });
}

function startDaemon() {
  if (daemon || !linked()) return;
  fs.mkdirSync(DATA, { recursive: true });
  const log = fs.openSync(LOG_FILE, "a");
  daemon = spawn(process.execPath, [CLI, "run"], { env: cliEnv(), windowsHide: true, stdio: ["ignore", log, log] });
  const started = Date.now();
  daemon.on("exit", () => {
    daemon = null;
    fs.closeSync(log);
    if (quitting || !linked()) return;
    // A daemon that ran for a while gets a fast restart; one that keeps crashing backs off.
    restartDelay = Date.now() - started > 60_000 ? 2000 : Math.min(restartDelay * 2, 60_000);
    setTimeout(startDaemon, restartDelay);
  });
}

function stopDaemon() {
  return new Promise((resolve) => {
    if (!daemon) return resolve();
    const d = daemon;
    d.once("exit", () => resolve());
    d.kill();
    setTimeout(() => {
      try {
        d.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve();
    }, 4000);
  });
}

/** Asks the running daemon how it is doing over its local socket (loopback TCP on Windows). */
function daemonInfo() {
  return new Promise((resolve) => {
    let opts;
    if (process.platform === "win32") {
      try {
        const { port, token } = JSON.parse(fs.readFileSync(path.join(AGENT_HOME, "run", "ipc.json"), "utf8"));
        opts = { host: "127.0.0.1", port, headers: { "x-a2a-token": token } };
      } catch {
        return resolve(null);
      }
    } else {
      let sock = path.join(AGENT_HOME, "a2a.sock");
      if (Buffer.byteLength(sock) >= 100) sock = path.join(os.tmpdir(), `a2a-${crypto.createHash("sha256").update(path.resolve(AGENT_HOME)).digest("hex").slice(0, 16)}.sock`);
      opts = { socketPath: sock };
    }
    const req = http.get({ ...opts, path: "/info", timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy());
  });
}

async function refreshStatus() {
  const info = linked() ? await daemonInfo() : null;
  const agent = info?.agents?.[0];
  status = { linked: linked(), connected: !!(info?.connected && agent?.online), address: agent?.address ?? readState().address ?? null, rejected: agent?.rejected ?? null };
  win?.webContents.send("desktop:status", status);
  updateTray();
}

// ------------------------------------------------------------------ signing this computer in

const agentName = () =>
  (os.hostname() || "desktop")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "desktop";

function hasClaude() {
  return new Promise((resolve) => execFile(process.platform === "win32" ? "where" : "which", ["claude"], { windowsHide: true }, (err) => resolve(!err)));
}

async function startLink(sender) {
  stopPolling();
  const res = await fetch(`${RELAY}/auth/device/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host: os.hostname() }) });
  const link = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(link.error || "Couldn't reach a2a. Check your connection and try again.");
  if (!process.env.A2A_NO_OPEN) shell.openExternal(link.verify_url);
  const until = Date.now() + link.expires_in * 1000;
  const tick = async () => {
    if (Date.now() > until) return send(sender, { state: "expired" });
    try {
      const r = await fetch(`${RELAY}/auth/device/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: link.device_code }) });
      const p = await r.json();
      if (p.status === "pending") return (poll = setTimeout(tick, (link.interval || 2) * 1000));
      if (p.status === "approved") return finishLink(sender, p);
      send(sender, { state: p.status });
    } catch {
      poll = setTimeout(tick, 4000); // offline for a moment: keep trying until the code expires
    }
  };
  poll = setTimeout(tick, 1500);
  return { code: link.user_code, url: link.verify_url };
}

function stopPolling() {
  clearTimeout(poll);
  poll = null;
}

function send(sender, msg) {
  if (!sender.isDestroyed()) sender.send("desktop:link", msg);
}

async function finishLink(sender, p) {
  send(sender, { state: "joining", name: p.user.name });
  await session.defaultSession.cookies.set({
    url: RELAY,
    name: "a2a_auth",
    value: p.session_token,
    httpOnly: true,
    secure: RELAY.startsWith("https:"),
    sameSite: "lax",
    expirationDate: Math.floor(Date.now() / 1000) + 30 * 86_400,
  });
  await stopDaemon();
  fs.rmSync(AGENT_HOME, { recursive: true, force: true });
  const runtime = (await hasClaude()) ? "claude" : "none";
  const base = ["join", p.invite_url, "--runtime", runtime, "--workdir", os.homedir(), "--display-name", os.hostname(), "--no-start", "--force"];
  let name = agentName();
  let r = await runCli([...base, "--name", name]);
  if (!r.ok && /taken|exists|in use/i.test(r.err)) {
    // This computer joined before (its old key is gone after a sign-out), so it takes a fresh name.
    name = `${name.slice(0, 19)}-${crypto.randomBytes(2).toString("hex")}`;
    r = await runCli([...base, "--name", name]);
  }
  if (!r.ok) {
    send(sender, { state: "error", message: (r.err.split("\n").find((l) => l.trim() && !/Warning/.test(l)) || "Joining failed.").trim() });
    return;
  }
  const address = /agent:\/\/[^\s)]+/.exec(r.out)?.[0] ?? null;
  writeState({ linked: true, workspace: p.workspace, address, runtime, user: p.user.email, linked_at: new Date().toISOString() });
  startDaemon();
  send(sender, { state: "done" });
  if (Notification.isSupported()) new Notification({ title: "a2a", body: "This computer is connected. It answers as you in your sessions." }).show();
  setTimeout(() => {
    loadDashboard();
    refreshStatus();
  }, 600);
}

async function signOut() {
  stopPolling();
  await stopDaemon();
  await session.defaultSession.clearStorageData({ origin: ORIGIN });
  fs.rmSync(AGENT_HOME, { recursive: true, force: true });
  writeState({});
  showWelcome();
  refreshStatus();
}

// ------------------------------------------------------------------ windows and tray

function createWindow() {
  const mac = process.platform === "darwin";
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#000000",
    show: false,
    icon: ICON,
    title: "a2a",
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    titleBarOverlay: mac ? undefined : { color: "#00000000", symbolColor: "#a1a1a6", height: 52 },
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", (e) => {
    // Closing the window keeps the agent answering; quit from the tray.
    if (!quitting && process.platform !== "darwin") {
      e.preventDefault();
      win.hide();
    }
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (url.startsWith("file:") || new URL(url).origin === ORIGIN) return;
    e.preventDefault();
    shell.openExternal(url);
  });
  // Downloads of the app from inside the app are pointless; send everything else to the browser.
  session.defaultSession.on("will-download", (e, item) => {
    e.preventDefault();
    shell.openExternal(item.getURL());
  });
  linked() ? loadDashboard() : showWelcome();
}

const showWelcome = () => win?.loadFile(path.join(__dirname, "welcome.html"));
const loadDashboard = () => win?.loadURL(`${RELAY}/app`);

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray) return;
  const line = !status.linked ? "Not signed in" : status.connected ? `Connected as ${status.address?.split("/").pop() ?? "your agent"}` : "Connecting…";
  tray.setToolTip(`a2a: ${line}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: line, enabled: false },
      { type: "separator" },
      { label: "Open a2a", click: showWindow },
      { label: "Open in browser", click: () => shell.openExternal(`${RELAY}/app`) },
      { label: "Show agent log", click: () => shell.openPath(LOG_FILE) },
      { type: "separator" },
      { label: "Quit a2a", click: () => app.quit() },
    ]),
  );
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "build", process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : img);
  tray.on("click", showWindow);
  updateTray();
}

// ------------------------------------------------------------------ IPC from the windows

// Only our own pages may drive the app: the bundled welcome screen and the dashboard.
const trusted = (e) => {
  const url = e.senderFrame?.url ?? "";
  return url.startsWith("file:") || (() => { try { return new URL(url).origin === ORIGIN; } catch { return false; } })();
};
const handle = (channel, fn) =>
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error("untrusted sender");
    return fn(e, ...args);
  });

handle("desktop:status", () => status);
handle("desktop:signOut", () => signOut());
handle("desktop:startLink", (e) => startLink(e.sender));
handle("desktop:cancelLink", () => stopPolling());
handle("desktop:openUrl", (_e, url) => {
  if (typeof url === "string" && url.startsWith(`${ORIGIN}/`)) shell.openExternal(url);
});
handle("desktop:info", () => ({ version: app.getVersion(), relay: RELAY, platform: process.platform }));

// ------------------------------------------------------------------ lifecycle

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.setAppUserModelId("dev.a2a.desktop");
  app.whenReady().then(() => {
    createWindow();
    createTray();
    startDaemon();
    refreshStatus();
    setInterval(refreshStatus, 5000);
    app.on("activate", showWindow);
  });
  app.on("before-quit", () => {
    quitting = true;
    stopPolling();
    daemon?.kill();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") return; // the tray keeps the app alive
  });
}
