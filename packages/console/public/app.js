// A2A relay console. No build step: plain modules, DOM built with h(), live updates over SSE.

const S = {
  overview: null,
  messages: [],
  agents: [],
  invites: [],
  lastInvite: null,
  view: "board",
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

async function api(method, path, body) {
  const res = await fetch(path, {
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
  if (res.status === 401 && path !== "/v1/admin/login") {
    showLogin();
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
  board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="6" cy="7" r="2.2"/><circle cx="12" cy="7" r="2.2"/><circle cx="18" cy="7" r="2.2"/><circle cx="6" cy="17" r="2.2"/><circle cx="12" cy="17" r="2.2"/><circle cx="18" cy="17" r="2.2"/><path d="M6 9.2c0 4 6 3.8 6 5.6"/></svg>',
  talk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  traffic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h11M4 12h16M4 17h8"/><path d="m16 4 3 3-3 3"/></svg>',
  invites: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  agents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 7V4M9 13h.01M15 13h.01"/></svg>',
  review: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 4 6v6c0 4.5 3.4 7.8 8 9 4.6-1.2 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  policy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/></svg>',
  playground: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
};

const brandMark = () =>
  h("span", {
    class: "brand-mark",
    html: '<svg viewBox="0 0 32 32" width="30" height="30"><rect width="32" height="32" rx="8" fill="#1c2430"/><circle cx="11" cy="16" r="4" fill="#a9781f"/><circle cx="21" cy="16" r="4" fill="none" stroke="#eef1f4" stroke-width="2"/></svg>',
  });

// ------------------------------------------------------------------ login

function showLogin(error) {
  closeEvents();
  const token = h("input", { class: "input", type: "password", id: "token", autocomplete: "current-password", required: true });
  const err = h("p", { class: "error", role: "alert" }, error ?? "");
  const form = h(
    "form",
    {
      class: "panel login-card",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api("POST", "/v1/admin/login", { token: token.value.trim() });
          boot();
        } catch {
          err.textContent = "That token didn't work. Check it and try again.";
        }
      },
    },
    brandMark(),
    h("h1", {}, "Sign in to the switchboard"),
    h("p", {}, "Use the relay's admin token. On Cloudflare it's the A2A_ADMIN_TOKEN secret."),
    h("label", { class: "field" }, h("span", {}, "Admin token"), token),
    err,
    h("div", { class: "row", style: "margin-top:16px" }, h("button", { class: "btn", type: "submit" }, "Sign in")),
  );
  document.getElementById("app").replaceChildren(h("main", { class: "login" }, form));
  token.focus();
}

// ------------------------------------------------------------------ shell

const NAV = [
  ["board", "Switchboard"],
  ["talk", "Talk"],
  ["traffic", "Traffic"],
  ["invites", "Invites"],
  ["agents", "Agents"],
  ["review", "Review"],
  ["policy", "Policy"],
  ["playground", "Playground"],
  ["audit", "Audit log"],
];

function navCount(view) {
  if (view === "review") return S.overview?.stats?.held || 0;
  if (view === "agents") return S.agents.filter((a) => a.status === "pending").length;
  if (view === "talk") return S.unreadTalk;
  return 0;
}

function renderShell() {
  const org = S.overview?.relay?.org ?? "";
  const rail = h(
    "nav",
    { class: "rail", "aria-label": "Console" },
    h("div", { class: "brand" }, brandMark(), h("div", {}, h("div", { class: "brand-name" }, "Switchboard"), h("div", { class: "brand-org" }, org ? `agent://${org}` : ""))),
    NAV.map(([view, label]) => {
      const n = navCount(view);
      return h(
        "button",
        { class: "nav-btn", "aria-current": S.view === view ? "page" : false, onclick: () => go(view) },
        h("span", { html: ICONS[view] }),
        label,
        n ? h("span", { class: "nav-count", "aria-label": `${n} waiting` }, n) : null,
      );
    }),
    h(
      "div",
      { class: "rail-foot" },
      h("div", { class: "conn" }, h("span", { class: `lamp ${S.connected ? "on" : ""}` }), S.connected ? "Live updates on" : "Reconnecting…"),
      h("button", { type: "button", onclick: toggleTheme }, "Switch theme"),
      h(
        "button",
        {
          type: "button",
          onclick: async () => {
            await api("POST", "/v1/admin/logout");
            showLogin();
          },
        },
        "Sign out",
      ),
    ),
  );
  const main = h("main", { class: "main", id: "main" });
  document.getElementById("app").replaceChildren(h("div", { class: "shell" }, rail, main));
  renderView();
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
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
    history.replaceState(null, "", `#${view}`);
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
  const views = { board: viewBoard, talk: viewTalk, traffic: viewTraffic, invites: viewInvites, agents: viewAgents, review: viewReview, policy: viewPolicy, playground: viewPlayground, audit: viewAudit };
  main.replaceChildren(views[S.view]?.() ?? viewBoard());
}

// ------------------------------------------------------------------ switchboard

function jack(a) {
  const isConsole = a.address === S.overview?.relay?.console_address;
  return h(
    "button",
    {
      class: `jack ${a.online ? "on" : ""} ${isConsole ? "console" : ""} ${a.status === "pending" ? "pending" : ""}`,
      title: `${a.address}${a.online ? " (online)" : ""}`,
      onclick: () => {
        if (isConsole) return go("talk");
        if (a.status === "pending") return go("agents");
        S.talk.to = a.address;
        go("talk");
      },
    },
    h("span", { class: "socket" }, h("span", { class: `lamp ${a.online ? "on" : ""}` })),
    h("span", { class: "jack-name" }, a.display_name || short(a.address)),
    h("span", { class: "jack-addr" }, isConsole ? "you, from this console" : a.status === "pending" ? "waiting for approval" : a.online ? "online" : `seen ${ago(a.last_seen_at) || "never"}`),
  );
}

function viewBoard() {
  const st = S.overview?.stats ?? {};
  const by = st.by_state ?? {};
  const total = Object.values(by).reduce((n, x) => n + x, 0);
  const agents = [...S.agents].filter((a) => a.status !== "disabled").sort((a, b) => Number(b.online) - Number(a.online) || a.address.localeCompare(b.address));
  const online = agents.filter((a) => a.online && a.address !== S.overview?.relay?.console_address).length;
  return h(
    "div",
    {},
    pageHead(
      "Switchboard",
      "Every agent on this relay. A lit lamp means it's connected right now. Pick one to talk to it.",
      h("button", { class: "btn secondary", onclick: () => go("invites") }, "Invite someone"),
    ),
    h(
      "div",
      { class: "board", role: "list" },
      agents.map(jack),
      h(
        "button",
        { class: "jack add", onclick: () => go("invites") },
        h("span", { class: "socket", "aria-hidden": "true" }, "+"),
        h("span", { class: "jack-name" }, "Add a line"),
        h("span", { class: "jack-addr" }, "send an invite link"),
      ),
    ),
    h(
      "p",
      { class: "stats" },
      h("span", {}, h("b", {}, online), " online"),
      h("span", {}, h("b", {}, total), " messages today"),
      h("span", {}, h("b", {}, by.delivered ?? 0), " delivered"),
      h("span", {}, h("b", {}, (by.blocked ?? 0) + (by.rejected ?? 0)), " blocked"),
      h("span", {}, h("b", {}, st.held ?? 0), " waiting for review"),
      st.guard_p50_ms !== null && st.guard_p50_ms !== undefined ? h("span", {}, "guard ", h("b", {}, `${st.guard_p50_ms} ms`), " typical") : null,
    ),
    h("h2", { class: "section-title" }, "Latest traffic"),
    S.messages.length
      ? h("div", { class: "panel feed" }, S.messages.slice(0, 8).map((m) => msgRow(m, () => ((S.selected = m.id), go("traffic"), loadDetail()))))
      : h("div", { class: "panel empty" }, h("strong", {}, "No messages yet"), "Invite someone, then ask their agent something from the Talk page."),
  );
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
    h("span", { class: "msg-route" }, nameOf(m.from), h("span", { class: "arrow", "aria-label": "to" }, "to"), nameOf(m.to)),
    h("span", { class: "msg-time" }, timeEl(m.received_at)),
    h("span", { class: "msg-preview" }, m.preview || "(empty)"),
    h("span", { class: "msg-meta" }, pill(m.state), m.reason_code ? h("span", { class: "muted mono" }, m.reason_code) : null, m.redacted ? h("span", { class: "pill queued" }, "redacted") : null),
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
    h(
      "div",
      { class: "stages" },
      (d.stages ?? []).map((s) => h("div", { class: "stage" }, h("span", { class: "stage-name" }, s.stage), h("span", {}, s.reason), h("span", {}, pill(s.decision === "allow" ? "delivered" : s.decision === "redact" ? "queued" : s.decision === "hold" ? "held" : "blocked")))),
    ),
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
  if (!items.length) return h("div", { class: "empty" }, h("strong", {}, "Say hello"), "Press the brass key and talk, or type below. Your message goes through the relay like any other.");
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

// ------------------------------------------------------------------ invites

function viewInvites() {
  const note = h("input", { class: "input", placeholder: "Who it's for, e.g. David's laptop", maxlength: 120 });
  const uses = h("select", { class: "select" }, [1, 2, 5, 20].map((n) => h("option", { value: n }, n === 1 ? "1 person" : `${n} people`)));
  const ttl = h("select", { class: "select" }, [["24", "1 day"], ["168", "7 days"], ["720", "30 days"]].map(([v, l]) => h("option", { value: v, selected: v === "168" }, l)));
  const form = h(
    "form",
    {
      class: "invite-new",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          S.lastInvite = await api("POST", "/v1/admin/invites", { note: note.value, max_uses: Number(uses.value), ttl_hours: Number(ttl.value) });
          await loadInvites();
          renderView();
          toast("Invite link created");
        } catch (err) {
          toast(err.message);
        }
      },
    },
    h("label", { class: "field" }, h("span", {}, "For"), note),
    h("label", { class: "field" }, h("span", {}, "Can be used by"), uses),
    h("label", { class: "field" }, h("span", {}, "Expires after"), ttl),
    h("button", { class: "btn", type: "submit" }, "Create invite link"),
  );
  const inv = S.lastInvite;
  const message = inv
    ? `You're invited to our A2A relay. In Claude Code, run:\n/plugin install a2a --marketplace youssef-110/A2A\nthen tell Claude: "Join A2A with ${inv.url}"\nOther setups: open ${inv.url}`
    : "";
  return h(
    "div",
    {},
    pageHead("Invites", "An invite link lets someone connect their agent in one step, without the admin token. Send it however you like."),
    h(
      "div",
      { class: "panel panel-pad" },
      form,
      inv
        ? h(
            "div",
            { class: "invite-link" },
            h("strong", {}, "Send this link"),
            h("div", { class: "copy-line" }, h("code", {}, inv.url), h("button", { class: "btn secondary small", onclick: () => copy(inv.url, "Link copied") }, "Copy link")),
            h("div", { class: "copy-line" }, h("button", { class: "btn secondary small", onclick: () => copy(message, "Message copied") }, "Copy a ready-to-send message"), h("span", { class: "muted" }, "It includes the plug-in install line.")),
          )
        : null,
    ),
    h("h2", { class: "section-title" }, "All invites"),
    S.invites.length
      ? h(
          "div",
          { class: "panel table-wrap" },
          h(
            "table",
            { class: "table" },
            h("thead", {}, h("tr", {}, h("th", {}, "For"), h("th", {}, "Used"), h("th", {}, "Expires"), h("th", {}, "Status"), h("th", {}, h("span", { class: "sr-only" }, "Actions")))),
            h(
              "tbody",
              {},
              S.invites.map((i) =>
                h(
                  "tr",
                  {},
                  h("td", {}, i.note || h("span", { class: "muted" }, "No note")),
                  h("td", {}, `${i.uses} of ${i.max_uses}`),
                  h("td", {}, new Date(i.expires_at).toLocaleDateString()),
                  h("td", {}, i.revoked ? pill("revoked") : i.valid ? pill("active") : i.uses >= i.max_uses ? h("span", { class: "pill" }, "used up") : pill("expired")),
                  h(
                    "td",
                    { style: "text-align:right" },
                    i.valid
                      ? h(
                          "div",
                          { class: "row", style: "justify-content:flex-end" },
                          h("button", { class: "btn secondary small", onclick: () => copy(i.url, "Link copied") }, "Copy link"),
                          h(
                            "button",
                            {
                              class: "btn danger small",
                              onclick: async () => {
                                await api("DELETE", `/v1/admin/invites/${encodeURIComponent(i.code)}`);
                                await loadInvites();
                                renderView();
                                toast("Invite revoked");
                              },
                            },
                            "Revoke",
                          ),
                        )
                      : null,
                  ),
                ),
              ),
            ),
          ),
        )
      : h("div", { class: "panel empty" }, h("strong", {}, "No invites yet"), "Create one above to bring the first person on."),
  );
}

async function loadInvites() {
  try {
    S.invites = (await api("GET", "/v1/admin/invites")).invites;
  } catch (e) {
    toast(e.message);
  }
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
      versions.replaceChildren(
        h("dl", { class: "kv" }, h("dt", {}, "Joining"), h("dd", {}, { approval: "an admin approves each new agent", invite: "invite link, or admin approval", open: "anyone can join" }[p.registration] ?? p.registration), h("dt", {}, "Scopes"), h("dd", {}, Object.keys(p.scopes).join(", "))),
        h("h3", { class: "section-title" }, "History"),
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
      h("div", { class: "panel panel-pad" }, editor, h("div", { class: "row", style: "margin-top:12px" }, noteInput, h("button", { class: "btn", onclick: save }, "Save policy")), errors),
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

// ------------------------------------------------------------------ playground

function viewPlayground() {
  const opts = S.agents.filter((a) => a.status === "active").map((a) => h("option", { value: a.address }, a.address));
  const from = h("select", { class: "select" }, opts.map((o) => o.cloneNode(true)));
  const to = h("select", { class: "select" }, opts);
  if (to.options.length > 1) to.selectedIndex = 1;
  const scope = h("input", { class: "input", value: "general" });
  const text = h("textarea", { class: "textarea", placeholder: "Type a message to see what the guard would do with it." });
  const out = h("div", {}, h("p", { class: "muted" }, "The verdict shows here."));
  return h(
    "div",
    {},
    pageHead("Playground", "Try a message against the current policy without sending it."),
    h(
      "div",
      { class: "policy" },
      h(
        "form",
        {
          class: "panel panel-pad",
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const v = await api("POST", "/v1/admin/screen", { from: from.value, to: to.value, scope: scope.value, text: text.value });
              out.replaceChildren(
                h("div", { class: "row" }, pill(v.decision === "allow" ? "delivered" : v.decision === "redact" ? "queued" : v.decision === "hold" ? "held" : "blocked"), v.reason_code ? h("span", { class: "mono muted" }, v.reason_code) : null),
                h("p", {}, v.reason),
                v.delivered_text ? h("div", { class: "quote" }, redactedText(v.delivered_text)) : null,
                h("div", { class: "stages" }, (v.stages ?? []).map((s) => h("div", { class: "stage" }, h("span", { class: "stage-name" }, s.stage), h("span", {}, s.reason), h("span", { class: "muted" }, s.decision)))),
              );
            } catch (err) {
              toast(err.message);
            }
          },
        },
        h("div", { class: "invite-new", style: "grid-template-columns:1fr 1fr 1fr" }, h("label", { class: "field" }, h("span", {}, "From"), from), h("label", { class: "field" }, h("span", {}, "To"), to), h("label", { class: "field" }, h("span", {}, "Scope"), scope)),
        h("label", { class: "field", style: "margin-top:12px" }, h("span", {}, "Message"), text),
        h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn", type: "submit" }, "Check message")),
      ),
      h("aside", { class: "panel panel-pad" }, out),
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
  rerenderTimer = setTimeout(() => (S.view === "talk" ? null : renderShell()), 250);
}

let events;
function closeEvents() {
  events?.close();
  events = null;
}

function connectEvents() {
  closeEvents();
  events = new EventSource("/v1/admin/events");
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
    if (S.view === "talk") renderCallLog();
    if (S.selected === m.id && S.view === "traffic") loadDetail();
    soon();
  });
  events.addEventListener("console", (e) => {
    const m = JSON.parse(e.data);
    const log = (S.talk.log[m.from] ??= Object.assign([], { loaded: false }));
    if (!log.some((x) => x.id === m.id)) log.push({ id: m.id, thread_id: m.thread_id, mine: false, from: m.from, text: m.text ?? m.preview, state: m.state, at: m.received_at });
    S.talk.thread[m.from] = m.thread_id;
    if (S.view === "talk" && S.talk.to === m.from) {
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
}

async function boot() {
  try {
    const saved = localStorage.getItem("a2a-theme");
    if (saved) document.documentElement.dataset.theme = saved;
  } catch {
    /* storage blocked */
  }
  try {
    const { admin } = await api("GET", "/v1/admin/session");
    if (!admin) return showLogin();
  } catch {
    return showLogin("Couldn't reach the relay.");
  }
  const hash = location.hash.slice(1);
  if (NAV.some(([v]) => v === hash)) S.view = hash;
  await Promise.all([refresh(), loadInvites()]);
  connectEvents();
  setInterval(() => S.view === "board" && renderView(), 60_000);
}

boot();
