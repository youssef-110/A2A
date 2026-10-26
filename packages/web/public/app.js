// A2A dashboard. No build step: plain modules, DOM built with h(), live updates over SSE.
// Every relay call goes to /api/w/<workspace>/..., which the Worker allows only for members.

const S = {
  me: null,
  workspaces: [],
  ws: null,
  sessions: [],
  session: null,
  overview: null,
  messages: [],
  agents: [],
  invites: [],
  lastInvite: null,
  view: "sessions",
  filter: "all",
  selected: null,
  detail: null,
  thread: null,
  connected: false,
  maxMembers: 50,
  cli: null,
  shared: [],
  sharedData: null,
  talk: { to: null, thread: {}, log: {}, waiting: {}, draft: "", heard: "", autoSend: false, listening: false },
  detailsOpen: true,
};

// ------------------------------------------------------------------ helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html")
      el.innerHTML = v; // only ever used with the static ICONS below
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Relay paths (/v1/...) go to the current workspace; account paths (/api, /auth) go as they are. */
const relayPath = (path) => (path.startsWith("/v1/") ? `/api/w/${S.ws}${path}` : path);

async function api(method, path, body) {
  const res = await fetch(relayPath(path), {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401) {
    location.href = `/signin?next=${encodeURIComponent(location.pathname)}`;
    throw new Error("Your session ended. Sign in again.");
  }
  if (!res.ok) {
    const err = new Error(data.detail || data.error || `Request failed (${res.status})`);
    err.code = data.error;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
  document.getElementById("live").textContent = msg;
}

const short = (address) => (address ?? "").split("/").pop();
function nameOf(address) {
  if (address && address === S.overview?.relay?.console_address) return "You";
  const a = S.agents.find((x) => x.address === address);
  return a?.display_name || short(address);
}
function ago(iso) {
  if (!iso) return "";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
const timeEl = (iso) => h("time", { datetime: iso, title: iso ? new Date(iso).toLocaleString() : "" }, ago(iso));
const pill = (state) => h("span", { class: `pill ${state}` }, state);

async function copy(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast("Couldn't copy. Select the text and copy it yourself.");
  }
}

function redactedText(text) {
  // Shows the relay's [REDACTED …] markers as highlighted spans.
  const out = [];
  const re = /\[REDACTED [^\]]+\]/g;
  let pos = 0;
  for (const m of String(text ?? "").matchAll(re)) {
    out.push(text.slice(pos, m.index), h("span", { class: "redacted" }, m[0]));
    pos = m.index + m[0].length;
  }
  out.push(String(text ?? "").slice(pos));
  return out;
}

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m7 10 5 5 5-5"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h10"/></svg>',
  panel:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
  download:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
  logout:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/></svg>',
  board:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/></svg>',
  talk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
  traffic:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>',
  invites:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  agents:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  review:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  policy:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>',
  audit:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>',
  sessions:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>',
  scissors:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
};

const LOGO_MARK =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M10.5 21.5c2.6-7.2 8.4-3.8 11-11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".45"/><circle cx="9" cy="22" r="5" fill="currentColor"/><circle cx="23" cy="10" r="5" fill="#2997ff"/></svg>';
const brandMark = () =>
  h("span", {
    class: "brand-mark",
    html: LOGO_MARK,
  });

// A stable, low-key color per agent so a busy list is easy to scan.
const AV = [
  ["#e2e8fb", "#2f4fd0"],
  ["#e2f1e8", "#1b774b"],
  ["#f6e9dc", "#8a4a12"],
  ["#ede7fa", "#6645bd"],
  ["#e1eff2", "#1d6b7a"],
  ["#f7e3ea", "#a3324f"],
  ["#ececdf", "#5f5a1d"],
];
const AV_DARK = [
  ["#232c4a", "#9fb1ff"],
  ["#1b3328", "#7fd8a8"],
  ["#3a2a1b", "#f0b98a"],
  ["#2c2445", "#c6b4f7"],
  ["#173238", "#7fd0de"],
  ["#3a1f29", "#f29bb2"],
  ["#2f2e1c", "#d9d48a"],
];
function initials(address) {
  return (nameOf(address) || short(address)).replace(/^guest-/, "").slice(0, 2);
}
function avatar(address, size) {
  let hash = 0;
  for (const c of address ?? "") hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const dark = document.documentElement.dataset.theme !== "light";
  const [bg, ink] = (dark ? AV_DARK : AV)[hash % AV.length];
  return h("span", { class: `mono-av ${size ?? ""}`, style: `--av-bg:${bg};--av-ink:${ink}`, "aria-hidden": "true" }, initials(address));
}
function bigAvatar(address) {
  const el = avatar(address);
  el.className = "big-av";
  return el;
}
const who = (address) => h("span", { class: "who", title: address }, avatar(address), h("span", { class: "name" }, nameOf(address)));

