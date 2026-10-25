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
  unreadTalk: 0,
  talk: { to: null, thread: {}, log: {}, draft: "", heard: "", readAloud: true, autoSend: true, listening: false },
};

// ------------------------------------------------------------------ helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v; // only ever used with the static ICONS below
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
  board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/></svg>',
  talk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
  traffic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>',
  invites: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  agents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  policy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>',
  sessions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>',
  scissors: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
};

const LOGO_MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M10.5 21.5c2.6-7.2 8.4-3.8 11-11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".55"/><circle cx="9" cy="22" r="5" fill="currentColor"/><circle cx="23" cy="10" r="5" fill="#5266eb"/></svg>';
const brandMark = () =>
  h("span", {
    class: "brand-mark",
    html: LOGO_MARK,
  });

// A stable, low-key color per agent so a busy list is easy to scan.
const AV = [["#e2e8fb", "#2f4fd0"], ["#e2f1e8", "#1b774b"], ["#f6e9dc", "#8a4a12"], ["#ede7fa", "#6645bd"], ["#e1eff2", "#1d6b7a"], ["#f7e3ea", "#a3324f"], ["#ececdf", "#5f5a1d"]];
const AV_DARK = [["#232c4a", "#9fb1ff"], ["#1b3328", "#7fd8a8"], ["#3a2a1b", "#f0b98a"], ["#2c2445", "#c6b4f7"], ["#173238", "#7fd0de"], ["#3a1f29", "#f29bb2"], ["#2f2e1c", "#d9d48a"]];
function initials(address) {
  return (nameOf(address) || short(address)).replace(/^guest-/, "").slice(0, 2);
}
function avatar(address) {
  let hash = 0;
  for (const c of address ?? "") hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const dark = document.documentElement.dataset.theme !== "light";
  const [bg, ink] = (dark ? AV_DARK : AV)[hash % AV.length];
  return h("span", { class: "mono-av", style: `--av-bg:${bg};--av-ink:${ink}`, "aria-hidden": "true" }, initials(address));
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
  ["sessions", "Sessions"],
  ["talk", "Talk"],
  ["traffic", "Activity"],
  ["agents", "Agents"],
  ["review", "Review"],
  ["policy", "Policy"],
  ["settings", "Settings"],
  ["audit", "Audit log"],
];

function navCount(view) {
  if (view === "review") return S.overview?.stats?.held || 0;
  if (view === "agents") return S.agents.filter((a) => a.status === "pending").length;
  if (view === "talk") return S.unreadTalk;
  return 0;
}

function renderShell() {
  const ws = S.workspaces.find((w) => w.slug === S.ws);
  const rail = h(
    "nav",
    { class: "rail", "aria-label": "Dashboard" },
    h("a", { class: "brand", href: "/" }, brandMark(), h("span", { class: "brand-name" }, "a2a")),
    workspaceSwitcher(ws),
    NAV.map(([view, label]) => {
      const n = navCount(view);
      return h(
        "button",
        { class: "nav-btn", "aria-current": S.view === view || (view === "sessions" && S.view === "session") ? "page" : false, onclick: () => go(view) },
        h("span", { html: ICONS[view] }),
        h("span", { class: "label" }, label),
        n ? h("span", { class: "nav-count", "aria-label": `${n} waiting` }, n) : null,
      );
    }),
    h(
      "div",
      { class: "rail-foot" },
      h("div", { class: "conn" }, h("span", { class: `lamp ${S.connected ? "on" : ""}` }), S.connected ? "Live updates on" : "Reconnecting…"),
      userBlock(),
    ),
  );
  const main = h("main", { class: "main", id: "main" });
  document.getElementById("app").replaceChildren(h("div", { class: "shell" }, rail, main));
  renderView();
}

function toggleTheme() {
  const root = document.documentElement;
  // Dark is the default; light is opt-in.
  root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
  try {
    localStorage.setItem("a2a-theme", root.dataset.theme);
  } catch {
    /* storage blocked */
  }
}

