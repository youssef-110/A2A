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
  talk: { to: null, thread: {}, log: {}, waiting: {}, draft: "", heard: "", readAloud: true, autoSend: true, listening: false },
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
const VIEW_NAMES = ["sessions", "session", "talk", "traffic", "agents", "review", "policy", "settings", "audit"];
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
      h("div", { class: "side-list" }, sideList()),
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
    const tail = view === "sessions" ? "" : view === "session" ? `/s/${S.session}` : view === "talk" && S.talk.to ? `/talk/${encodeURIComponent(short(S.talk.to))}` : `/${view}`;
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

// ------------------------------------------------------------------ traffic

const FILTERS = [
  ["all", "All"],
  ["delivered", "Delivered"],
  ["queued", "Waiting"],
  ["held", "Held"],
  ["blocked", "Blocked"],
];
const matches = (m) => S.filter === "all" || m.state === S.filter || (S.filter === "queued" && m.state === "screening") || (S.filter === "blocked" && m.state === "rejected");

function msgRow(m, onclick) {
  return h(
    "button",
    { class: "msg", "aria-selected": S.selected === m.id ? "true" : "false", onclick },
    h("span", { class: "msg-route" }, who(m.from), h("span", { class: "route", "aria-label": "to", html: ICONS.arrow }), who(m.to)),
    h("span", { class: "msg-time" }, timeEl(m.received_at)),
    h("span", { class: "msg-preview" }, m.preview || "(empty)"),
    h("span", { class: "msg-meta" }, pill(m.state), m.reason_code ? h("span", { class: "muted mono" }, m.reason_code) : null, m.redacted ? h("span", { class: "pill redacted" }, "redacted") : null),
  );
}

function viewTraffic() {
  const list = S.messages.filter(matches);
  return h(
    "div",
    {},
    pageHead("Activity", "Every message through the relay, newest first, with what the guard decided."),
    h(
      "div",
      { class: "filters", role: "group", "aria-label": "Filter by state" },
      FILTERS.map(([key, label]) => h("button", { class: "chip", "aria-pressed": S.filter === key ? "true" : "false", onclick: () => ((S.filter = key), renderView()) }, label)),
    ),
    h(
      "div",
      { class: "traffic" },
      h(
        "div",
        { class: "panel feed" },
        list.length ? list.map((m) => msgRow(m, () => select(m.id))) : h("div", { class: "empty" }, h("strong", {}, "Nothing here"), "Messages show up as soon as an agent sends one."),
      ),
      h("aside", { class: "panel panel-pad detail", id: "detail" }, detailView()),
    ),
  );
}

async function select(id) {
  S.selected = id;
  renderView();
  await loadDetail();
}

async function loadDetail() {
  if (!S.selected) return;
  try {
    S.detail = await api("GET", `/v1/admin/messages/${encodeURIComponent(S.selected)}`);
    S.thread = await api("GET", `/v1/admin/threads/${encodeURIComponent(S.detail.thread_id)}`);
  } catch (e) {
    toast(e.message);
  }
  const box = document.getElementById("detail");
  if (box) box.replaceChildren(detailView());
}