// Guard stages as a vertical timeline: one node per stage, colored by its decision.
const STAGE_LABEL = { envelope: "Envelope and link checks", scanners: "Scanners", judge: "AI judge", escalation: "Escalation" };
const STAGE_ICON = { allow: "check", redact: "scissors", hold: "pause", block: "x" };
function pipeline(stages) {
  return h(
    "div",
    { class: "pipeline" },
    (stages ?? []).map((s) =>
      h(
        "div",
        { class: `pstage ${s.decision}` },
        h("span", { class: "node", html: ICONS[STAGE_ICON[s.decision] ?? "minus"] }),
        h(
          "div",
          { style: "min-width:0" },
          h(
            "div",
            { class: "pstage-top" },
            h("span", { class: "pstage-name" }, STAGE_LABEL[s.stage] ?? s.stage),
            h("span", { class: `decision ${s.decision}` }, s.decision),
            s.confidence != null ? h("span", { class: "pstage-meta" }, `${Math.round(s.confidence * 100)}% sure`) : null,
            h("span", { class: "pstage-meta" }, [s.model, s.latency_ms != null ? `${s.latency_ms} ms` : null].filter(Boolean).join(", ")),
          ),
          s.reason ? h("div", { class: "pstage-reason" }, s.reason) : null,
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ shell

const NAV = [
  ["sessions", "Home"],
  ["traffic", "Activity"],
  ["agents", "Agents"],
  ["review", "Review"],
  ["policy", "Policy"],
  ["audit", "Audit log"],
];
// Views reachable by URL, including the ones that live outside the sidebar list.
const VIEW_NAMES = ["sessions", "session", "shared", "talk", "traffic", "agents", "review", "policy", "settings", "audit"];
const NAV_ICON = { sessions: "home", traffic: "traffic", agents: "agents", review: "review", policy: "policy", audit: "audit" };

function navCount(view) {
  if (view === "review") return S.overview?.stats?.held || 0;
  if (view === "agents") return S.agents.filter((a) => a.status === "pending").length;
  return 0;
}

const sortedSessions = () => [...S.sessions].sort((a, b) => (b.last_message_at ?? b.created_at ?? "").localeCompare(a.last_message_at ?? a.created_at ?? ""));

function sideList() {
  if (!S.sessions.length) return h("p", { class: "side-empty" }, "Sessions you start show up here.");
  return sortedSessions().map((s) => {
    const online = s.guests.some((g) => g.online);
    return h(
      "button",
      { class: "s-item", "aria-current": S.view === "session" && S.session === s.id ? "page" : false, onclick: () => openSession(s.id), title: s.name },
      h("span", { class: `lamp ${online ? "on" : ""}`, "aria-label": online ? "online" : "offline" }),
      h("span", { class: "s-name" }, s.name),
      s.guests.length ? null : h("span", { class: "s-tag" }, "invited"),
    );
  });
}

/** Sessions other people invited you into, under your own. */
function sharedList() {
  if (!S.shared.length) return null;
  return [
    h("div", { class: "side-h sub" }, h("span", {}, "Shared with you")),
    S.shared.map((s) =>
      h(
        "button",
        { class: "s-item", "aria-current": S.view === "shared" && S.sharedKey?.id === s.id ? "page" : false, onclick: () => openShared(s.workspace.slug, s.id), title: `${s.name} (${s.workspace.name})` },
        h("span", { class: `lamp ${s.guests.some((g) => g.online) ? "on" : ""}` }),
        h("span", { class: "s-name" }, s.name),
        h("span", { class: "s-tag" }, s.workspace.name),
      ),
    ),
  ];
}

function renderSide() {
  const side = document.getElementById("side");
  if (!side) return;
  const ws = S.workspaces.find((w) => w.slug === S.ws);
  side.replaceChildren(
    ...[
      h(
        "div",
        { class: "side-top" },
        h(
          "button",
          { class: "ws-btn", "aria-haspopup": "menu", "aria-expanded": "false", onclick: (e) => workspaceMenu(e.currentTarget), title: ws ? `agent://${ws.slug}` : "" },
          h("span", { class: "mark", html: LOGO_MARK }),
          h("span", { class: "ws-name" }, ws?.name ?? "Workspace"),
          h("span", { class: "chev", html: ICONS.chev }),
        ),
      ),
      h("button", { class: "new-btn", onclick: newSessionDialog }, h("span", { class: "plus", html: ICONS.plus }), "New session"),
      NAV.map(([view, label]) => {
        const n = navCount(view);
        return h(
          "button",
          { class: "nav-btn", "aria-current": S.view === view ? "page" : false, onclick: () => go(view) },
          h("span", { html: ICONS[NAV_ICON[view]] }),
          h("span", { class: "label" }, label),
          n ? h("span", { class: "nav-count", "aria-label": `${n} waiting` }, n) : null,
        );
      }),
      h("div", { class: "side-h" }, h("span", {}, "Sessions")),
      h("div", { class: "side-list" }, sideList(), sharedList()),
      h("div", { class: "side-foot" }, deviceLine(), userButton()),
    ]
      .flat(Infinity)
      .filter(Boolean),
  );
}

function renderShell() {
  const app = document.getElementById("app");
  if (!document.getElementById("side")) {
    app.replaceChildren(
      h(
        "div",
        { class: "shell", id: "shell" },
        h("aside", { class: "side", id: "side", "aria-label": "Sessions and workspace" }),
        h("div", { class: "scrim", onclick: () => toggleSide(false) }),
        h(
          "div",
          { class: "main" },
          h(
            "header",
            { class: "topbar" },
            h("button", { class: "icon-btn menu-btn", "aria-label": "Open the sidebar", html: ICONS.menu, onclick: () => toggleSide(true) }),
            h("div", { class: "topbar-title", id: "top-title" }),
            h("div", { class: "topbar-actions", id: "top-actions" }),
            h("span", { class: "live", id: "live-state" }),
          ),
          h("main", { class: "view", id: "main" }),
        ),
      ),
    );
  }
  renderSide();
  renderLive();
  renderView();
}

function renderLive() {
  document.getElementById("live-state")?.replaceChildren(h("span", { class: `lamp ${S.connected ? "on" : ""}` }), h("span", {}, S.connected ? "Live" : "Reconnecting"));
}

function toggleSide(open) {
  document.getElementById("shell")?.classList.toggle("side-open", open);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("a2a-theme", theme);
  } catch {
    /* storage blocked */
  }
  renderShell();
}

function go(view) {
  if ((S.view === "talk" || S.view === "session") && view !== S.view) Voice.stop();
  S.view = view;
  toggleSide(false);
  try {
    const tail = view === "sessions" ? "" : view === "session" ? `/s/${S.session}` : view === "shared" && S.sharedKey ? `/shared/${S.sharedKey.slug}/${S.sharedKey.id}` : view === "talk" && S.talk.to ? `/talk/${encodeURIComponent(short(S.talk.to))}` : `/${view}`;
    history.replaceState(null, "", `/app/${S.ws}${tail}`);
  } catch {
    /* sandboxed */
  }
  renderShell();
}

function pageHead(title, text, ...actions) {
  return h("header", { class: "page-head" }, h("div", {}, h("h1", {}, title), text ? h("p", {}, text) : null), actions.length ? h("div", { class: "row" }, actions) : null);
}

/**
 * Views return either a node (a regular page, centred with a heading) or
 * { title, actions, body } for full-height screens like a conversation.
 */
function renderView() {
  const main = document.getElementById("main");
  if (!main) return;
  const views = {
    sessions: viewHome,
    session: viewSession,
    shared: viewShared,
    talk: viewTalk,
    traffic: viewTraffic,
    agents: viewAgents,
    review: viewReview,
    policy: viewPolicy,
    settings: viewSettings,
    audit: viewAudit,
  };
  const out = (views[S.view] ?? viewHome)();
  const full = !(out instanceof Node);
  main.replaceChildren(full ? out.body : h("div", { class: "page" }, out));
  document.getElementById("top-title")?.replaceChildren(...[full ? out.title : null].flat().filter(Boolean));
  document.getElementById("top-actions")?.replaceChildren(...(full ? (out.actions ?? []) : []));
}

// A small popover anchored to a button; closes on outside click or Escape.
function popover(anchor, items, { above = false } = {}) {
  closeMenus();
  const menu = h("div", { class: "menu", role: "menu" }, items);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, r.left)}px`;
  menu.style.minWidth = `${Math.max(240, r.width)}px`;
  if (above) menu.style.bottom = `${innerHeight - r.top + 6}px`;
  else menu.style.top = `${r.bottom + 6}px`;
  anchor.setAttribute("aria-expanded", "true");
  const close = (e) => {
    if (e.type === "keydown" && e.key !== "Escape") return;
    if (e.type === "pointerdown" && (menu.contains(e.target) || anchor.contains(e.target))) return;
    closeMenus();
  };
  menu._cleanup = () => {
    anchor.setAttribute("aria-expanded", "false");
    removeEventListener("pointerdown", close, true);
    removeEventListener("keydown", close, true);
  };
  setTimeout(() => {
    addEventListener("pointerdown", close, true);
    addEventListener("keydown", close, true);
  });
  menu.querySelector("button, a")?.focus();
  return menu;
}
function closeMenus() {
  document.querySelectorAll(".menu").forEach((m) => {
    m._cleanup?.();
    m.remove();
  });
}
const menuItem = (icon, label, onclick, extra) =>
  h("button", { role: "menuitem", type: "button", onclick: () => (closeMenus(), onclick()) }, icon ? h("span", { html: ICONS[icon] }) : null, label, extra);

// ------------------------------------------------------------------ activity

const FILTERS = [
  ["all", "All"],
  ["review", "Needs review"],
  ["blocked", "Blocked"],
];

/** Messages grouped into conversations (threads), newest first. */
function conversations() {
  const byThread = new Map();
  for (const m of S.messages) {
    const c = byThread.get(m.thread_id) ?? { id: m.thread_id, messages: [], people: new Set() };
    c.messages.push(m);
    c.people.add(m.from).add(m.to);
    byThread.set(m.thread_id, c);
  }
  const list = [...byThread.values()].map((c) => {
    c.messages.sort((a, b) => a.received_at.localeCompare(b.received_at));
    c.last = c.messages.at(-1);
    c.held = c.messages.filter((m) => m.state === "held").length;
    c.blocked = c.messages.filter((m) => m.state === "blocked" || m.state === "rejected").length;
    return c;
  });
  list.sort((a, b) => b.last.received_at.localeCompare(a.last.received_at));
  if (S.filter === "review") return list.filter((c) => c.held);
  if (S.filter === "blocked") return list.filter((c) => c.blocked);
  return list;
}

function convRow(c) {
  const people = [...c.people];
  return h(
    "button",
    { class: "conv", "aria-selected": S.selected === c.id ? "true" : "false", onclick: () => select(c.id) },
    h("span", { class: "conv-avs" }, people.slice(0, 3).map((a) => avatar(a))),
    h(
      "span",
      { class: "conv-main" },
      h("span", { class: "conv-top" }, h("b", { class: "conv-names" }, people.map(nameOf).join(", ")), h("span", { class: "conv-time" }, ago(c.last.received_at))),
      h("span", { class: "conv-preview" }, `${nameOf(c.last.from)}: ${c.last.preview || "(empty)"}`),
    ),
    c.held ? h("span", { class: "pill held" }, `${c.held} to review`) : c.blocked ? h("span", { class: "pill blocked" }, `${c.blocked} blocked`) : h("span", { class: "conv-count" }, c.messages.length),
  );
}

function viewTraffic() {
  const list = conversations();
  return h(
    "div",
    {},
    pageHead("Activity", "What the agents are saying to each other, as conversations. Open one to read it; the guard's checks are one click away."),
    h(
      "div",
      { class: "filters", role: "group", "aria-label": "Show" },
      FILTERS.map(([key, label]) => h("button", { class: "chip", "aria-pressed": S.filter === key ? "true" : "false", onclick: () => ((S.filter = key), renderView()) }, label)),
    ),
    h(
      "div",
      { class: "traffic" },
      h(
        "div",
        { class: "panel feed" },
        list.length ? list.map(convRow) : h("div", { class: "empty" }, h("strong", {}, S.filter === "all" ? "No conversations yet" : "Nothing here"), S.filter === "all" ? "They show up as soon as an agent sends a message." : "All clear."),
      ),
      h("aside", { class: "panel detail", id: "detail" }, detailView()),
    ),
  );
}

async function select(threadId) {
  S.selected = threadId;
  renderView();
  await loadDetail();
}

async function loadDetail() {
  if (!S.selected) return;
  try {
    S.thread = await api("GET", `/v1/admin/threads/${encodeURIComponent(S.selected)}`);
  } catch (e) {
    toast(e.message);
  }
  document.getElementById("detail")?.replaceChildren(detailView());
}

/** One message's guard stages, fetched when someone asks for them. */
async function guardDetails(box, id) {
  if (box.dataset.loaded) return;
  box.dataset.loaded = "1";
  try {
    const d = await api("GET", `/v1/admin/messages/${encodeURIComponent(id)}`);
    box.append(
      ...[
      h("dl", { class: "kv" }, h("dt", {}, "From"), h("dd", { class: "mono" }, d.from), h("dt", {}, "To"), h("dd", { class: "mono" }, d.to), h("dt", {}, "Scope"), h("dd", {}, d.scope), d.reason ? [h("dt", {}, "Why"), h("dd", {}, d.reason)] : null),
      d.delivered_text && d.original_text && d.delivered_text !== d.original_text ? h("p", { class: "muted small" }, "The guard changed this text before delivery.") : null,
      pipeline(d.stages),
      ].filter(Boolean),
    );
  } catch (e) {
    box.append(h("p", { class: "muted small" }, e.message));
  }
}

function detailView() {
  const t = S.thread;
  if (!S.selected || !t || t.id !== S.selected) return h("div", { class: "empty" }, h("strong", {}, S.selected ? "Loading…" : "Pick a conversation"), S.selected ? "" : "You'll read it like a chat, with what the guard did to each message.");
  return h(
    "div",
    { class: "thread-view" },
    h("div", { class: "thread-head" }, h("h2", {}, t.participants.map(nameOf).join(" and ")), h("span", { class: "muted small" }, `${t.messages.length} message${t.messages.length === 1 ? "" : "s"} · ${t.scope}`)),
    h(
      "div",
      { class: "log tl" },
      t.messages.map((m) => {
        const box = h("div", { class: "guard-box" });
        const ok = m.state === "delivered" || m.state === "queued";
        return h(
          "article",
          { class: "tl-msg" },
          avatar(m.from),
          h(
            "div",
            { class: "tl-body" },
            h("div", { class: "tl-head" }, h("b", {}, nameOf(m.from)), h("span", { class: "tl-to" }, "to ", nameOf(m.to)), h("time", { datetime: m.received_at, title: new Date(m.received_at).toLocaleString() }, ago(m.received_at)), ok ? null : pill(m.state), m.redacted ? h("span", { class: "pill redacted" }, "redacted") : null),
            h("div", { class: `tl-text ${ok ? "" : "dim"}` }, redactedText(m.text ?? m.preview)),
            m.state === "held" ? reviewButtons(m.id) : null,
            h("details", { class: "guard", ontoggle: (e) => e.target.open && guardDetails(box, m.id) }, h("summary", {}, m.reason_code ? `Guard: ${m.state} (${m.reason_code})` : `Guard: ${m.decision ?? m.state}${m.guard_ms != null ? `, ${m.guard_ms} ms` : ""}`), box),
          ),
        );
      }),
    ),
  );
}

function reviewButtons(id) {
  const act = async (decision) => {
    try {
      await api("POST", `/v1/admin/messages/${encodeURIComponent(id)}/review`, { decision });
      toast(decision === "release" ? "Released. It's on its way." : "Rejected. The sender was told.");
      await refresh();
    } catch (e) {
      toast(e.message);
    }
  };
  return h(
    "div",
    { class: "row", style: "margin-top:12px" },
    h("button", { class: "btn", onclick: () => act("release") }, "Release"),
    h("button", { class: "btn danger", onclick: () => act("reject") }, "Reject"),
  );
}

// ------------------------------------------------------------------ conversations (text and voice)

function talkable() {
  const me = S.overview?.relay?.console_address;
  return S.agents.filter((a) => a.address !== me && a.status === "active").sort((a, b) => Number(b.online) - Number(a.online) || a.address.localeCompare(b.address));
}

const SUGGESTIONS = ["Which MCP servers do you have?", "What are you working on right now?", "Summarize what you did today"];

/** The composer: autosizing text, a mic, a send button. `to` is fixed unless `pickTo` lists choices. */
function composer({ to, pickTo, placeholder, onSend, autofocus }) {
  const send = h("button", { class: "send", type: "button", "aria-label": "Send", html: ICONS.up, disabled: !S.talk.draft.trim(), onclick: () => onSend() });
  const draft = h("textarea", {
    id: "draft",
    rows: 1,
    placeholder,
    "aria-label": "Message",
    oninput: (e) => {
      S.talk.draft = e.target.value;
      send.disabled = !S.talk.draft.trim();
      fit(e.target);
    },
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        onSend();
      }
    },
  });
  draft.value = S.talk.draft;
  requestAnimationFrame(() => {
    fit(draft);
    if (autofocus && matchMedia("(hover: hover)").matches) draft.focus();
  });
  const mic = h("button", {
    class: "mic",
    id: "mic",
    type: "button",
    "aria-pressed": S.talk.listening ? "true" : "false",
    "aria-label": S.talk.listening ? "Stop dictating" : "Dictate: speak and it types for you",
    title: S.talk.listening ? "Stop dictating" : "Dictate: speak and it types for you",
    html: S.talk.listening ? ICONS.stop : ICONS.mic,
    disabled: !to && !pickTo?.length,
    onclick: () => (S.talk.listening ? Voice.stop() : startListening()),
  });
  const chip = pickTo?.length
    ? h(
        "label",
        { class: "to-chip" },
        h("span", { class: `lamp ${S.agents.find((a) => a.address === to)?.online ? "on" : ""}` }),
        h("span", {}, `To ${nameOf(to)}`),
        h("span", { html: ICONS.chev }),
        h(
          "select",
          { "aria-label": "Send to", onchange: (e) => ((S.talk.to = e.target.value), renderView()) },
          pickTo.map((a) => h("option", { value: a.address, selected: a.address === to }, `${a.display_name || short(a.address)}${a.online ? "" : " (offline)"}`)),
        ),
      )
    : null;
  return h(
    "div",
    {},
    h("div", { class: "composer" }, draft, h("div", { class: "composer-row" }, chip, mic, send)),
    h(
      "div",
      { class: "composer-note" },
      h("label", {}, h("input", { type: "checkbox", checked: S.talk.autoSend, onchange: (e) => (S.talk.autoSend = e.target.checked) }), "Send as soon as I stop speaking"),
      h("span", { class: "heard", id: "heard" }, S.talk.heard),
    ),
  );
}

function fit(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

/** One conversation with one agent: the message column plus the docked composer. */
function conversation(to) {
  const agent = S.agents.find((a) => a.address === to);
  const name = agent?.display_name || short(to);
  setTimeout(() => loadCall(to), 0);
  return h(
    "section",
    { class: "chat-col", "aria-label": `Conversation with ${name}` },
    h("div", { class: "chat-scroll", id: "chat-scroll" }, h("div", { class: "log", id: "call-log", "aria-live": "polite" }, callLogItems())),
    h("div", { class: "dock" }, composer({ to, placeholder: `Message ${name}…`, onSend: () => sendTalk(), autofocus: true })),
  );
}

function viewTalk() {
  const people = talkable();
  if (S.talk.to && !people.some((a) => a.address === S.talk.to)) S.talk.to = null;
  if (!S.talk.to) {
    return {
      title: h("span", {}, "Talk to an agent"),
      body: people.length
        ? h(
            "div",
            { class: "home" },
            h(
              "div",
              { class: "home-inner" },
              h("h1", { class: "hello" }, "Who do you want to talk to?"),
              h(
                "div",
                { class: "pick", style: "margin-top:28px" },
                people.map((a) =>
                  h(
                    "button",
                    { class: "pick-item", onclick: () => openCall(a.address) },
                    avatar(a.address, "lg"),
                    h("span", {}, h("b", {}, a.display_name || short(a.address)), h("small", { class: "mono" }, a.address)),
                    h("span", { class: `lamp ${a.online ? "on" : ""}` }),
                  ),
                ),
              ),
            ),
          )
        : h(
            "div",
            { class: "chat-empty" },
            h("h2", {}, "No one to talk to yet"),
            h("p", {}, "Start a session and send the link. Their agent shows up here once it joins."),
            h("button", { class: "btn", onclick: newSessionDialog }, "New session"),
          ),
    };
  }
  const agent = S.agents.find((a) => a.address === S.talk.to);
  return {
    title: [h("span", { class: `lamp ${agent?.online ? "on" : ""}` }), h("span", {}, agent?.display_name || short(S.talk.to)), h("span", { class: "topbar-sub mono" }, S.talk.to)],
    actions: [
      h(
        "button",
        { class: "btn secondary small", onclick: () => ((S.talk.thread[S.talk.to] = null), (S.talk.log[S.talk.to] = Object.assign([], { loaded: true })), renderCallLog()) },
        "New conversation",
      ),
    ],
    body: h("div", { class: "chat" }, conversation(S.talk.to)),
  };
}

function openCall(address) {
  Voice.stop();
  S.talk.to = address;
  S.talk.draft = "";
  go("talk");
}

function callLogItems() {
  const to = S.talk.to;
  const items = S.talk.log[to] ?? [];
  if (!items.length) {
    const name = nameOf(to);
    return h(
      "div",
      { class: "chat-empty" },
      bigAvatar(to),
      h("h2", {}, `Say hello to ${name}`),
      h("p", {}, "Type, or press the microphone and speak: your words appear as text you can edit before sending. Everything goes through your relay and its guard."),
      h(
        "div",
        { class: "sugg" },
        SUGGESTIONS.map((s) => h("button", { type: "button", onclick: () => sendTalk(s) }, s)),
      ),
    );
  }
  const out = items.map((m) =>
    m.mine
      ? h("div", { class: "m-me" }, h("div", { class: "m-text" }, m.text), h("span", { class: `m-meta ${["blocked", "rejected"].includes(m.state) ? "bad" : ""}` }, stateLabel(m)))
      : h("div", { class: "m-them" }, h("div", { class: "m-head" }, avatar(m.from), nameOf(m.from), h("span", { class: "m-meta" }, ago(m.at))), h("div", { class: "m-text" }, m.text)),
  );
  if (S.talk.waiting[to]) out.push(h("div", { class: "working", role: "status" }, h("i"), `${nameOf(to)} is working on it`));
  return out;
}

function stateLabel(m) {
  const s = m.state ?? "sending";
  const word =
    {
      sending: "Sending",
      delivered: "Delivered",
      queued: "Waiting for them to come online",
      screening: "Checking",
      held: "Held for your review",
      blocked: "Blocked by the guard",
      rejected: "Rejected",
    }[s] ?? s;
  return `${word}${m.reason_code ? ` (${m.reason_code})` : ""}`;
}

function renderCallLog() {
  const log = document.getElementById("call-log");
  if (!log) return;
  log.replaceChildren(...[callLogItems()].flat());
  const scroll = document.getElementById("chat-scroll");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

async function loadCall(address) {
  if (!address || S.talk.log[address]?.loaded) return renderCallLog();
  try {
    const { messages, address: me } = await api("GET", "/v1/admin/console/messages");
    const threads = [...new Set(messages.filter((m) => m.from === address || m.to === address).map((m) => m.thread_id))].slice(0, 5);
    const details = await Promise.all(threads.map((t) => api("GET", `/v1/admin/threads/${encodeURIComponent(t)}`)));
    const items = details
      .flatMap((t) => t.messages)
      .filter((m) => (m.from === me && m.to === address) || (m.from === address && m.to === me))
      .map((m) => ({ id: m.id, thread_id: m.thread_id, mine: m.from === me, from: m.from, text: m.text ?? m.preview, state: m.state, reason_code: m.reason_code, at: m.received_at }))
      .sort((a, b) => a.at.localeCompare(b.at));
    S.talk.log[address] = Object.assign(items, { loaded: true });
    if (!S.talk.thread[address] && items.length) S.talk.thread[address] = items.at(-1).thread_id;
  } catch (e) {
    toast(e.message);
  }
  if (S.talk.to === address) renderCallLog();
}

async function sendTalk(textOverride) {
  const to = S.talk.to;
  const text = (typeof textOverride === "string" ? textOverride : S.talk.draft).trim();
  if (!to || !text) return;
  S.talk.draft = "";
  const draft = document.getElementById("draft");
  if (draft) {
    draft.value = "";
    fit(draft);
  }
  document.querySelector(".send")?.setAttribute("disabled", "");
  const log = (S.talk.log[to] ??= Object.assign([], { loaded: true }));
  const item = { id: null, mine: true, from: S.overview?.relay?.console_address, text, state: "sending", at: new Date().toISOString() };
  log.push(item);
  renderCallLog();
  try {
    const r = await api("POST", "/v1/admin/console/send", { to, text, thread_id: S.talk.thread[to] || undefined });
    Object.assign(item, { id: r.id, thread_id: r.thread_id, state: r.state, reason_code: r.reason_code });
    S.talk.thread[to] = r.thread_id;
    if (["delivered", "queued", "screening"].includes(r.state)) S.talk.waiting[to] = true;
  } catch (e) {
    Object.assign(item, { state: "blocked", reason_code: e.code });
    toast(e.message);
  }
  renderCallLog();
}

function setHeard(text) {
  S.talk.heard = text;
  const el = document.getElementById("heard");
  if (el) el.textContent = text;
}

async function startListening() {
  try {
    await Voice.start({
      onInterim: (t) => setHeard(t),
      onFinal: (t) => {
        setHeard("");
        if (!t.trim()) return;
        if (S.talk.autoSend) (S.view === "sessions" ? sendFromHome : sendTalk)(t);
        else {
          S.talk.draft = `${S.talk.draft ? `${S.talk.draft} ` : ""}${t}`;
          const d = document.getElementById("draft");
          if (d) {
            d.value = S.talk.draft;
            fit(d);
          }
        }
      },
      onState: (on) => {
        S.talk.listening = on;
        const b = document.getElementById("mic");
        if (b) {
          b.setAttribute("aria-pressed", on ? "true" : "false");
          b.setAttribute("aria-label", on ? "Stop dictating" : "Dictate: speak and it types for you");
          b.innerHTML = on ? ICONS.stop : ICONS.mic;
        }
        if (!on) setHeard("");
      },
    });
  } catch (e) {
    toast(e.message);
  }
}

/**
 * Voice input. Prefers Reson8's Turns endpoint (the relay mints a 10-minute token; the API key
 * never reaches the browser): mic audio is downsampled to 16 kHz PCM and streamed, and each
 * finished turn becomes a message. Falls back to the browser's own speech recognition.
 */
const Voice = {
  session: null,
  stop() {
    this.session?.stop();
    this.session = null;
  },
  async start(cb) {
    this.stop();
    let token = null;
    try {
      token = await api("POST", "/v1/voice/token");
    } catch (e) {
      if (e.code !== "voice_not_configured") throw e;
    }
    this.session = token?.access_token ? await reson8Session(token.access_token, cb) : browserSession(cb);
  },
};

const WORKLET = `class A2APcm extends AudioWorkletProcessor { process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; } } registerProcessor("a2a-pcm", A2APcm);`;

async function reson8Session(accessToken, cb) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "a2a-pcm");
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node).connect(sink).connect(ctx.destination);

  const url = "wss://api.reson8.dev/v1/speech-to-text/turns?encoding=pcm_s16le&sample_rate=16000&channels=1&filler_mode=clean";
  const ws = new WebSocket(url, ["bearer", accessToken]);
  ws.binaryType = "arraybuffer";
  const ratio = ctx.sampleRate / 16000;
  let pending = [];
  let latest = "";
  let closed = false;

  node.port.onmessage = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const input = e.data;
    // Average-decimate to 16 kHz, then convert to 16-bit little-endian PCM.
    for (let i = 0; i + ratio <= input.length; i += ratio) {
      let sum = 0;
      const start = Math.floor(i);
      const end = Math.floor(i + ratio);
      for (let j = start; j < end; j++) sum += input[j];
      pending.push(sum / Math.max(1, end - start));
    }
    if (pending.length >= 1600) {
      const pcm = new Int16Array(pending.length);
      for (let k = 0; k < pending.length; k++) pcm[k] = Math.max(-1, Math.min(1, pending[k])) * 0x7fff;
      ws.send(pcm.buffer);
      pending = [];
    }
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "turn_end_candidate") {
      latest = msg.text ?? "";
      cb.onInterim(latest);
    } else if (msg.type === "turn_end") {
      const text = latest;
      latest = "";
      cb.onFinal(text);
    }
  };
  ws.onerror = () => toast("Lost the connection to Reson8.");
  ws.onclose = () => !closed && stop();
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    setTimeout(() => reject(new Error("Couldn't reach Reson8. Check the API key and your network.")), 8000);
  });
  cb.onState(true);

  function stop() {
    if (closed) return;
    closed = true;
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "flush_request" }));
      setTimeout(() => ws.close(), 600);
    } catch {
      /* already closed */
    }
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    cb.onState(false);
  }
  return { stop };
}

function browserSession(cb) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error("Voice needs a Reson8 key on the relay (RESON8_API_KEY) or a browser with speech recognition, like Chrome or Edge.");
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";
  let stopped = false;
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) cb.onFinal(r[0].transcript);
      else interim += r[0].transcript;
    }
    if (interim) cb.onInterim(interim);
  };
  rec.onerror = (e) => e.error !== "no-speech" && toast(`Voice stopped: ${e.error}`);
  rec.onend = () => (stopped ? cb.onState(false) : rec.start());
  rec.start();
  cb.onState(true);
  return {
    stop() {
      stopped = true;
      rec.stop();
    },
  };
}

// ------------------------------------------------------------------ agents

function viewAgents() {
  const act = async (a, action) => {
    try {
      await api("POST", `/v1/admin/agents/${encodeURIComponent(a.address)}/${action}`);
      toast(action === "approve" ? `${short(a.address)} approved` : action === "disable" ? `${short(a.address)} disabled` : `${short(a.address)} enabled`);
      await refresh();
    } catch (e) {
      toast(e.message);
    }
  };
  const me = S.overview?.relay?.console_address;
  return h(
    "div",
    {},
    pageHead("Agents", "Every agent in this workspace, and the person who signed in to connect it. Approve agents that asked to join, or disable one to cut it off at once."),
    h(
      "div",
      { class: "panel table-wrap" },
      h(
        "table",
        { class: "table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Agent"), h("th", {}, "Person"), h("th", {}, "Status"), h("th", {}, "Last seen"), h("th", {}, "Machine"), h("th", {}, h("span", { class: "sr-only" }, "Actions")))),
        h(
          "tbody",
          {},
          S.agents.map((a) =>
            h(
              "tr",
              {},
              h(
                "td",
                {},
                h(
                  "div",
                  { class: "row" },
                  h("span", { class: `lamp ${a.online ? "on" : ""}` }),
                  h("div", {}, h("b", {}, a.display_name || short(a.address)), h("div", { class: "mono muted" }, a.address)),
                ),
              ),
              h("td", {}, a.account ? h("div", {}, h("div", {}, a.account.name ?? ""), h("div", { class: "muted small" }, a.account.email ?? "")) : h("span", { class: "muted small" }, a.address === me ? "" : "not signed in")),
              h("td", {}, pill(a.status)),
              h("td", {}, a.online ? "online now" : a.last_seen_at ? timeEl(a.last_seen_at) : "never"),
              h("td", { class: "muted" }, a.host || ""),
              h(
                "td",
                { style: "text-align:right" },
                a.address === me
                  ? h("span", { class: "muted" }, "this console")
                  : a.status === "pending"
                    ? h("button", { class: "btn small", onclick: () => act(a, "approve") }, "Approve")
                    : a.status === "active"
                      ? h("button", { class: "btn danger small", onclick: () => act(a, "disable") }, "Disable")
                      : h("button", { class: "btn secondary small", onclick: () => act(a, "enable") }, "Enable"),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ review

function viewReview() {
  const held = S.messages.filter((m) => m.state === "held");
  return h(
    "div",
    {},
    pageHead("Review", "Messages the guard held for you to look at. Release them, or reject them and the sender is told."),
    held.length
      ? h(
          "div",
          { class: "traffic" },
          h(
            "div",
            { class: "panel feed" },
            conversations().filter((c) => c.held).map(convRow),
          ),
          h("aside", { class: "panel detail", id: "detail" }, detailView()),
        )
      : h("div", { class: "panel empty" }, h("strong", {}, "Nothing waiting"), "Held messages land here for you to release or reject."),
  );
}

// ------------------------------------------------------------------ policy

function viewPolicy() {
  const editor = h("textarea", { class: "textarea editor", spellcheck: "false", "aria-label": "Policy YAML" }, "Loading…");
  const noteInput = h("input", { class: "input", placeholder: "What changed (optional)", maxlength: 200 });
  const errors = h("div", { class: "error", role: "alert" });
  const versions = h("div", {});
  const summary = h("div", { class: "policy-summary" }, h("p", { class: "muted" }, "Loading the current policy…"));
  const save = async () => {
    errors.textContent = "";
    try {
      const r = await api("PUT", "/v1/admin/policy", { yaml: editor.value, note: noteInput.value || undefined });
      toast(`Policy saved as version ${r.version}`);
      noteInput.value = "";
      await refresh();
      load();
    } catch (e) {
      errors.replaceChildren(
        h("p", {}, "The policy wasn't saved:"),
        h(
          "ul",
          {},
          (e.data?.errors ?? [e.message]).map((x) => h("li", {}, x)),
        ),
      );
    }
  };
  async function load() {
    try {
      const p = await api("GET", "/v1/admin/policy");
      editor.value = p.yaml;
      summary.replaceChildren(policySummary(p));
      versions.replaceChildren(
        h("h3", { class: "section-title", style: "margin-top:0" }, "History"),
        h(
          "div",
          { class: "stages" },
          p.versions.map((v) =>
            h("div", { class: "stage" }, h("span", { class: "stage-name" }, `v${v.version}`), h("span", {}, v.note || "No note"), h("span", { class: "muted" }, ago(v.created_at))),
          ),
        ),
      );
    } catch (e) {
      toast(e.message);
    }
  }
  setTimeout(load, 0);
  return h(
    "div",
    {},
    pageHead("Policy", "Who may message whom, what gets masked or blocked, and how people join. Every message records the version it was judged under."),
    h(
      "div",
      { class: "policy" },
      h(
        "div",
        { class: "policy-main" },
        h("section", { class: "panel panel-pad" }, summary),
        h(
          "details",
          { class: "panel panel-pad policy-edit" },
          h("summary", {}, "Edit as YAML"),
          h("div", { style: "margin-top:12px" }, editor, h("div", { class: "row", style: "margin-top:12px" }, noteInput, h("button", { class: "btn", onclick: save }, "Save policy")), errors),
        ),
      ),
      h(
        "aside",
        { class: "panel panel-pad" },
        versions,
        h("h3", { class: "section-title" }, "Quick reference"),
        h(
          "ul",
          { class: "muted", style: "padding-left:18px; margin:0" },
          h("li", {}, "registration: approval, invite or open"),
          h("li", {}, 'links with scopes ["*"] allow any topic, even ones not listed'),
          h("li", {}, "rules.block, rules.hold and rules.redact take finding names like secret_detected"),
          h("li", {}, "guard.judge: off, heuristic, or anthropic (needs ANTHROPIC_API_KEY)"),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ policy in plain words

const FINDINGS = {
  secret_detected: "API keys, tokens and passwords",
  payment_card: "card numbers",
  pii: "personal data like emails, phone numbers and ID numbers",
  instruction_override: "attempts to override the other agent's instructions",
  credential_request: "requests for passwords or keys",
  dangerous_action: "requests for destructive actions",
  data_exfiltration: "attempts to send data to outside addresses",
  out_of_scope: "messages off the agreed topic",
  obfuscation: "hidden or disguised text",
  social_engineering: "social engineering",
  attachment_type: "executable attachments",
};
const findingList = (names) => (names.length ? names.map((n) => FINDINGS[n] ?? n.replaceAll("_", " ")).join(", ") : "nothing");

function duration(ms) {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} day${ms === 86_400_000 ? "" : "s"}`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? "" : "s"}`;
  return `${Math.round(ms / 60_000)} minutes`;
}

function whoIs(pattern, org) {
  if (pattern === `agent://${org}/*` || pattern === "agent://*/*") return `everyone in ${org}`;
  if (pattern.endsWith("/*")) return `everyone matching ${pattern}`;
  return nameOf(pattern);
}