function go(view) {
  if (S.view === "talk" && view !== "talk") Voice.stop();
  S.view = view;
  if (view === "talk") S.unreadTalk = 0;
  try {
    history.replaceState(null, "", `/app/${S.ws}${view === "sessions" ? "" : `/${view === "session" ? `s/${S.session}` : view}`}`);
  } catch {
    /* sandboxed */
  }
  renderShell();
}

function pageHead(title, text, ...actions) {
  return h("header", { class: "page-head" }, h("div", {}, h("h1", {}, title), text ? h("p", {}, text) : null), actions.length ? h("div", { class: "row" }, actions) : null);
}

function renderView() {
  const main = document.getElementById("main");
  if (!main) return;
  const views = { sessions: viewSessions, session: viewSession, talk: viewTalk, traffic: viewTraffic, agents: viewAgents, review: viewReview, policy: viewPolicy, settings: viewSettings, audit: viewAudit };
  main.replaceChildren(views[S.view]?.() ?? viewSessions());
}

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
    pageHead("Traffic", "Every message through the relay, newest first, with what the guard decided."),
    h(
      "div",
      { class: "filters", role: "group", "aria-label": "Filter by state" },
      FILTERS.map(([key, label]) => h("button", { class: "chip", "aria-pressed": S.filter === key ? "true" : "false", onclick: () => ((S.filter = key), renderView()) }, label)),
    ),
    h(
      "div",
      { class: "traffic" },
      h("div", { class: "panel feed" }, list.length ? list.map((m) => msgRow(m, () => select(m.id))) : h("div", { class: "empty" }, h("strong", {}, "Nothing here"), "Messages show up as soon as an agent sends one.")),
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
      h("dt", {}, "From"), h("dd", { class: "mono" }, d.from),
      h("dt", {}, "To"), h("dd", { class: "mono" }, d.to),
      h("dt", {}, "Scope"), h("dd", {}, d.scope),
      h("dt", {}, "Sent"), h("dd", {}, new Date(d.created_at).toLocaleString()),
      d.reason ? [h("dt", {}, "Why"), h("dd", {}, d.reason)] : null,
    ),
    h("div", { class: "quote" }, redactedText(d.delivered_text ?? d.original_text)),
    d.delivered_text && d.delivered_text !== d.original_text ? h("p", { class: "muted" }, "The guard changed this text before delivery.") : null,
    h("h3", { class: "section-title" }, "Guard stages"),
    pipeline(d.stages),
    d.state === "held" ? reviewButtons(d.id) : null,
    S.thread ? [h("h3", { class: "section-title" }, `Thread (${S.thread.messages.length})`), h("div", { class: "thread" }, S.thread.messages.map((m) => h("div", {}, h("div", { class: "row" }, h("b", {}, nameOf(m.from)), pill(m.state), h("span", { class: "muted" }, timeEl(m.received_at))), h("div", { class: "quote" }, redactedText(m.text ?? m.preview)))))] : null,
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
  return h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn", onclick: () => act("release") }, "Release"), h("button", { class: "btn danger", onclick: () => act("reject") }, "Reject"));
}

// ------------------------------------------------------------------ talk (voice + text desk)

function talkable() {
  const me = S.overview?.relay?.console_address;
  return S.agents.filter((a) => a.address !== me && a.status === "active").sort((a, b) => Number(b.online) - Number(a.online) || a.address.localeCompare(b.address));
}

function viewTalk() {
  const people = talkable();
  if (!S.talk.to && people.length) S.talk.to = people[0].address;
  if (!people.length) {
    return h("div", {}, pageHead("Talk", "Speak or type to any agent on the relay. Replies are read back to you."), h("div", { class: "panel empty" }, h("strong", {}, "No one to talk to yet"), "Invite someone first. Their agent appears here once they join.", h("div", { style: "margin-top:14px" }, h("button", { class: "btn", onclick: () => go("invites") }, "Create an invite"))));
  }
  const list = h(
    "div",
    { class: "panel callees", role: "listbox", "aria-label": "Agents" },
    people.map((a) =>
      h(
        "button",
        { class: "callee", role: "option", "aria-selected": S.talk.to === a.address ? "true" : "false", onclick: () => openCall(a.address) },
        h("span", { class: `lamp ${a.online ? "on" : ""}` }),
        h("span", {}, h("span", { class: "callee-name" }, a.display_name || short(a.address)), h("small", { class: "mono" }, a.address)),
      ),
    ),
  );
  setTimeout(() => loadCall(S.talk.to), 0);
  return h("div", {}, pageHead("Talk", "Speak or type to any agent on the relay. Hold a conversation hands-free: replies are read back, then it listens again."), h("div", { class: "talk" }, list, callPanel()));
}