function detailView() {
  const d = S.detail;
  if (!d || d.id !== S.selected) return h("div", { class: "empty" }, h("strong", {}, "Pick a message"), "You'll see the full text, each guard stage and the rest of the thread.");
  return h(
    "div",
    {},
    h("h2", {}, `${nameOf(d.from)} to ${nameOf(d.to)}`),
    h("div", { class: "row" }, pill(d.state), d.reason_code ? h("span", { class: "mono muted" }, d.reason_code) : null),
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, "From"),
      h("dd", { class: "mono" }, d.from),
      h("dt", {}, "To"),
      h("dd", { class: "mono" }, d.to),
      h("dt", {}, "Scope"),
      h("dd", {}, d.scope),
      h("dt", {}, "Sent"),
      h("dd", {}, new Date(d.created_at).toLocaleString()),
      d.reason ? [h("dt", {}, "Why"), h("dd", {}, d.reason)] : null,
    ),
    h("div", { class: "quote" }, redactedText(d.delivered_text ?? d.original_text)),
    d.delivered_text && d.delivered_text !== d.original_text ? h("p", { class: "muted" }, "The guard changed this text before delivery.") : null,
    h("h3", { class: "section-title" }, "Guard stages"),
    pipeline(d.stages),
    d.state === "held" ? reviewButtons(d.id) : null,
    S.thread
      ? [
          h("h3", { class: "section-title" }, `Thread (${S.thread.messages.length})`),
          h(
            "div",
            { class: "thread" },
            S.thread.messages.map((m) =>
              h(
                "div",
                {},
                h("div", { class: "row" }, h("b", {}, nameOf(m.from)), pill(m.state), h("span", { class: "muted" }, timeEl(m.received_at))),
                h("div", { class: "quote" }, redactedText(m.text ?? m.preview)),
              ),
            ),
          ),
        ]
      : null,
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
    "aria-label": S.talk.listening ? "Stop listening" : "Talk instead of typing",
    title: S.talk.listening ? "Stop listening" : "Talk instead of typing",
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
      h("label", {}, h("input", { type: "checkbox", checked: S.talk.readAloud, onchange: (e) => (S.talk.readAloud = e.target.checked) }), "Read replies aloud"),
      h("label", {}, h("input", { type: "checkbox", checked: S.talk.autoSend, onchange: (e) => (S.talk.autoSend = e.target.checked) }), "Send when I stop talking"),
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
      h("p", {}, "Type or press the microphone and talk. Everything goes through your relay and its guard, like any other message."),
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

function speak(text) {
  if (!S.talk.readAloud || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text.slice(0, 1200));
  Voice.mute(true);
  u.onend = u.onerror = () => Voice.mute(false);
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
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
          b.setAttribute("aria-label", on ? "Stop listening" : "Talk instead of typing");
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
  muted: false,
  mute(on) {
    this.muted = on;
  },
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
    this.session = token?.access_token ? await reson8Session(token.access_token, cb, this) : browserSession(cb, this);
  },
};

const WORKLET = `class A2APcm extends AudioWorkletProcessor { process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; } } registerProcessor("a2a-pcm", A2APcm);`;

async function reson8Session(accessToken, cb, voice) {
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
    if (ws.readyState !== WebSocket.OPEN || voice.muted) return;
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

function browserSession(cb, voice) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error("Voice needs a Reson8 key on the relay (RESON8_API_KEY) or a browser with speech recognition, like Chrome or Edge.");
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";
  let stopped = false;
  rec.onresult = (e) => {
    if (voice.muted) return;
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
    pageHead("Agents", "Everyone registered on this relay. Approve people who joined without an invite, or disable an agent to cut it off at once."),
    h(
      "div",
      { class: "panel table-wrap" },
      h(
        "table",
        { class: "table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Agent"), h("th", {}, "Status"), h("th", {}, "Last seen"), h("th", {}, "Machine"), h("th", {}, h("span", { class: "sr-only" }, "Actions")))),
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
    pageHead("Review", "Messages the guard held for a person to look at. With the default open policy this stays empty."),
    held.length
      ? h(
          "div",
          { class: "traffic" },
          h(
            "div",
            { class: "panel feed" },
            held.map((m) => msgRow(m, () => select(m.id))),
          ),
          h("aside", { class: "panel panel-pad detail", id: "detail" }, detailView()),
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
    if (S.selected === m.id && S.view === "traffic") loadDetail();
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
      speak(m.text ?? m.preview ?? "");
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

const PLUGIN_INSTALL = "/plugin install a2a --marketplace youssef-110/A2A";

/** What to send someone so their agent can join: works whether or not they use Claude Code. */
function inviteSteps(url) {
  return h(
    "div",
    { class: "steps" },
    h("div", { class: "step" }, h("span", { class: "step-n" }, "1"), h("div", {}, h("b", {}, "In Claude Code, install the plug-in"), copyLine(PLUGIN_INSTALL))),
    h("div", { class: "step" }, h("span", { class: "step-n" }, "2"), h("div", {}, h("b", {}, "Then tell Claude"), copyLine(`Join A2A with ${url}`))),
    h("p", { class: "muted small" }, "No Claude Code? The link opens a page with steps for the terminal, Codex and the SDK."),
  );
}

function inviteMessage(url, who) {
  return `${who ? `Hi ${who}! ` : ""}Here's a private A2A session so our agents can talk.\n\nIn Claude Code: ${PLUGIN_INSTALL}\nThen tell Claude: "Join A2A with ${url}"\n\nOther setups: ${url}`;
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
          mine.length ? null : h("button", { type: "button", onclick: connectAgentDialog }, h("span", { html: ICONS.invites }), "Connect your agent"),
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
  const name = h("input", { class: "input", placeholder: "David", maxlength: 80, required: true, autocomplete: "off" });
  const body = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const s = await api("POST", "/v1/admin/sessions", { name: name.value });
          await loadSessions();
          renderSide();
          body.replaceChildren(
            h("p", {}, `Send this link to ${s.name}. It works once and expires in 7 days.`),
            copyLine(s.invite.url, "Copy link"),
            inviteSteps(s.invite.url),
            h(
              "div",
              { class: "dialog-actions" },
              h("button", { class: "btn secondary", type: "button", onclick: () => copy(inviteMessage(s.invite.url, s.name), "Message copied") }, "Copy a ready-to-send message"),
              h("button", { class: "btn", type: "button", onclick: () => (dlg.close(), openSession(s.id)) }, "Open session"),
            ),
          );
        } catch (err) {
          toast(err.message);
        }
      },
    },
    h("label", { class: "field" }, h("span", {}, "Who is this session for?"), name),
    h("p", { class: "muted small", style: "margin-top:10px" }, "Their agent can only talk to your agents, never to people in your other sessions."),
    h("div", { class: "dialog-actions", style: "margin-top:18px" }, h("button", { class: "btn", type: "submit" }, "Create session and link")),
  );
  const dlg = openDialog("New session", body);
  name.focus();
}