function policySummary(p) {
  const org = p.org;
  const links = p.links.length
    ? h(
        "ul",
        { class: "plain-list" },
        p.links.map((l) =>
          h("li", {}, `${whoIs(l.from, org)} can message ${whoIs(l.to, org)} ${l.scopes.includes("*") ? "about anything" : `about ${l.scopes.join(", ")}`}${l.rate ? `, up to ${l.rate}` : ""}.`),
        ),
      )
    : "Nobody can start a conversation yet. Agents can still reply to messages they receive, and you can message anyone from Talk.";
  const judge =
    {
      off: "Off. Only the checks above run, so messages are delivered in milliseconds.",
      heuristic: "Offline keyword checks on top of the rules above.",
      anthropic: "Claude reviews each message before delivery (adds about a second).",
      auto: "Claude reviews each message when an Anthropic key is set; otherwise offline keyword checks.",
      "claude-cli": "Offline keyword checks (the Claude CLI isn't available on Cloudflare).",
    }[p.guard.judge] ?? p.guard.judge;
  const joining =
    {
      approval: "Anyone can ask to join; you approve each new agent on the Agents page.",
      invite: "With an invite link from the Invites page. Without one, you approve them on the Agents page.",
      open: "Anyone who knows the relay address joins straight away.",
    }[p.registration] ?? p.registration;
  const lim = p.limits;
  return h(
    "div",
    {},
    h("h2", { class: "section-title", style: "margin-top:0" }, "What this policy does"),
    h(
      "dl",
      { class: "kv policy-kv" },
      h("dt", {}, "Joining"),
      h("dd", {}, joining),
      h("dt", {}, "Who can message whom"),
      h("dd", {}, links),
      h("dt", {}, "Topics"),
      h(
        "dd",
        {},
        h(
          "ul",
          { class: "plain-list" },
          Object.entries(p.scopes).map(([name, s]) => h("li", {}, h("b", {}, name), ": ", s.description)),
        ),
      ),
      h("dt", {}, "Masked before delivery"),
      h("dd", {}, findingList(p.rules.redact)),
      h("dt", {}, "Held for your review"),
      h("dd", {}, findingList(p.rules.hold)),
      h("dt", {}, "Blocked"),
      h("dd", {}, findingList(p.rules.block)),
      h("dt", {}, "AI guard"),
      h("dd", {}, judge),
      h("dt", {}, "Limits"),
      h(
        "dd",
        {},
        `${lim.max_hops_per_thread} back-and-forths and ${lim.max_messages_per_thread} messages per conversation, ${Math.round(lim.max_body_bytes / 1024)} KiB per message (files included). Undelivered messages expire after ${duration(lim.message_ttl_ms)}.`,
      ),
    ),
  );
}