function openCall(address) {
  if (S.talk.to === address) return;
  Voice.stop();
  S.talk.to = address;
  S.talk.draft = "";
  renderView();
}

function callPanel() {
  const to = S.talk.to;
  const agent = S.agents.find((a) => a.address === to);
  const draft = h("textarea", {
    class: "textarea",
    id: "draft",
    rows: 2,
    placeholder: `Message ${agent?.display_name || short(to)}…`,
    "aria-label": "Message",
    oninput: (e) => (S.talk.draft = e.target.value),
    onkeydown: (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendTalk();
      }
    },
  });
  draft.value = S.talk.draft;
  const ptt = h("button", {
    class: "ptt",
    id: "ptt",
    type: "button",
    "aria-pressed": S.talk.listening ? "true" : "false",
    "aria-label": S.talk.listening ? "Stop listening" : "Start talking",
    title: S.talk.listening ? "Stop listening" : "Talk (voice)",
    html: S.talk.listening ? ICONS.stop : ICONS.mic,
    onclick: () => (S.talk.listening ? Voice.stop() : startListening()),
  });
  return h(
    "section",
    { class: "panel call", "aria-label": `Conversation with ${agent?.display_name || short(to)}` },
    h(
      "div",
      { class: "call-head" },
      h("span", { class: `lamp ${agent?.online ? "on" : ""}` }),
      h("div", {}, h("h2", {}, agent?.display_name || short(to)), h("span", { class: "mono muted" }, to)),
      h("span", { style: "flex:1" }),
      h("button", { class: "btn secondary small", onclick: () => ((S.talk.thread[to] = null), (S.talk.log[to] = []), renderCallLog()) }, "New conversation"),
    ),
    h("div", { class: "call-log", id: "call-log", "aria-live": "polite" }, callLogItems()),
    h(
      "div",
      {},
      h("div", { class: "composer" }, ptt, draft, h("button", { class: "btn", onclick: sendTalk }, "Send")),
      h(
        "div",
        { class: "voice-bar" },
        h("label", {}, h("input", { type: "checkbox", checked: S.talk.autoSend, onchange: (e) => (S.talk.autoSend = e.target.checked) }), "Send when I stop talking"),
        h("label", {}, h("input", { type: "checkbox", checked: S.talk.readAloud, onchange: (e) => (S.talk.readAloud = e.target.checked) }), "Read replies aloud"),
        h("span", { class: "muted" }, S.overview?.relay?.voice?.reson8 ? "Voice by Reson8" : "Voice by your browser (add a Reson8 key for better accuracy)"),
        h("span", { class: "heard", id: "heard" }, S.talk.heard),
      ),
    ),
  );
}

function callLogItems() {
  const items = S.talk.log[S.talk.to] ?? [];
  if (!items.length) return h("div", { class: "empty" }, h("strong", {}, "Say hello"), "Press the microphone button and talk, or type below. Your message goes through the relay like any other.");
  return items.map((m) =>
    h(
      "div",
      { class: `bubble ${m.mine ? "me" : "them"}` },
      m.text,
      h("span", { class: "bubble-meta" }, m.mine ? `${m.state ?? "sending"}${m.reason_code ? ` (${m.reason_code})` : ""}, ${ago(m.at)}` : `${nameOf(m.from)}, ${ago(m.at)}`),
    ),
  );
}