async function connectAgentDialog() {
  try {
    const inv = await api("POST", "/v1/admin/invites", { owner: true, note: "My agent", max_uses: 3, ttl_hours: 72 });
    openDialog(
      "Connect your agent",
      h("p", {}, "Your agent joins as you and can reach everyone in your sessions. The easiest way is the desktop app: sign in and this computer connects on its own."),
      window.a2aDesktop
        ? null
        : h(
            "div",
            { class: "row" },
            h("a", { class: "btn", href: "/download/windows" }, h("span", { html: ICONS.download }), "Download for Windows"),
            h("a", { class: "btn secondary", href: "/docs#desktop", target: "_blank" }, "Mac and Linux"),
          ),
      h("p", { class: "muted small" }, "Or connect Claude Code directly. The link works on up to three of your machines for 3 days."),
      inviteSteps(inv.url),
      h(
        "details",
        { class: "more" },
        h("summary", {}, "Terminal, Codex or the SDK"),
        copyLine(`node a2a.mjs join ${inv.url}`),
        h("p", { class: "muted small" }, h("a", { href: "/docs#install" }, "Download a2a.mjs and the SDK")),
      ),
    );
  } catch (err) {
    toast(err.message);
  }
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
    if (!guests.some((g) => g.address === S.talk.to)) S.talk.to = guests[0]?.address ?? null;
  } catch (e) {
    toast(e.message);
    S.sessionData = { error: true };
  }
  if (S.view === "session") renderView();
}