// ------------------------------------------------------------------ audit

function viewAudit() {
  const list = h("div", { class: "panel feed" }, h("div", { class: "empty" }, "Loading…"));
  api("GET", "/v1/admin/audit")
    .then(({ events }) =>
      list.replaceChildren(
        ...(events.length
          ? events.map((e) =>
              h(
                "div",
                { class: "msg", style: "cursor:default" },
                h("span", { class: "msg-route" }, e.action, h("span", { class: "arrow" }, "by"), e.actor),
                h("span", { class: "msg-time" }, timeEl(e.at)),
                h("span", { class: "msg-preview mono" }, e.target ?? ""),
              ),
            )
          : [h("div", { class: "empty" }, "No events yet.")]),
      ),
    )
    .catch((e) => toast(e.message));
  return h("div", {}, pageHead("Audit log", "Sign-ins, approvals, policy changes, invites and messages read from this console."), list);
}

// ------------------------------------------------------------------ data + live updates

async function refresh() {
  try {
    const [overview, list, agents] = await Promise.all([api("GET", "/v1/admin/overview"), api("GET", "/v1/admin/messages?limit=200"), api("GET", "/v1/admin/agents")]);
    S.overview = overview;
    S.messages = list.messages;
    S.agents = agents.agents;
  } catch (e) {
    toast(e.message);
  }
  renderShell();
}

