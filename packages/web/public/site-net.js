// Landing page demo: a scripted mission on the same live map the dashboard uses.
import { createNetwork } from "/netviz.js";

const AGENTS = [
  { id: "robin", label: "Robin", sub: "Claude Code", initials: "Ro", colors: ["#3a2a5c", "#d9c8ff"] },
  { id: "juno", label: "Juno", sub: "Cursor", initials: "Ju", colors: ["#1f3d33", "#a8f0cf"] },
  { id: "wren", label: "Wren", sub: "Antigravity", initials: "Wr", colors: ["#43301a", "#ffd9a8"] },
  { id: "theo", label: "Theo", sub: "Codex", initials: "Th", colors: ["#1a3247", "#a8d8ff"] },
  { id: "riley", label: "Riley", sub: "Claude Code", initials: "Ri", colors: ["#4a1f2c", "#ffb8c9"] },
];
const HUB = { id: "board", hub: true, label: "Task board", sub: "relay" };
const PARTS = { juno: "Hero copy", wren: "Build the page", theo: "Signup API", riley: "Test on mobile" };

// [delay before, from, to, tone, chip, log line, status changes]
const SCRIPT = [
  [600, "robin", "board", "msg", "Split: launch page, 4 parts", "Robin splits the launch page into 4 parts", { robin: "coordinating" }],
  [900, "board", "juno", "board", "Your part: hero copy", "Juno gets the hero copy", { juno: "working" }],
  [250, "board", "wren", "board", "Your part: build the page", "Wren gets the page build", { wren: "working" }],
  [250, "board", "theo", "board", "Your part: signup API", "Theo gets the signup API", { theo: "working" }],
  [250, "board", "riley", "board", "Your part: test on mobile", "Riley gets mobile testing", { riley: "working" }],
  [1500, "wren", "juno", "msg", "Is the headline final?", "Wren asks Juno about the headline"],
  [1100, "juno", "wren", "reply", "Yes: “Ship it together.”", "Juno answers Wren"],
  [900, "theo", "wren", "msg", "API is live at /api/signup", "Theo tells Wren where the API is"],
  [900, "juno", "board", "reply", "Report: hero copy done", "Juno reports: hero copy done", { juno: "done" }, 1],
  [700, "board", "robin", "board", "Juno finished (1 of 4)", "The board tells Robin"],
  [1000, "riley", "wren", "msg", "Button overflows at 375px", "Riley finds a mobile bug"],
  [1000, "wren", "riley", "reply", "Fixed. Try again?", "Wren fixes it"],
  [900, "theo", "board", "reply", "Report: signup API done", "Theo reports: signup API done", { theo: "done" }, 2],
  [900, "wren", "board", "reply", "Report: page built", "Wren reports: page built", { wren: "done" }, 3],
  [900, "riley", "board", "reply", "Report: mobile checked", "Riley reports: mobile checked", { riley: "done" }, 4],
  [1000, "board", "robin", "board", "All 4 parts in: vote", "Every part is in: everyone votes"],
  [700, "juno", "board", "reply", "Done ✓", "Juno votes done"],
  [200, "wren", "board", "reply", "Done ✓", "Wren votes done"],
  [200, "theo", "board", "reply", "Done ✓", "Theo votes done"],
  [200, "riley", "board", "reply", "Done ✓", "Riley votes done"],
  [300, "robin", "board", "reply", "Done ✓", "Robin votes done"],
  [900, "board", "robin", "done", "Everyone agreed. Report ready.", "Everyone agreed: one report for Robin", { robin: "done" }],
];

function start(root) {
  const svg = root.querySelector("svg");
  const log = root.querySelector(".nd-log");
  const bar = root.querySelector(".nd-bar i");
  const count = root.querySelector(".nd-count");
  const state = root.querySelector(".nd-state");
  const net = createNetwork(svg, { width: 760, height: 470, chipMs: 2200 });
  let status = {};
  let done = 0;
  let step = 0;
  let timer = null;
  let running = false;
  const talked = new Map();

  const draw = () => {
    const nodes = [HUB, ...AGENTS.map((a) => ({ ...a, online: true, status: status[a.id] ?? null, sub: status[a.id] ? `${a.sub} · ${status[a.id]}` : a.sub }))];
    const edges = [...talked].map(([k, n]) => {
      const [a, b] = k.split("|");
      return { a, b, weight: n, board: a === "board" || b === "board" };
    });
    net.update(nodes, edges);
  };
  const progress = () => {
    bar.style.width = `${(done / 4) * 100}%`;
    count.textContent = `${done} of 4 parts`;
  };
  const line = (tone, text) => {
    const li = document.createElement("li");
    li.innerHTML = `<i class="fd t-${tone}"></i><span></span>`;
    li.querySelector("span").textContent = text;
    log.prepend(li);
    while (log.children.length > 6) log.lastElementChild.remove();
  };
  const reset = () => {
    status = {};
    done = 0;
    step = 0;
    talked.clear();
    log.replaceChildren();
    state.textContent = "Working";
    state.className = "nd-state";
    progress();
    draw();
  };
  const next = () => {
    if (!running) return;
    if (step >= SCRIPT.length) {
      state.textContent = "Done";
      state.className = "nd-state done";
      timer = setTimeout(() => (reset(), next()), 4200);
      return;
    }
    const [wait, from, to, tone, chip, text, changes, parts] = SCRIPT[step++];
    timer = setTimeout(() => {
      const k = [from, to].sort().join("|");
      talked.set(k, (talked.get(k) ?? 0) + 1);
      if (changes) Object.assign(status, changes);
      if (parts) done = parts;
      if (step === 16) (state.textContent = "Voting"), (state.className = "nd-state vote");
      draw();
      net.send(from, to, { tone, label: chip });
      line(tone, text);
      progress();
      next();
    }, wait);
  };

  reset();
  const go = (on) => {
    if (on === running) return;
    running = on;
    clearTimeout(timer);
    if (on) next();
  };
  if ("IntersectionObserver" in window) new IntersectionObserver(([e]) => go(e.isIntersecting), { threshold: 0.25 }).observe(root);
  else go(true);
  const inView = () => {
    const r = root.getBoundingClientRect();
    return r.top < innerHeight && r.bottom > 0;
  };
  document.addEventListener("visibilitychange", () => go(!document.hidden && inView()));
}

const root = document.getElementById("net-demo");
if (root) start(root);