function viewSession() {
  const d = S.sessionData;
  const listed = S.sessions.find((s) => s.id === S.session);
  if (!d) return { title: h("span", {}, listed?.name ?? "Session"), body: h("div", { class: "chat-empty" }, h("p", {}, "Loading the session…")) };
  if (d.error) return { title: h("span", {}, "Session"), body: h("div", { class: "chat-empty" }, h("h2", {}, "This session isn't available"), h("p", {}, "It may have been archived.")) };
  const guests = d.members.filter((m) => m.role === "guest");
  const liveInvite = d.invites.find((i) => i.valid);
  const me = S.overview?.relay?.console_address;
  const archive = async () => {
    if (!confirm(`Archive "${d.name}"? Its guests lose access to your agents. Messages stay in Activity.`)) return;
    await api("DELETE", `/v1/admin/sessions/${encodeURIComponent(d.id)}`);
    toast("Session archived");
    await loadSessions();
    go("sessions");
  };
  const newInvite = async () => {
    try {
      const inv = await api("POST", `/v1/admin/sessions/${encodeURIComponent(d.id)}/invites`, { note: d.name });
      openDialog("New invite link", copyLine(inv.url, "Copy link"), inviteSteps(inv.url));
      loadSession();
    } catch (err) {
      toast(err.message);
    }
  };
  const toggleDetails = () => {
    S.detailsOpen = !S.detailsOpen;
    renderView();
  };
  const between = d.messages.filter((m) => m.from !== me && m.to !== me);

  const details = S.detailsOpen
    ? h(
        "aside",
        { class: "details", "aria-label": "Session details" },
        h(
          "section",
          {},
          h("h3", {}, "People"),
          h(
            "ul",
            { class: "people" },
            d.members
              .filter((m) => m.address !== me)
              .map((m) =>
                h(
                  "li",
                  {},
                  who(m.address),
                  h("span", { class: `lamp ${m.online ? "on" : ""}`, title: m.online ? "online" : "offline" }),
                  m.role === "guest"
                    ? h("button", {
                        class: "icon-btn",
                        title: "Remove from this session",
                        "aria-label": `Remove ${m.display_name || short(m.address)}`,
                        html: ICONS.x,
                        onclick: async () => {
                          await api("DELETE", `/v1/admin/sessions/${encodeURIComponent(d.id)}/members/${encodeURIComponent(m.address)}`);
                          toast("Removed from the session");
                          loadSession();
                        },
                      })
                    : h("span", { class: "muted small" }, "you"),
                ),
              ),
          ),
        ),
        h(
          "section",
          {},
          h("h3", {}, "Between the agents"),
          between.length
            ? h(
                "ul",
                { class: "a2a-feed" },
                between
                  .slice(-12)
                  .map((m) =>
                    h(
                      "li",
                      {},
                      h("div", { class: "a2a-route" }, h("b", {}, nameOf(m.from)), h("span", { class: "muted" }, " to "), h("b", {}, nameOf(m.to)), pill(m.state)),
                      h("p", {}, m.preview),
                      h("span", { class: "muted small" }, ago(m.received_at)),
                    ),
                  ),
              )
            : h("p", { class: "muted small" }, "When your agent and theirs talk, it shows up here."),
        ),
        h("section", {}, h("h3", {}, "Invite"), liveInvite ? copyLine(liveInvite.url, "Copy") : h("button", { class: "btn secondary small", onclick: newInvite }, "Create a new link")),
        h("section", {}, h("button", { class: "btn ghost-danger small", onclick: archive }, "Archive session")),
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
          h("h2", {}, `Waiting for ${d.name}`),
          liveInvite ? h("p", {}, "Send them this link. The session opens as soon as their agent joins.") : h("p", {}, "The last link was used or expired."),
          liveInvite ? [copyLine(liveInvite.url, "Copy link"), inviteSteps(liveInvite.url)] : h("button", { class: "btn", onclick: newInvite, style: "justify-self:center" }, "Create a new link"),
        ),
      ),
    );
  } else {
    main = conversation(S.talk.to);
    if (guests.length > 1) {
      main.prepend(
        h(
          "div",
          { class: "chat-tabs" },
          h(
            "div",
            { class: "seg", role: "tablist" },
            guests.map((g) =>
              h("button", { role: "tab", "aria-selected": S.talk.to === g.address ? "true" : "false", onclick: () => ((S.talk.to = g.address), renderView()) }, g.display_name || short(g.address)),
            ),
          ),
        ),
      );
      main.style.gridTemplateRows = "auto minmax(0, 1fr) auto";
    }
  }

  return {
    title: [h("span", {}, d.name), guests.length ? h("span", { class: "topbar-sub" }, `with ${guests.map((g) => g.display_name || short(g.address)).join(", ")}`) : null],
    actions: [
      h("button", { class: "btn secondary small", onclick: newInvite }, "Invite link"),
      h("button", { class: "icon-btn", "aria-label": "Session details", "aria-pressed": S.detailsOpen ? "true" : "false", title: "Details", html: ICONS.panel, onclick: toggleDetails }),
    ],
    body: h("div", { class: "chat" }, main, details),
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
  await Promise.all([refresh(), loadSessions()]);
  if (S.view === "talk" && id) S.talk.to = talkable().find((a) => short(a.address) === decodeURIComponent(id))?.address ?? null;
  renderShell(); // both loads are in: draw with sessions included
  if (S.view === "session") await loadSession();
  connectEvents();
  watchDevice();
}

boot();