let rerenderTimer;
function soon() {
  // Coalesce bursts of events; never redraw the Talk page under someone's cursor.
  clearTimeout(rerenderTimer);
  // Lists redraw; screens with a composer keep their place and only the sidebar updates.
  rerenderTimer = setTimeout(() => {
    renderSide();
    if (["traffic", "agents", "review"].includes(S.view)) renderView();
  }, 250);
}

let events;
function closeEvents() {
  events?.close();
  events = null;
}

function connectEvents() {
  closeEvents();
  events = new EventSource(relayPath("/v1/admin/events"));
  events.onopen = () => {
    S.connected = true;
    renderLive();
  };
  events.onerror = () => {
    S.connected = false;
    renderLive();
  };
  events.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const i = S.messages.findIndex((x) => x.id === m.id);
    if (i >= 0) S.messages[i] = m;
    else S.messages.unshift(m);
    for (const log of Object.values(S.talk.log)) {
      const item = log.find((x) => x.id === m.id);
      if (item) Object.assign(item, { state: m.state, reason_code: m.reason_code });
    }
    if (S.view === "talk" || S.view === "session") renderCallLog();
    if (S.selected === m.thread_id && (S.view === "traffic" || S.view === "review")) loadDetail();
    if (S.view === "session" && S.sessionData && !S.sessionData.error) {
      clearTimeout(S.sessionReload);
      S.sessionReload = setTimeout(loadSession, 400);
    }
    soon();
  });
  events.addEventListener("console", (e) => {
    const m = JSON.parse(e.data);
    const log = (S.talk.log[m.from] ??= Object.assign([], { loaded: false }));
    if (!log.some((x) => x.id === m.id)) log.push({ id: m.id, thread_id: m.thread_id, mine: false, from: m.from, text: m.text ?? m.preview, state: m.state, at: m.received_at });
    S.talk.thread[m.from] = m.thread_id;
    delete S.talk.waiting[m.from];
    if ((S.view === "talk" || S.view === "session") && S.talk.to === m.from) {
      renderCallLog();
    } else {
      toast(`${nameOf(m.from)} replied`);
      soon();
    }
  });
  events.addEventListener("agent", (e) => {
    const a = JSON.parse(e.data);
    const i = S.agents.findIndex((x) => x.address === a.address);
    if (i >= 0) S.agents[i] = { ...S.agents[i], ...a };
    else S.agents.push(a);
    soon();
  });
  events.addEventListener("policy", () => refresh());
  events.addEventListener("session", (e) => {
    const ev = JSON.parse(e.data);
    loadSessions().then(soon);
    if (S.view === "session" && ev.id === S.session) (ev.deleted ? (toast("This session was deleted"), go("sessions")) : loadSession());
  });
  let sessionsTimer;
  events.addEventListener("message", () => {
    clearTimeout(sessionsTimer);
    sessionsTimer = setTimeout(() => loadSessions().then(soon), 600);
  });
}

// ------------------------------------------------------------------ dialogs