function renderCallLog() {
  const log = document.getElementById("call-log");
  if (!log) return;
  log.replaceChildren(...[callLogItems()].flat());
  log.scrollTop = log.scrollHeight;
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
  if (draft) draft.value = "";
  const log = (S.talk.log[to] ??= Object.assign([], { loaded: true }));
  const item = { id: null, mine: true, from: S.overview?.relay?.console_address, text, state: "sending", at: new Date().toISOString() };
  log.push(item);
  renderCallLog();
  try {
    const r = await api("POST", "/v1/admin/console/send", { to, text, thread_id: S.talk.thread[to] || undefined });
    Object.assign(item, { id: r.id, thread_id: r.thread_id, state: r.state, reason_code: r.reason_code });
    S.talk.thread[to] = r.thread_id;
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
        if (S.talk.autoSend) sendTalk(t);
        else {
          S.talk.draft = `${S.talk.draft ? `${S.talk.draft} ` : ""}${t}`;
          const d = document.getElementById("draft");
          if (d) d.value = S.talk.draft;
        }
      },
      onState: (on) => {
        S.talk.listening = on;
        const b = document.getElementById("ptt");
        if (b) {
          b.setAttribute("aria-pressed", on ? "true" : "false");
          b.setAttribute("aria-label", on ? "Stop listening" : "Start talking");
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
              h("td", {}, h("div", { class: "row" }, h("span", { class: `lamp ${a.online ? "on" : ""}` }), h("div", {}, h("b", {}, a.display_name || short(a.address)), h("div", { class: "mono muted" }, a.address)))),
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
      ? h("div", { class: "traffic" }, h("div", { class: "panel feed" }, held.map((m) => msgRow(m, () => select(m.id)))), h("aside", { class: "panel panel-pad detail", id: "detail" }, detailView()))
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
      errors.replaceChildren(h("p", {}, "The policy wasn't saved:"), h("ul", {}, (e.data?.errors ?? [e.message]).map((x) => h("li", {}, x))));
    }
  };
  async function load() {
    try {
      const p = await api("GET", "/v1/admin/policy");
      editor.value = p.yaml;
      summary.replaceChildren(policySummary(p));
      versions.replaceChildren(
        h("h3", { class: "section-title", style: "margin-top:0" }, "History"),
        h("div", { class: "stages" }, p.versions.map((v) => h("div", { class: "stage" }, h("span", { class: "stage-name" }, `v${v.version}`), h("span", {}, v.note || "No note"), h("span", { class: "muted" }, ago(v.created_at))))),
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
  const judge = {
    off: "Off. Only the checks above run, so messages are delivered in milliseconds.",
    heuristic: "Offline keyword checks on top of the rules above.",
    anthropic: "Claude reviews each message before delivery (adds about a second).",
    auto: "Claude reviews each message when an Anthropic key is set; otherwise offline keyword checks.",
    "claude-cli": "Offline keyword checks (the Claude CLI isn't available on Cloudflare).",
  }[p.guard.judge] ?? p.guard.judge;
  const joining = { approval: "Anyone can ask to join; you approve each new agent on the Agents page.", invite: "With an invite link from the Invites page. Without one, you approve them on the Agents page.", open: "Anyone who knows the relay address joins straight away." }[p.registration] ?? p.registration;
  const lim = p.limits;
  return h(
    "div",
    {},
    h("h2", { class: "section-title", style: "margin-top:0" }, "What this policy does"),
    h(
      "dl",
      { class: "kv policy-kv" },
      h("dt", {}, "Joining"), h("dd", {}, joining),
      h("dt", {}, "Who can message whom"), h("dd", {}, links),
      h("dt", {}, "Topics"),
      h("dd", {}, h("ul", { class: "plain-list" }, Object.entries(p.scopes).map(([name, s]) => h("li", {}, h("b", {}, name), ": ", s.description)))),
      h("dt", {}, "Masked before delivery"), h("dd", {}, findingList(p.rules.redact)),
      h("dt", {}, "Held for your review"), h("dd", {}, findingList(p.rules.hold)),
      h("dt", {}, "Blocked"), h("dd", {}, findingList(p.rules.block)),
      h("dt", {}, "AI guard"), h("dd", {}, judge),
      h("dt", {}, "Limits"),
      h("dd", {}, `${lim.max_hops_per_thread} back-and-forths and ${lim.max_messages_per_thread} messages per conversation, ${Math.round(lim.max_body_bytes / 1024)} KiB per message (files included). Undelivered messages expire after ${duration(lim.message_ttl_ms)}.`),
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
          ? events.map((e) => h("div", { class: "msg", style: "cursor:default" }, h("span", { class: "msg-route" }, e.action, h("span", { class: "arrow" }, "by"), e.actor), h("span", { class: "msg-time" }, timeEl(e.at)), h("span", { class: "msg-preview mono" }, e.target ?? "")))
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
  rerenderTimer = setTimeout(() => (S.view === "talk" || S.view === "session" ? null : renderShell()), 250);
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
    document.querySelector(".conn")?.replaceChildren(h("span", { class: "lamp on" }), "Live updates on");
  };
  events.onerror = () => {
    S.connected = false;
    document.querySelector(".conn")?.replaceChildren(h("span", { class: "lamp" }), "Reconnecting…");
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
    if ((S.view === "talk" || S.view === "session") && S.talk.to === m.from) {
      renderCallLog();
      speak(m.text ?? m.preview ?? "");
    } else {
      S.unreadTalk++;
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
  events.addEventListener("message", () => S.view === "sessions" && loadSessions().then(soon));
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

function workspaceSwitcher(ws) {
  const select = h(
    "select",
    {
      class: "ws-select",
      "aria-label": "Workspace",
      onchange: (e) => (e.target.value === "__new" ? newWorkspaceDialog(() => (e.target.value = S.ws)) : switchWorkspace(e.target.value)),
    },
    S.workspaces.map((w) => h("option", { value: w.slug, selected: w.slug === S.ws }, w.name)),
    h("option", { value: "__new" }, "New workspace…"),
  );
  return h("label", { class: "ws", title: ws ? `agent://${ws.slug}` : "" }, h("span", { class: "ws-label" }, "Workspace"), select);
}

function newWorkspaceDialog(onCancel) {
  const name = h("input", { class: "input", placeholder: "Acme research", maxlength: 60, required: true });
  let done = false;
  const dlg = openDialog(
    "New workspace",
    h("p", { class: "muted" }, "A workspace has its own agents, sessions and policy. Use one per team or project."),
    h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const ws = await api("POST", "/api/workspaces", { name: name.value });
            S.workspaces.push(ws);
            done = true;
            dlg.close();
            switchWorkspace(ws.slug);
          } catch (err) {
            toast(err.message);
          }
        },
      },
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("div", { class: "dialog-actions" }, h("button", { class: "btn", type: "submit" }, "Create workspace")),
    ),
  );
  dlg.addEventListener("close", () => !done && onCancel?.());
  name.focus();
}

async function switchWorkspace(slug) {
  Voice.stop();
  closeEvents();
  Object.assign(S, { ws: slug, session: null, sessionData: null, view: "sessions", selected: null, detail: null, messages: [], agents: [], sessions: [] });
  S.talk.log = {};
  S.talk.thread = {};
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

function userBlock() {
  const u = S.me ?? {};
  const face = u.avatar_url
    ? h("img", { class: "user-av", src: u.avatar_url, alt: "", referrerpolicy: "no-referrer" })
    : h("span", { class: "user-av initials", "aria-hidden": "true" }, (u.name || u.email || "?").slice(0, 1).toUpperCase());
  return h(
    "div",
    { class: "user" },
    face,
    h("div", { class: "user-text" }, h("span", { class: "user-name" }, u.name || "You"), h("span", { class: "user-mail" }, u.email || "")),
    h(
      "div",
      { class: "user-actions" },
      h("button", { type: "button", class: "link-btn", onclick: toggleTheme }, "Theme"),
      h("button", { type: "button", class: "link-btn", onclick: signOut }, "Sign out"),
    ),
  );
}

async function signOut() {
  Voice.stop();
  closeEvents();
  await fetch("/auth/signout", { method: "POST" });
  location.href = "/";
}

// ------------------------------------------------------------------ sessions

async function loadSessions() {
  try {
    S.sessions = (await api("GET", "/v1/admin/sessions")).sessions;
  } catch (e) {
    S.sessions = [];
    if (e.status !== 404) toast(e.message);
  }
}

const ownerAgents = () => S.agents.filter((a) => a.owner && a.status === "active" && a.address !== S.overview?.relay?.console_address);

function viewSessions() {
  const isolated = S.overview?.relay?.isolation === "sessions";
  const mine = ownerAgents();
  return h(
    "div",
    {},
    pageHead(
      "Sessions",
      "Each session is a private line between your agents and the people you invite. Guests only ever see their own session.",
      h("button", { class: "btn secondary", onclick: connectAgentDialog }, "Connect your agent"),
      h("button", { class: "btn", onclick: newSessionDialog }, "New session"),
    ),
    !isolated
      ? h("div", { class: "callout" }, h("b", {}, "This workspace uses org-wide links."), " Everyone here can reach everyone the policy allows, so sessions are for organizing invites. New workspaces keep each session private.")
      : null,
    mine.length
      ? h(
          "div",
          { class: "mine" },
          h("span", { class: "muted small" }, "Your agents"),
          mine.map((a) => h("span", { class: "chip-agent" }, h("span", { class: `lamp ${a.online ? "on" : ""}` }), a.display_name || short(a.address))),
        )
      : h(
          "button",
          { class: "callout callout-action", onclick: connectAgentDialog },
          h("b", {}, "Connect your own agent first."),
          " Your Claude Code (or any agent) joins as you, and can then talk to everyone in your sessions.",
          h("span", { class: "callout-cta" }, "Connect"),
        ),
    S.sessions.length
      ? h("div", { class: "session-grid" }, S.sessions.map(sessionCard))
      : h(
          "div",
          { class: "panel empty big" },
          h("div", { class: "empty-art", html: LOGO_MARK }),
          h("strong", {}, "No sessions yet"),
          h("p", {}, "Start one for each person whose agent you want to talk to. They get a link; their agent joins in one step."),
          h("button", { class: "btn", onclick: newSessionDialog }, "New session"),
        ),
  );
}

function sessionCard(s) {
  const waiting = !s.guests.length;
  return h(
    "button",
    { class: "session-card", onclick: () => openSession(s.id) },
    h(
      "div",
      { class: "session-top" },
      h("span", { class: "session-name" }, s.name),
      waiting ? h("span", { class: "pill queued" }, "waiting to join") : h("span", { class: "faces" }, s.guests.slice(0, 4).map((g) => h("span", { class: "face" }, avatar(g.address), h("span", { class: `lamp ${g.online ? "on" : ""}` })))),
    ),
    h("p", { class: "session-preview" }, s.last_preview || (waiting ? "Send them the invite link to get started." : "No messages yet.")),
    h("span", { class: "session-meta" }, s.last_message_at ? `Last message ${ago(s.last_message_at)}` : `Started ${ago(s.created_at)}`),
  );
}

function newSessionDialog() {
  const name = h("input", { class: "input", placeholder: "David", maxlength: 80, required: true, autocomplete: "off" });
  const body = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const s = await api("POST", "/v1/admin/sessions", { name: name.value });
          await loadSessions();
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
    h("p", { class: "muted small" }, "Their agent will only be able to talk to your agents, never to people in your other sessions."),
    h("div", { class: "dialog-actions" }, h("button", { class: "btn", type: "submit" }, "Create session and invite link")),
  );
  const dlg = openDialog("New session", body);
  name.focus();
}

async function connectAgentDialog() {
  try {
    const inv = await api("POST", "/v1/admin/invites", { owner: true, note: "My agent", max_uses: 3, ttl_hours: 72 });
    openDialog(
      "Connect your agent",
      h("p", {}, "Your agent joins as you: it can reach everyone in all your sessions. Use the link on up to three of your own machines in the next 3 days."),
      inviteSteps(inv.url),
      h("details", { class: "more" }, h("summary", {}, "Terminal, Codex or the SDK"), copyLine(`node a2a.mjs join ${inv.url}`), h("p", { class: "muted small" }, h("a", { href: "/docs#install" }, "Download a2a.mjs and the SDK"))),
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
  const back = h("button", { class: "back", onclick: () => go("sessions") }, h("span", { html: ICONS.arrow }), "All sessions");
  if (!d) return h("div", {}, back, h("div", { class: "panel empty" }, "Loading the session…"));
  if (d.error) return h("div", {}, back, h("div", { class: "panel empty" }, h("strong", {}, "This session isn't available"), "It may have been archived."));
  const guests = d.members.filter((m) => m.role === "guest");
  const liveInvite = d.invites.find((i) => i.valid);
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
  return h(
    "div",
    { class: "session-page" },
    back,
    pageHead(
      d.name,
      guests.length ? `Private between your agents and ${guests.map((g) => g.display_name || short(g.address)).join(", ")}.` : "Waiting for the first person to join.",
      h("button", { class: "btn secondary", onclick: newInvite }, "Invite link"),
      h("button", { class: "btn ghost-danger", onclick: archive }, "Archive"),
    ),
    h(
      "div",
      { class: "session-layout" },
      guests.length
        ? h(
            "section",
            { class: "session-main" },
            guests.length > 1
              ? h("div", { class: "seg", role: "tablist" }, guests.map((g) => h("button", { role: "tab", "aria-selected": S.talk.to === g.address ? "true" : "false", onclick: () => ((S.talk.to = g.address), renderView()) }, g.display_name || short(g.address))))
              : null,
            callPanel(),
          )
        : h(
            "section",
            { class: "panel panel-pad waiting" },
            h("h2", {}, `Waiting for ${d.name}`),
            liveInvite ? h("div", {}, h("p", { class: "muted" }, "Send them this link. The session opens as soon as their agent joins."), copyLine(liveInvite.url, "Copy link"), inviteSteps(liveInvite.url)) : h("div", {}, h("p", { class: "muted" }, "The last link was used or expired."), h("button", { class: "btn", onclick: newInvite }, "Create a new link")),
          ),
      h(
        "aside",
        { class: "session-side" },
        h(
          "section",
          { class: "panel panel-pad" },
          h("h3", { class: "side-title" }, "People"),
          h(
            "ul",
            { class: "people" },
            d.members
              .filter((m) => m.address !== S.overview?.relay?.console_address)
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
          { class: "panel panel-pad" },
          h("h3", { class: "side-title" }, "Agent-to-agent"),
          d.messages.filter((m) => m.from !== S.overview?.relay?.console_address && m.to !== S.overview?.relay?.console_address).length
            ? h(
                "ul",
                { class: "a2a-feed" },
                d.messages
                  .filter((m) => m.from !== S.overview?.relay?.console_address && m.to !== S.overview?.relay?.console_address)
                  .slice(-12)
                  .map((m) => h("li", {}, h("div", { class: "a2a-route" }, h("b", {}, nameOf(m.from)), h("span", { class: "muted" }, " to "), h("b", {}, nameOf(m.to)), pill(m.state)), h("p", {}, m.preview), h("span", { class: "muted small" }, ago(m.received_at)))),
              )
            : h("p", { class: "muted small" }, "When your agent and theirs talk, the conversation shows up here."),
        ),
      ),
    ),
  );
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
        h("dl", { class: "kv" }, h("dt", {}, "Agent addresses"), h("dd", { class: "mono" }, `agent://${r.org ?? ws?.slug}/<name>`), h("dt", {}, "Relay address"), h("dd", { class: "mono" }, r.url ?? ""), h("dt", {}, "Voice"), h("dd", {}, r.voice?.reson8 ? "Reson8 speech-to-text" : "Your browser's speech recognition")),
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
    document.getElementById("app").replaceChildren(h("main", { class: "login" }, h("div", { class: "panel empty" }, "No workspace yet.")));
    return;
  }
  if (view === "s" && id) {
    S.view = "session";
    S.session = id;
  } else if (NAV.some(([v]) => v === view)) S.view = view;
  await Promise.all([refresh(), loadSessions()]);
  renderShell(); // both loads are in: draw with sessions included
  if (S.view === "session") await loadSession();
  connectEvents();
}

boot();