/** A modal built on <dialog>: focus is trapped, Escape closes it, and it returns focus when done. */
function openDialog(title, ...body) {
  const dlg = h(
    "dialog",
    { class: "dialog", "aria-label": title, onclose: () => dlg.remove() },
    h("div", { class: "dialog-head" }, h("h2", {}, title), h("button", { class: "icon-btn", type: "button", "aria-label": "Close", html: ICONS.x, onclick: () => dlg.close() })),
    h("div", { class: "dialog-body" }, body),
  );
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function copyLine(text, label = "Copy") {
  return h("div", { class: "copy-line" }, h("code", {}, text), h("button", { class: "btn secondary small", type: "button", onclick: () => copy(text, "Copied") }, label));
}

const PLUGIN_INSTALL = "/plugin install a2a@a2a";

/** The one command that sets A2A up: downloads the client, signs in, connects every AI app here. */
const cliUrl = () => `${location.origin}/downloads/${S.cli?.file ?? "a2a-sdk-0.3.0.tgz"}`;
const connectCommand = (url) => `npx -y ${cliUrl()} connect${url ? ` ${url}` : ""}`;

/**
 * What someone pastes into their AI agent (Claude Code, Antigravity, Cursor, Codex, ...). The agent
 * runs one command; the person signs in once in the browser; every AI app on the computer connects.
 */
function setupPrompt(url, sessionName) {
  return [
    sessionName ? `Connect me to the A2A session "${sessionName}" so my AI agents can work with the others in it.` : "Connect my AI apps on this computer to my A2A workspace.",
    "",
    "Run this in a terminal (it needs Node.js 22 or newer):",
    "",
    connectCommand(url),
    "",
    "It opens my browser to sign in and prints a short code. Show me the code so I can enter it, then let the command keep running until I approve (up to 10 minutes; run it in the background or with a long timeout). It gives each AI app on this computer its own agent and adds A2A to their MCP settings.",
    "When it finishes, tell me which apps it connected. Then reload your MCP servers (or tell me to restart you) and call the a2a list_sessions tool to read the session brief.",
  ].join("\n");
}

/** The invite, as one block to copy, with the plain link and the Claude Code plug-in as alternatives. */
function inviteSteps(url, sessionName) {
  return h(
    "div",
    { class: "prompt-card" },
    h("div", { class: "prompt-head" }, h("b", {}, "Paste this into any AI agent"), h("span", { class: "muted small" }, "Claude Code, Antigravity, Cursor, Codex, Gemini CLI, Windsurf, VS Code")),
    h("pre", { class: "prompt-text" }, setupPrompt(url, sessionName)),
    h(
      "div",
      { class: "row" },
      h("button", { class: "btn", type: "button", onclick: () => copy(setupPrompt(url, sessionName), "Prompt copied. Send it, or paste it into your agent.") }, "Copy prompt"),
      url ? h("button", { class: "btn secondary", type: "button", onclick: () => copy(url, "Link copied") }, "Copy link only") : null,
    ),
    h(
      "details",
      { class: "more" },
      h("summary", {}, "Other ways to connect"),
      h("p", { class: "muted small" }, "In a terminal:"),
      copyLine(connectCommand(url)),
      h("p", { class: "muted small" }, "In Claude Code with the plug-in:"),
      copyLine(PLUGIN_INSTALL),
      url ? copyLine(`Connect me to A2A with ${url}`) : null,
      h("p", { class: "muted small" }, "Everyone signs in with Google or email, so you always see who joined."),
    ),
  );
}

// ------------------------------------------------------------------ workspace and account

function workspaceMenu(anchor) {
  popover(anchor, [
    h("div", { class: "menu-h" }, "Workspaces"),
    S.workspaces.map((w) => menuItem(null, w.name, () => w.slug !== S.ws && switchWorkspace(w.slug), w.slug === S.ws ? h("span", { class: "check", html: ICONS.check }) : null)),
    h("hr"),
    menuItem("plus", "New workspace", () => newWorkspaceDialog()),
    menuItem("settings", "Workspace settings", () => go("settings")),
  ]);
}

function newWorkspaceDialog() {
  const name = h("input", { class: "input", placeholder: "Research team", maxlength: 60, required: true });
  const dlg = openDialog(
    "New workspace",
    h("p", { class: "muted" }, "A workspace has its own agents, sessions and policy. Use one per team or project."),
    h(
      "form",
      {
        class: "dialog-form",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const ws = await api("POST", "/api/workspaces", { name: name.value });
            S.workspaces.push(ws);
            dlg.close();
            switchWorkspace(ws.slug);
          } catch (err) {
            toast(err.message);
          }
        },
      },
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("div", { class: "dialog-actions", style: "margin-top:16px" }, h("button", { class: "btn", type: "submit" }, "Create workspace")),
    ),
  );
  name.focus();
}

async function switchWorkspace(slug) {
  Voice.stop();
  closeEvents();
  Object.assign(S, { ws: slug, session: null, sessionData: null, view: "sessions", selected: null, detail: null, messages: [], agents: [], sessions: [] });
  S.talk.log = {};
  S.talk.thread = {};
  S.talk.waiting = {};
  S.talk.to = null;
  try {
    localStorage.setItem("a2a-ws", slug);
  } catch {
    /* storage blocked */
  }
  await Promise.all([refresh(), loadSessions()]);
  connectEvents();
  go("sessions");
}

function face(u, cls = "user-av") {
  return u.avatar_url
    ? h("img", { class: cls, src: u.avatar_url, alt: "", referrerpolicy: "no-referrer" })
    : h("span", { class: `${cls} initials`, "aria-hidden": "true" }, (u.name || u.email || "?").slice(0, 1).toUpperCase());
}

function userButton() {
  const u = S.me ?? {};
  return h(
    "button",
    { class: "user-btn", "aria-haspopup": "menu", "aria-expanded": "false", onclick: (e) => accountMenu(e.currentTarget) },
    face(u),
    h("span", { class: "user-text" }, h("span", { class: "user-name" }, u.name || "You"), h("span", { class: "user-mail" }, u.email || "")),
  );
}

function accountMenu(anchor) {
  const dark = document.documentElement.dataset.theme !== "light";
  popover(
    anchor,
    [
      h("div", { class: "menu-h" }, S.me?.email ?? ""),
      menuItem("settings", "Settings", () => go("settings")),
      menuItem(dark ? "sun" : "moon", dark ? "Light theme" : "Dark theme", () => setTheme(dark ? "light" : "dark")),
      window.a2aDesktop ? null : menuItem("download", "Get the desktop app", () => (location.href = "/#desktop")),
      h("a", { role: "menuitem", href: "/docs", target: "_blank", rel: "noopener" }, h("span", { html: ICONS.doc }), "Docs"),
      h("hr"),
      menuItem("logout", "Sign out", signOut),
    ],
    { above: true },
  );
}

// In the desktop app, show whether this computer's agent is connected.
let deviceState = null;
function deviceLine() {
  if (!window.a2aDesktop) return null;
  const on = deviceState?.connected;
  return h(
    "div",
    { class: "device", title: deviceState?.address ?? "" },
    h("span", { class: `lamp ${on ? "on" : ""}` }),
    on ? "This computer is connected" : deviceState ? "This computer is offline" : "Checking this computer…",
  );
}
function watchDevice() {
  if (!window.a2aDesktop) return;
  const update = (s) => {
    deviceState = s;
    document.querySelector(".device")?.replaceWith(deviceLine());
  };
  window.a2aDesktop
    .status()
    .then(update)
    .catch(() => {});
  window.a2aDesktop.onStatus?.(update);
}

async function signOut() {
  Voice.stop();
  closeEvents();
  await fetch("/auth/signout", { method: "POST" });
  if (window.a2aDesktop?.signOut) return window.a2aDesktop.signOut();
  location.href = "/";
}

// ------------------------------------------------------------------ home and sessions

async function loadSessions() {
  try {
    S.sessions = (await api("GET", "/v1/admin/sessions")).sessions;
  } catch (e) {
    S.sessions = [];
    if (e.status !== 404) toast(e.message);
  }
}

const ownerAgents = () => S.agents.filter((a) => a.owner && a.status === "active" && a.address !== S.overview?.relay?.console_address);

function greeting() {
  const hr = new Date().getHours();
  const part = hr < 5 ? "Good evening" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const first = (S.me?.name || "").split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

function viewHome() {
  // The entrance plays once per visit, not on every refresh.
  setTimeout(() => (S.homeShown = true), 900);
  const people = talkable();
  if (people.length && !people.some((a) => a.address === S.talk.to)) S.talk.to = people.find((a) => a.online)?.address ?? people[0].address;
  const mine = ownerAgents();
  const recent = sortedSessions().slice(0, 6);
  const isolated = S.overview?.relay?.isolation === "sessions";
  return {
    title: null,
    body: h(
      "div",
      { class: `home ${S.homeShown ? "calm" : ""}` },
      h(
        "div",
        { class: "home-inner" },
        h("h1", { class: "hello" }, greeting()),
        h("p", { class: "hello-sub" }, people.length ? "Ask any agent in your sessions. The answer comes back here." : "Start a session to bring someone's agent in."),
        people.length ? composer({ to: S.talk.to, pickTo: people, placeholder: `Ask ${nameOf(S.talk.to)} anything…`, onSend: () => sendFromHome(), autofocus: true }) : null,
        h(
          "div",
          { class: "sugg" },
          h("button", { type: "button", onclick: newSessionDialog }, h("span", { html: ICONS.plus }), "New session"),
          mine.length ? null : h("button", { type: "button", onclick: connectAgentDialog }, h("span", { html: ICONS.invites }), "Connect your AI apps"),
          S.overview?.stats?.held ? h("button", { type: "button", onclick: () => go("review") }, h("span", { html: ICONS.review }), `Review ${S.overview.stats.held} held`) : null,
          h("button", { type: "button", onclick: () => go("traffic") }, h("span", { html: ICONS.traffic }), "See activity"),
        ),
        !isolated ? h("div", { class: "banner" }, h("p", {}, h("b", {}, "Org-wide links. "), "Everyone here can reach everyone the policy allows. New workspaces keep each session private.")) : null,
        recent.length
          ? h(
              "section",
              { class: "recent", "aria-label": "Recent sessions" },
              h("div", { class: "recent-h" }, h("span", {}, "Recent sessions")),
              h(
                "div",
                { class: "recent-list" },
                recent.map((s) =>
                  h(
                    "button",
                    { class: "r-item", onclick: () => openSession(s.id) },
                    h("span", { class: "r-name" }, s.name),
                    h("span", { class: "r-time" }, s.last_message_at ? ago(s.last_message_at) : s.guests.length ? "" : "invited"),
                    h("span", { class: "r-preview" }, s.last_preview || (s.guests.length ? "No messages yet." : "Waiting for them to join.")),
                  ),
                ),
              ),
            )
          : null,
      ),
    ),
  };
}

async function sendFromHome(textOverride) {
  if (!S.talk.to) return;
  const text = (typeof textOverride === "string" ? textOverride : S.talk.draft).trim();
  if (!text) return;
  S.talk.draft = "";
  go("talk");
  await sendTalk(text);
}

function newSessionDialog() {
  closeMenus();
  toggleSide(false);
  const name = h("input", { class: "input", placeholder: "Launch team", maxlength: 80, required: true, autocomplete: "off" });
  const size = h("input", { class: "input", type: "number", min: 2, max: S.maxMembers, value: 10, required: true, inputmode: "numeric" });
  const brief = h("textarea", { class: "input", rows: 4, maxlength: 8000, placeholder: "What this session is for, who owns what, links. Every agent reads this when it joins, so nobody has to explain from the start." });
  const body = h(
    "form",
    {
      class: "dialog-form",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const s = await api("POST", "/v1/admin/sessions", { name: name.value, max_members: Number(size.value), brief: brief.value });
          await loadSessions();
          renderSide();
          body.replaceChildren(
            h("p", {}, `Send this to the people you want in "${s.name}". One link works for up to ${s.max_members} people for 14 days, and everyone signs in, so you see who joined.`),
            inviteSteps(s.invite.url, s.name),
            h("div", { class: "dialog-actions" }, h("button", { class: "btn", type: "button", onclick: () => (dlg.close(), openSession(s.id)) }, "Open session")),
          );
        } catch (err) {
          toast(err.message);
        }
      },
    },
    h("label", { class: "field" }, h("span", {}, "Session name"), name),
    h("label", { class: "field" }, h("span", {}, `How many people can join (2 to ${S.maxMembers}, not counting you)`), size),
    h("label", { class: "field" }, h("span", {}, "Brief (optional)"), brief),
    h("p", { class: "muted small" }, "People in a session can reach each other's agents and yours, never people in your other sessions."),
    h("div", { class: "dialog-actions" }, h("button", { class: "btn", type: "submit" }, "Create session")),
  );
  const dlg = openDialog("New session", body);
  name.focus();
}

function connectAgentDialog() {
  openDialog(
    "Connect your AI apps",
    h("p", {}, "Paste this prompt into any AI agent on your computer. It signs you in once and connects every AI app it finds, each as its own agent, so your Claude Code and your Antigravity can talk to each other and to your sessions."),
    inviteSteps(null, null),
    window.a2aDesktop
      ? null
      : h(
          "details",
          { class: "more" },
          h("summary", {}, "Prefer an app?"),
          h("p", { class: "muted small" }, "The desktop app keeps this computer connected and signs in for you."),
          h("div", { class: "row" }, h("a", { class: "btn secondary small", href: "/download/windows" }, h("span", { html: ICONS.download }), "Windows"), h("a", { class: "btn secondary small", href: "/docs#desktop", target: "_blank" }, "Mac and Linux")),
        ),
  );
}

async function openSession(id) {
  S.session = id;
  S.sessionData = null;
  go("session");
  await loadSession();
}

async function loadSession() {
  try {
    S.sessionData = await api("GET", `/v1/admin/sessions/${encodeURIComponent(S.session)}`);
    const guests = S.sessionData.members.filter((m) => m.role === "guest");
    if (!guests.some((g) => g.address === S.talk.to)) S.talk.to = guests.find((g) => g.online)?.address ?? guests[0]?.address ?? null;
  } catch (e) {
    if (e.status !== 404) toast(e.message);
    S.sessionData = { error: true };
  }
  if (S.view === "session") renderView();
}

/** "Sam (Claude Code)" -> "Claude Code": the app an agent speaks for, from its display name. */
const appOf = (m) => (m.address?.endsWith("/console") ? "Dashboard" : null) ?? /\(([^)]+)\)\s*$/.exec(m.display_name ?? "")?.[1] ?? null;

/** Session members grouped by person: one row per person, with each of their apps. */
function peopleOf(members, me) {
  const groups = new Map();
  for (const m of members) {
    if (m.address === me) continue;
    const key = m.account_id ?? m.address;
    const g = groups.get(key) ?? { key, name: m.person || (m.display_name ?? short(m.address)).replace(/\s*\([^)]*\)\s*$/, ""), email: m.email, role: m.role, agents: [] };
    g.agents.push(m);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "owner" ? -1 : 1));
}

/** Who said what, in order: every message between this session's people, as one readable timeline. */
function timeline(messages, me, names) {
  const label = (a) => names?.get(a) ?? nameOf(a);
  if (!messages.length) return h("div", { class: "chat-empty" }, h("h2", {}, "No messages yet"), h("p", {}, "When the agents in this session talk to each other or to you, it shows up here as it happens."));
  let lastDay = "";
  return messages.map((m) => {
    const day = new Date(m.received_at).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    const sep = day !== lastDay ? h("div", { class: "tl-day" }, h("span", {}, day)) : null;
    lastDay = day;
    const mine = m.from === me;
    const ok = m.state === "delivered" || m.state === "queued";
    return [
      sep,
      h(
        "article",
        { class: `tl-msg ${mine ? "mine" : ""}` },
        avatar(m.from),
        h(
          "div",
          { class: "tl-body" },
          h(
            "div",
            { class: "tl-head" },
            h("b", {}, mine ? "You" : label(m.from)),
            h("span", { class: "tl-to" }, "to ", m.to === me ? "you" : label(m.to)),
            h("time", { datetime: m.received_at, title: new Date(m.received_at).toLocaleString() }, new Date(m.received_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })),
            ok ? null : pill(m.state),
          ),
          h("div", { class: `tl-text ${ok ? "" : "dim"}` }, redactedText(m.text ?? m.preview)),
        ),
      ),
    ];
  });
}

function viewSession() {
  const d = S.sessionData;
  const listed = S.sessions.find((s) => s.id === S.session);
  if (!d) return { title: h("span", {}, listed?.name ?? "Session"), body: h("div", { class: "chat-empty" }, h("p", {}, "Loading the session…")) };
  if (d.error) return { title: h("span", {}, "Session"), body: h("div", { class: "chat-empty" }, h("h2", {}, "This session isn't available"), h("p", {}, "It may have been deleted.")) };
  const me = S.overview?.relay?.console_address;
  const guests = d.members.filter((m) => m.role === "guest");
  const people = peopleOf(d.members, me);
  const guestPeople = people.filter((p) => p.role === "guest").length;
  const liveInvite = d.invites.find((i) => i.valid);

  const invite = async () => {
    try {
      const url = liveInvite?.url ?? (await api("POST", `/v1/admin/sessions/${encodeURIComponent(d.id)}/invites`, { note: d.name, max_uses: d.max_members, ttl_hours: 24 * 14 })).url;
      openDialog(`Invite people to ${d.name}`, h("p", {}, `${d.people} of ${d.max_members} places taken. Everyone signs in with Google or email.`), inviteSteps(url, d.name));
      if (!liveInvite) loadSession();
    } catch (err) {
      toast(err.message);
    }
  };
  const remove = async () => {
    const dlg = openDialog(
      `Delete "${d.name}"?`,
      h("p", {}, "This deletes the session for everyone. Its people lose access to each other and to your agents at once, their apps are told, and the invite link stops working. Messages stay in Activity."),
      h(
        "div",
        { class: "dialog-actions" },
        h("button", { class: "btn secondary", type: "button", onclick: () => dlg.close() }, "Keep it"),
        h(
          "button",
          {
            class: "btn danger",
            type: "button",
            onclick: async () => {
              try {
                await api("DELETE", `/v1/admin/sessions/${encodeURIComponent(d.id)}`);
                dlg.close();
                toast(`"${d.name}" was deleted for everyone`);
                await loadSessions();
                go("sessions");
              } catch (err) {
                toast(err.message);
              }
            },
          },
          "Delete for everyone",
        ),
      ),
    );
  };
  const briefBox = h("textarea", { class: "input brief-input", rows: 7, maxlength: 8000, placeholder: "What this session is for, who owns what, decisions so far. Agents read it when they join, and can update it." }, d.brief ?? "");
  const sizeBox = h("input", { class: "input size-input", type: "number", min: 2, max: S.maxMembers, value: d.max_members, "aria-label": "Maximum people" });
  const save = async (patch, msg) => {
    try {
      await api("PATCH", `/v1/admin/sessions/${encodeURIComponent(d.id)}`, patch);
      toast(msg);
      loadSession();
      loadSessions().then(renderSide);
    } catch (err) {
      toast(err.message);
    }
  };

  const details = S.detailsOpen
    ? h(
        "aside",
        { class: "details", "aria-label": "Session details" },
        h(
          "section",
          {},
          h("div", { class: "sec-h" }, h("h3", {}, "Brief"), d.brief_updated_at ? h("span", { class: "muted small" }, `Updated ${ago(d.brief_updated_at)}${d.brief_updated_by && d.brief_updated_by !== "admin" ? ` by ${nameOf(d.brief_updated_by)}` : ""}`) : null),
          briefBox,
          h("div", { class: "row" }, h("button", { class: "btn secondary small", onclick: () => save({ brief: briefBox.value }, "Brief saved. Every agent in the session sees it.") }, "Save brief")),
        ),
        h(
          "section",
          {},
          h("div", { class: "sec-h" }, h("h3", {}, "People"), h("span", { class: "muted small" }, `${guestPeople} of ${d.max_members}`)),
          h(
            "ul",
            { class: "people" },
            people.map((p) =>
              h(
                "li",
                { class: "person" },
                h(
                  "div",
                  { class: "person-top" },
                  avatar(p.agents[0].address),
                  h("div", { class: "person-text" }, h("b", {}, p.name), p.email ? h("span", { class: "muted small" }, p.email) : null),
                  p.role === "guest"
                    ? h("button", {
                        class: "icon-btn",
                        title: "Remove from this session",
                        "aria-label": `Remove ${p.name}`,
                        html: ICONS.x,
                        onclick: async () => {
                          if (!confirm(`Remove ${p.name} and all their agents from "${d.name}"?`)) return;
                          await api("DELETE", `/v1/admin/sessions/${encodeURIComponent(d.id)}/members/${encodeURIComponent(p.agents[0].address)}`);
                          toast(`${p.name} was removed`);
                          loadSession();
                        },
                      })
                    : h("span", { class: "muted small" }, "you"),
                ),
                h(
                  "div",
                  { class: "apps" },
                  p.agents.map((a) => h("span", { class: "app-chip", title: a.address }, h("span", { class: `lamp ${a.online ? "on" : ""}` }), appOf(a) ?? short(a.address))),
                ),
              ),
            ),
          ),
          h("button", { class: "btn secondary small", onclick: invite }, "Invite people"),
        ),
        h(
          "section",
          {},
          h("h3", {}, "Size"),
          h("div", { class: "row" }, sizeBox, h("button", { class: "btn secondary small", onclick: () => save({ max_members: Number(sizeBox.value) }, "Size updated") }, "Save")),
          h("p", { class: "muted small" }, `How many people can join, up to ${S.maxMembers}, not counting you. Each person can connect several apps; they count once.`),
        ),
        h("section", {}, h("button", { class: "btn ghost-danger small", onclick: remove }, "Delete session for everyone")),
      )
    : null;

  let main;
  if (!guests.length) {
    main = h(
      "div",
      { class: "chat-scroll" },
      h(
        "div",
        { class: "chat-empty" },
        h(
          "div",
          { class: "waiting-card" },
          h("h2", {}, `Bring people into ${d.name}`),
          h("p", {}, "Send them this prompt. They paste it into their AI agent, sign in once, and their apps join. The session opens as soon as the first agent arrives."),
          liveInvite ? inviteSteps(liveInvite.url, d.name) : h("button", { class: "btn", onclick: invite, style: "justify-self:center" }, "Create an invite"),
        ),
      ),
    );
  } else {
    setTimeout(() => {
      const sc = document.getElementById("tl-scroll");
      if (sc) sc.scrollTop = sc.scrollHeight;
    });
    main = h(
      "section",
      { class: "chat-col", "aria-label": `Conversation in ${d.name}` },
      h("div", { class: "chat-scroll", id: "tl-scroll" }, h("div", { class: "log tl", "aria-live": "polite" }, timeline(d.messages, me))),
      h(
        "div",
        { class: "dock" },
        composer({
          to: S.talk.to,
          pickTo: guests,
          placeholder: `Message ${nameOf(S.talk.to)}…`,
          onSend: async () => {
            await sendTalk();
            loadSession();
          },
          autofocus: true,
        }),
      ),
    );
  }

  return {
    title: [h("span", {}, d.name), h("span", { class: "topbar-sub" }, `${guestPeople} ${guestPeople === 1 ? "person" : "people"}${guests.some((g) => g.online) ? " · live" : ""}`)],
    actions: [
      h("button", { class: "btn secondary small", onclick: invite }, "Invite"),
      h("button", { class: "icon-btn", "aria-label": "Session details", "aria-pressed": S.detailsOpen ? "true" : "false", title: "Details", html: ICONS.panel, onclick: () => ((S.detailsOpen = !S.detailsOpen), renderView()) }),
    ],
    body: h("div", { class: "chat" }, main, details),
  };
}

// ------------------------------------------------------------------ shared with you

/** Sessions other people invited you into: read-only, through your own sign-in. */
async function loadShared() {
  try {
    S.shared = (await api("GET", "/api/shared")).sessions;
  } catch {
    S.shared = [];
  }
}

async function openShared(slug, id) {
  S.sharedKey = { slug, id };
  S.sharedData = null;
  S.view = "shared";
  toggleSide(false);
  try {
    history.replaceState(null, "", `/app/${S.ws}/shared/${slug}/${id}`);
  } catch {
    /* sandboxed */
  }
  renderShell();
  await loadSharedSession();
}

async function loadSharedSession() {
  if (!S.sharedKey) return;
  try {
    S.sharedData = await api("GET", `/api/shared/${S.sharedKey.slug}/sessions/${encodeURIComponent(S.sharedKey.id)}`);
  } catch {
    S.sharedData = { error: true };
  }
  if (S.view === "shared") renderView();
}

function viewShared() {
  const d = S.sharedData;
  if (!d) return { title: h("span", {}, "Shared session"), body: h("div", { class: "chat-empty" }, h("p", {}, "Loading…")) };
  if (d.error) return { title: h("span", {}, "Shared session"), body: h("div", { class: "chat-empty" }, h("h2", {}, "This session isn't available"), h("p", {}, "Its owner may have deleted it, or removed you.")) };
  // Names come from the session itself: the guest's own workspace doesn't know these agents.
  const ownerName = "Session owner";
  const members = d.members.map((m) => (m.address.endsWith("/console") ? { ...m, person: ownerName, display_name: ownerName } : m));
  const names = new Map(members.map((m) => [m.address, m.display_name || short(m.address)]));
  const people = peopleOf(members, null);
  const leave = async () => {
    if (!confirm(`Leave "${d.name}"? Your agents stop reaching the people in it.`)) return;
    try {
      await api("POST", `/api/shared/${S.sharedKey.slug}/sessions/${encodeURIComponent(S.sharedKey.id)}/leave`);
      toast(`You left "${d.name}"`);
      await loadShared();
      go("sessions");
    } catch (err) {
      toast(err.message);
    }
  };
  return {
    title: [h("span", {}, d.name), h("span", { class: "topbar-sub" }, `${d.workspace.name} · shared with you`)],
    actions: [h("button", { class: "btn secondary small", onclick: loadSharedSession }, "Refresh")],
    body: h(
      "div",
      { class: "chat" },
      h("section", { class: "chat-col" }, h("div", { class: "chat-scroll" }, h("div", { class: "log tl" }, timeline(d.messages, null, names)))),
      h(
        "aside",
        { class: "details", "aria-label": "Session details" },
        h("section", {}, h("h3", {}, "Brief"), d.brief ? h("div", { class: "brief-read" }, d.brief) : h("p", { class: "muted small" }, "No brief yet. Your agent can write one with update_session_brief.")),
        h(
          "section",
          {},
          h("div", { class: "sec-h" }, h("h3", {}, "People"), h("span", { class: "muted small" }, `${d.people} of ${d.max_members}`)),
          h(
            "ul",
            { class: "people" },
            people.map((p) =>
              h(
                "li",
                { class: "person" },
                h("div", { class: "person-top" }, avatar(p.agents[0].address), h("div", { class: "person-text" }, h("b", {}, p.name), h("span", { class: "muted small" }, p.role === "owner" ? "owner" : ""))),
                h("div", { class: "apps" }, p.agents.map((a) => h("span", { class: "app-chip", title: a.address }, h("span", { class: `lamp ${a.online ? "on" : ""}` }), appOf(a) ?? short(a.address)))),
              ),
            ),
          ),
        ),
        h("section", {}, h("p", { class: "muted small" }, "Talk to this session from your AI agent: \"ask <name> ...\" or \"list my A2A sessions\"."), h("button", { class: "btn ghost-danger small", onclick: leave }, "Leave session")),
      ),
    ),
  };
}

// ------------------------------------------------------------------ settings

function viewSettings() {
  const ws = S.workspaces.find((w) => w.slug === S.ws);
  const name = h("input", { class: "input", value: ws?.name ?? "", maxlength: 60 });
  const r = S.overview?.relay ?? {};
  return h(
    "div",
    {},
    pageHead("Settings", "Your workspace and account."),
    h(
      "div",
      { class: "settings" },
      h(
        "form",
        {
          class: "panel panel-pad",
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const res = await api("PATCH", "/v1/admin/workspace", { name: name.value });
              ws.name = res.name;
              toast("Workspace renamed");
              renderShell();
            } catch (err) {
              toast(err.message);
            }
          },
        },
        h("h2", { class: "side-title" }, "Workspace"),
        h("label", { class: "field" }, h("span", {}, "Name"), name),
        h(
          "dl",
          { class: "kv" },
          h("dt", {}, "Agent addresses"),
          h("dd", { class: "mono" }, `agent://${r.org ?? ws?.slug}/<name>`),
          h("dt", {}, "Relay address"),
          h("dd", { class: "mono" }, r.url ?? ""),
          h("dt", {}, "Voice"),
          h("dd", {}, r.voice?.reson8 ? "Reson8 speech-to-text" : "Your browser's speech recognition"),
        ),
        h("div", { class: "row" }, h("button", { class: "btn", type: "submit" }, "Save")),
      ),
      h(
        "section",
        { class: "panel panel-pad" },
        h("h2", { class: "side-title" }, "Account"),
        h("dl", { class: "kv" }, h("dt", {}, "Name"), h("dd", {}, S.me?.name ?? ""), h("dt", {}, "Email"), h("dd", {}, S.me?.email ?? "")),
        h("div", { class: "row" }, h("button", { class: "btn secondary", onclick: signOut }, "Sign out")),
      ),
    ),
  );
}

// ------------------------------------------------------------------ start

async function boot() {
  try {
    const saved = localStorage.getItem("a2a-theme");
    if (saved) document.documentElement.dataset.theme = saved;
  } catch {
    /* storage blocked */
  }
  S.detailsOpen = innerWidth > 1180;
  document.getElementById("app").replaceChildren(h("main", { class: "login" }, h("div", { class: "boot" }, h("span", { html: LOGO_MARK }), "Opening your workspace…")));
  const res = await fetch("/api/me");
  if (res.status === 401) {
    location.href = `/signin?next=${encodeURIComponent(location.pathname)}`;
    return;
  }
  const me = await res.json();
  S.me = me.user;
  S.workspaces = me.workspaces;
  const [, slug, view, id] = location.pathname.split("/").filter(Boolean);
  let remembered = null;
  try {
    remembered = localStorage.getItem("a2a-ws");
  } catch {
    /* storage blocked */
  }
  S.ws = (S.workspaces.find((w) => w.slug === slug) ?? S.workspaces.find((w) => w.slug === remembered) ?? S.workspaces[0])?.slug;
  if (!S.ws) {
    document.getElementById("app").replaceChildren(h("main", { class: "login" }, h("div", { class: "empty" }, h("strong", {}, "No workspace yet"), "Sign out and back in to create one.")));
    return;
  }
  if (view === "s" && id) {
    S.view = "session";
    S.session = id;
  } else if (VIEW_NAMES.includes(view)) S.view = view;
  const [, , , sharedSlug, sharedId] = location.pathname.split("/").filter(Boolean);
  if (view === "shared" && sharedSlug && sharedId) S.sharedKey = { slug: sharedSlug, id: sharedId };
  await Promise.all([refresh(), loadSessions(), loadShared(), fetch("/downloads/latest.json").then((r) => (r.ok ? r.json() : null)).then((c) => (S.cli = c)).catch(() => {})]);
  if (S.view === "talk" && id) S.talk.to = talkable().find((a) => short(a.address) === decodeURIComponent(id))?.address ?? null;
  renderShell(); // both loads are in: draw with sessions included
  if (S.view === "session") await loadSession();
  if (S.view === "shared") await loadSharedSession();
  connectEvents();
  watchDevice();
}

boot();
