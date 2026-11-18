// a2a landing page. One rAF loop drives everything that moves: Lenis smoothing, the pinned story
// (the board tilts, shows an invite, splits into one row per AI app), the halftone dissolves, the
// key statements and the dot-matrix boards. Scenes are pure functions of scroll position, so they
// run backwards as well as forwards. With reduced motion nothing is pinned or smoothed and every
// board shows its final text.
import { textCells } from "/dotfont.js";

const root = document.documentElement;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const motion = !reduce && "IntersectionObserver" in window;
if (motion) root.classList.add("motion");

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const map = (v, a, b) => clamp((v - a) / (b - a));
const lerp = (a, b, t) => a + (b - a) * t;
const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeIn = (t) => t * t * t;
const RAD = Math.PI / 180;

// ---------------------------------------------------------------- dot-matrix strips
// A strip is one row of a message board: 96 by 9 dots, one line of up to 15 characters.
const COLS = 96;
const ROWS = 9;
const INK = { off: "#222225", white: "#f1f1ec", dim: "#7a7a73", blue: "#3d95ff", amber: "#ffa424" };
const FADE = 150;
const sprites = new Map();
function sprite(color, p) {
  const key = `${color}${Math.round(p * 10)}`;
  if (sprites.has(key)) return sprites.get(key);
  const s = Math.ceil(p * 2);
  const c = Object.assign(document.createElement("canvas"), { width: s, height: s });
  const g = c.getContext("2d");
  const m = s / 2;
  if (color !== INK.off) {
    // A lit LED: a soft spill around a solid core.
    const halo = g.createRadialGradient(m, m, p * 0.3, m, m, p * 0.8);
    halo.addColorStop(0, `${color}38`);
    halo.addColorStop(1, `${color}00`);
    g.fillStyle = halo;
    g.fillRect(0, 0, s, s);
  }
  g.fillStyle = color;
  g.beginPath();
  g.arc(m, m, p * 0.37, 0, Math.PI * 2);
  g.fill();
  sprites.set(key, c);
  return c;
}

const busy = new Set();
class Strip {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    const n = COLS * ROWS;
    this.level = new Float32Array(n);
    this.from = new Float32Array(n);
    this.to = new Uint8Array(n);
    this.start = new Float64Array(n);
    this.color = new Array(n).fill(INK.white);
    this.key = "";
  }
  resize() {
    const w = this.c.clientWidth;
    if (!w) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.p = (w / COLS) * dpr;
    this.c.width = Math.round(w * dpr);
    this.c.height = Math.round(this.p * ROWS);
    this.base = document.createElement("canvas");
    Object.assign(this.base, { width: this.c.width, height: this.c.height });
    const off = sprite(INK.off, this.p);
    const bg = this.base.getContext("2d");
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) bg.drawImage(off, (x + 0.5) * this.p - off.width / 2, (y + 0.5) * this.p - off.height / 2);
    this.draw();
  }
  /** colors: one INK name for the line, or an array with one name per character. */
  set(text = "", colors = "white", { align = "left", instant = false, delay = 0 } = {}) {
    const t = text.toUpperCase().slice(0, 15);
    const key = `${t}|${align}|${colors}`;
    if (key === this.key) return;
    this.key = key;
    const width = Math.max(0, t.length * 6 - 1);
    const x0 = align === "center" ? Math.floor((COLS - width) / 2) : 3;
    const next = new Uint8Array(COLS * ROWS);
    const tint = new Array(COLS * ROWS);
    for (const [x, y, i] of textCells(t)) {
      const at = (y + 1) * COLS + x0 + x;
      next[at] = 1;
      tint[at] = INK[Array.isArray(colors) ? colors[i] ?? "white" : colors];
    }
    const now = performance.now();
    for (let i = 0; i < next.length; i++) {
      const recolor = next[i] && this.to[i] && tint[i] !== this.color[i];
      if (next[i] === this.to[i] && !recolor) continue;
      this.from[i] = recolor ? 0 : this.level[i];
      this.to[i] = next[i];
      if (next[i]) this.color[i] = tint[i];
      // The change sweeps left to right like a board refreshing, with a little scatter per dot.
      this.start[i] = instant ? 0 : now + delay + (i % COLS) * 4 + Math.random() * 70;
    }
    busy.add(this);
  }
  step(now) {
    let active = false;
    for (let i = 0; i < this.to.length; i++) {
      if (this.level[i] === this.to[i]) continue;
      const k = this.start[i] ? clamp((now - this.start[i]) / FADE) : 1;
      this.level[i] = this.from[i] + (this.to[i] - this.from[i]) * k;
      if (k < 1) active = true;
    }
    this.draw();
    return active;
  }
  draw() {
    if (!this.base) return;
    const { g, p } = this;
    g.clearRect(0, 0, this.c.width, this.c.height);
    g.drawImage(this.base, 0, 0);
    for (let i = 0; i < this.level.length; i++) {
      const v = this.level[i];
      if (v < 0.02) continue;
      const s = sprite(this.color[i], p);
      g.globalAlpha = v;
      g.drawImage(s, ((i % COLS) + 0.5) * p - s.width / 2, (Math.floor(i / COLS) + 0.5) * p - s.height / 2);
    }
    g.globalAlpha = 1;
  }
}
const tickBoards = (now) => {
  for (const s of busy) if (!s.step(now)) busy.delete(s);
};

/** Five strips that read as one board. lines: [text, colors, align] per row. */
class Panel {
  constructor(el) {
    this.strips = [...el.querySelectorAll("canvas")].map((c) => new Strip(c));
  }
  set(lines, opts = {}) {
    this.strips.forEach((s, i) => {
      const [text = "", colors = "white", align = "left"] = lines[i] ?? [];
      s.set(text, colors, { align, instant: opts.instant, delay: (opts.delay ?? 0) + i * 70 });
    });
  }
  resize() {
    this.strips.forEach((s) => s.resize());
  }
}

// ---------------------------------------------------------------- the story
const HERO_Q = [["RILEY-CLAUDE", "blue"], ["ASK THEO WHICH"], ["MCP SERVERS"], ["THEY HAVE"], ["SENDING", "dim"]];
const HERO_A = [["THEO-CODEX", "blue"], ["GITHUB,"], ["FILESYSTEM AND"], ["APIFY."], ["ANSWERED ~", "blue"]];
const INVITE = [["NEW SESSION", "dim"], ["LAUNCH TEAM"], [""], ["INVITE LINK", "dim"], ["/JOIN/K7M4XT", "blue"]];
const APPS = ["CLAUDE CODE", "CURSOR", "CODEX", "ANTIGRAVITY", "GEMINI CLI"].map((t) => [t, "white", "center"]);
const KEYS = [
  [["ED25519 KEY", "blue"], ["MADE ON THIS"], ["COMPUTER"], [""], ["RELAY HOLDS 0", "dim"]],
  [["SENDER", "dim"], ["SIGNATURE OK", "blue"], [""], ["RELAY", "dim"], ["COUNTERSIGNED", "blue"]],
  [["GUARD CHECK", "dim"], ["ABOUT 1 MS"], [""], ["ASK AND ANSWER", "dim"], ["ABOUT 150 MS"]],
];

const stage = document.getElementById("how");
const pin = document.getElementById("stage-pin");
const rig = document.getElementById("rig");
const housing = document.getElementById("housing");
const stripEls = [...rig.querySelectorAll(".strip")];
const board = new Panel(rig);
const caps = [...stage.querySelectorAll(".cap")];
const hd = document.getElementById("hd");

let W = innerWidth;
let H = innerHeight;
let BW = 640;
let SH = 60;
const GAP = 4;
function sizeStage() {
  W = innerWidth;
  H = innerHeight;
  // The board fills at most 42% of the screen height, so the caption under it always fits.
  BW = Math.round(Math.min(640, W - 40, (0.42 * H - 40) / (5 * 9 / 96)));
  SH = (BW * 9) / 96;
  rig.style.setProperty("--bw", `${BW}px`);
  rig.style.setProperty("--sh", `${SH}px`);
  rig.style.setProperty("--hh", `${5 * SH + 4 * GAP + 24}px`);
}

// Where each row lands when the board splits: around the caption, never over it.
function scatter(i) {
  if (W < 760) {
    const ys = [0.15, 0.25, 0.71, 0.81, 0.91];
    const s = Math.min(0.78, (W - 48) / BW);
    return { x: [-0.06, 0.07, -0.05, 0.06, -0.03][i] * W, y: (ys[i] - 0.43) * H, z: 0, rx: [10, 8, -8, -10, -12][i], ry: [12, -14, 10, -12, 8][i], rz: [-4, 3, 3, -3, 2][i], s };
  }
  const S = [
    { x: -1, y: -0.27, rx: 16, ry: 24, rz: -8, s: 0.54 },
    { x: 1, y: -0.3, rx: 12, ry: -26, rz: 7, s: 0.48 },
    { x: -1, y: 0.13, rx: -14, ry: 20, rz: 5, s: 0.5 },
    { x: 1, y: 0.11, rx: -10, ry: -22, rz: -6, s: 0.54 },
    { x: 0, y: 0.34, rx: -20, ry: 8, rz: 3, s: 0.46 },
  ][i];
  const side = W / 2 - 250 - 24; // room beside a 500px caption
  const s = S.x ? Math.min(S.s, side / BW) : S.s;
  const x = S.x * Math.max(0.3 * W, 250 + (BW * s) / 2);
  return { x, y: S.y * H, z: 0, rx: S.rx, ry: S.ry, rz: S.rz, s };
}

const DARK = [14, 14, 15];
const LIGHT = [246, 246, 244];
let stageTone = "dark";
let band = -1;
let introDone = false;
const setCap = (el, v) => {
  el.style.opacity = v;
  el.style.filter = v < 0.999 ? `blur(${((1 - v) * 12).toFixed(2)}px)` : "none";
  el.style.transform = `translateY(${((1 - v) * 18).toFixed(1)}px)`;
  el.style.visibility = v < 0.001 ? "hidden" : "visible";
};
const tf = (P) => `translate3d(${P.x.toFixed(1)}px,${P.y.toFixed(1)}px,${P.z.toFixed(1)}px) rotateX(${P.rx.toFixed(2)}deg) rotateY(${P.ry.toFixed(2)}deg) rotateZ(${P.rz.toFixed(2)}deg) scale(${P.s.toFixed(4)})`;

function updateStage(p) {
  // The page turns from night to paper as the board tips back.
  const bg = inOut(map(p, 0.05, 0.17));
  const c = DARK.map((d, k) => Math.round(lerp(d, LIGHT[k], bg)));
  const l = Math.round(lerp(255, 0, bg));
  pin.style.backgroundColor = `rgb(${c})`;
  pin.style.setProperty("--line", `rgb(${l} ${l} ${l} / ${lerp(0.07, 0.075, bg).toFixed(3)})`);
  stageTone = bg > 0.5 ? "light" : "dark";

  setCap(caps[0], 1 - map(p, 0.025, 0.085));
  setCap(caps[1], Math.min(map(p, 0.15, 0.21), 1 - map(p, 0.29, 0.345)));
  // On phones the rows cross the caption on their way out, so it waits until they have passed.
  const capIn = W < 760 ? [0.55, 0.62] : [0.4, 0.47];
  setCap(caps[2], Math.min(map(p, ...capIn), 1 - map(p, 0.83, 0.91)));

  const tilt = inOut(map(p, 0.05, 0.25));
  const split = map(p, 0.33, 0.64);
  const exit = easeIn(map(p, 0.76, 0.96));
  const rx = lerp(0, 24, tilt);
  const s = lerp(1, 0.9, tilt);
  const y0 = lerp(0, -0.06 * H, tilt);
  const gone = inOut(map(split, 0, 0.35));
  housing.style.transform = `translate3d(0,${y0.toFixed(1)}px,0) rotateX(${rx.toFixed(2)}deg) scale(${(s * (1 + gone * 0.08)).toFixed(4)})`;
  housing.style.opacity = 1 - gone;

  stripEls.forEach((el, i) => {
    const local = (i - 2) * (SH + GAP);
    const J = { x: 0, y: y0 + local * Math.cos(rx * RAD) * s, z: local * Math.sin(rx * RAD) * s, rx, ry: 0, rz: 0, s };
    const T = scatter(i);
    const t = inOut(clamp(split * 1.35 - i * 0.08));
    const P = Object.fromEntries(Object.keys(J).map((k) => [k, lerp(J[k], T[k], t)]));
    P.z += Math.sin(t * Math.PI) * (i - 2) * 70; // rows part in depth mid-flight, so they never cut through each other
    if (exit > 0) {
      P.y -= exit * (0.6 * H + i * 50);
      P.rz += exit * T.rz * 1.5;
      P.rx += exit * 25;
    }
    el.style.transform = tf(P);
    el.style.opacity = 1 - map(exit, 0.45, 1);
  });

  const b = p < 0.17 ? 0 : p < 0.37 ? 1 : 2;
  if (b !== band && (b > 0 || introDone)) {
    band = b;
    board.set(b === 0 ? HERO_A : b === 1 ? INVITE : APPS);
  }
}

// ---------------------------------------------------------------- the key statements
const keys = document.getElementById("security");
const keysPanelEl = document.getElementById("keys-panel");
const keysPanel = new Panel(keysPanelEl);
const stmts = [...keys.querySelectorAll(".stmt")];
let keysIdx = -1;
function updateKeys(p) {
  setCap(stmts[0], 1 - map(p, 0.3, 0.36));
  setCap(stmts[1], Math.min(map(p, 0.37, 0.43), 1 - map(p, 0.63, 0.69)));
  setCap(stmts[2], map(p, 0.7, 0.76));
  keysPanelEl.style.transform = `perspective(1400px) rotateX(${lerp(12, -8, p).toFixed(2)}deg) rotateY(${lerp(-10, 10, p).toFixed(2)}deg)`;
  const idx = p < 0.365 ? 0 : p < 0.695 ? 1 : 2;
  if (idx !== keysIdx) {
    keysIdx = idx;
    keysPanel.set(KEYS[idx]);
  }
}

// ---------------------------------------------------------------- halftone dissolves
const dissolves = [...document.querySelectorAll(".dissolve")].map((el) => ({ el, c: el.querySelector("canvas"), p: -1 }));
function sizeDissolve(d) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = d.el.clientWidth;
  const h = d.el.clientHeight;
  d.c.width = Math.round(w * dpr);
  d.c.height = Math.round(h * dpr);
  d.cell = (W < 760 ? 16 : 22) * dpr;
  d.cols = Math.ceil(d.c.width / d.cell);
  d.rows = Math.ceil(d.c.height / d.cell);
  d.jit = Float32Array.from({ length: d.cols * d.rows }, () => Math.random());
  d.color = d.el.dataset.to === "dark" ? `rgb(${DARK})` : `rgb(${LIGHT})`;
  d.p = -1;
}
function drawDissolve(d, p) {
  if (Math.abs(p - d.p) < 0.002) return;
  d.p = p;
  const g = d.c.getContext("2d");
  const { cell, cols, rows } = d;
  g.clearRect(0, 0, d.c.width, d.c.height);
  g.fillStyle = d.color;
  const front = 0.1 + p * 1.25; // how far up the band the next page has reached
  for (let r = 0; r < rows; r++) {
    const rowF = (r + 0.5) / rows;
    for (let k = 0; k < cols; k++) {
      const v = clamp((rowF - (1 - front)) / 0.38 + (d.jit[r * cols + k] - 0.5) * 0.4);
      if (v <= 0.04) continue;
      g.beginPath();
      g.arc((k + 0.5) * cell, (r + 0.5) * cell, v * cell * 0.72, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.fillRect(0, d.c.height - cell * 0.5, d.c.width, cell * 0.5);
}

// ---------------------------------------------------------------- scroll loop
let lenis = null;
let tops = [];
const toned = [...document.querySelectorAll("main > [data-tone], .ft")];
function measure() {
  const y = scrollY;
  tops = toned.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, top: r.top + y, bottom: r.bottom + y };
  });
  for (const d of dissolves) d.top = d.el.getBoundingClientRect().top + y;
  stage.top = stage.getBoundingClientRect().top + y;
  stage.h = stage.offsetHeight;
  keys.top = keys.getBoundingClientRect().top + y;
  keys.h = keys.offsetHeight;
}
const progress = (el, y) => clamp((y - el.top) / Math.max(1, el.h - H));
let lastY = NaN;
let dirty = true;
function update(y) {
  if (motion) {
    if (y < stage.top + stage.h) updateStage(progress(stage, y));
    if (y > keys.top - H && y < keys.top + keys.h) updateKeys(progress(keys, y));
    for (const d of dissolves) {
      const top = d.top - y;
      if (top < H && top > -200) drawDissolve(d, clamp((H * 0.92 - top) / (H * 0.62)));
    }
  }
  // The header takes the tone of whatever is under it.
  const line = y + 32;
  const under = tops.find((t) => line >= t.top && line < t.bottom);
  const tone = under ? (under.el === stage && motion ? stageTone : under.el.dataset.tone) : hd.dataset.tone;
  if (hd.dataset.tone !== tone) hd.dataset.tone = tone;
}
function loop(now) {
  lenis?.raf(now);
  const y = scrollY;
  if (y !== lastY || dirty) {
    lastY = y;
    dirty = false;
    update(y);
  }
  tickBoards(now);
  requestAnimationFrame(loop);
}

const panels = [board, keysPanel];
function layout() {
  sizeStage();
  dissolves.forEach(sizeDissolve);
  if (!motion) dissolves.forEach((d) => drawDissolve(d, 0.5)); // a still halftone edge
  panels.forEach((p) => p.resize());
  measure();
  dirty = true;
}
let rt;
addEventListener("resize", () => {
  clearTimeout(rt);
  rt = setTimeout(layout, 120);
});
document.fonts?.ready.then(() => (measure(), (dirty = true)));
new ResizeObserver(() => (measure(), (dirty = true))).observe(document.body);

if (motion && window.Lenis) {
  lenis = new window.Lenis({ lerp: 0.085, wheelMultiplier: 0.9, smoothWheel: true });
  // In-page links glide instead of jumping.
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    const target = a && a.getAttribute("href").length > 1 && document.querySelector(a.getAttribute("href"));
    if (!target) return;
    e.preventDefault();
    lenis.scrollTo(target, { offset: target.id === "main" ? 0 : -8, duration: 1.4 });
    if (target.id === "main") target.focus?.({ preventScroll: true });
  });
}

layout();
requestAnimationFrame(loop);

// The board's first message types itself in, then the answer comes back. Under five seconds, once.
if (motion) {
  setTimeout(() => {
    if (band <= 0) board.set(HERO_Q);
    setTimeout(() => {
      introDone = true;
      if (band <= 0) {
        band = 0;
        board.set(HERO_A);
      }
    }, 2300);
  }, 450);
} else {
  introDone = true;
  board.set(HERO_A, { instant: true });
  keysPanel.set(KEYS[0], { instant: true });
}

// Headings and leads ease out of a blur when they arrive.
if (motion) {
  const io = new IntersectionObserver(
    (es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))),
    { rootMargin: "0px 0px -12% 0px" },
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
}

// ---------------------------------------------------------------- sound
// Off on every visit. One state for the header switch and the film's: on, the film is unmuted and
// the guard box makes three small sounds.
const soundBtn = document.getElementById("sound");
const filmSound = document.getElementById("film-sound");
const video = document.getElementById("film-video");
const sfx = {};
let soundOn = false;
const play = (name) => {
  if (!soundOn) return;
  sfx[name] ??= Object.assign(new Audio(`/media/sfx/${name}.mp3`), { volume: 0.5 });
  sfx[name].currentTime = 0;
  sfx[name].play().catch(() => {});
};
const setSound = (on) => {
  soundOn = on;
  soundBtn?.setAttribute("aria-pressed", String(on));
  soundBtn?.setAttribute("aria-label", on ? "Sound on" : "Sound off");
  if (filmSound) {
    filmSound.setAttribute("aria-pressed", String(on));
    filmSound.textContent = on ? "Sound on" : "Sound off";
  }
  if (video) video.muted = !on;
  if (on) document.getElementById("film-big")?.setAttribute("hidden", "");
};
for (const b of [soundBtn, filmSound]) {
  if (!b) continue;
  b.hidden = false;
  b.addEventListener("click", () => {
    setSound(!soundOn);
    play("click");
  });
}

// ---------------------------------------------------------------- the film
// A muted preview plays while it is on screen; "Play with sound" starts it over with the narration.
const filmBox = document.getElementById("film-box");
if (filmBox && video) {
  const big = document.getElementById("film-big");
  const playBtn = document.getElementById("film-play");
  const cc = document.getElementById("film-cc");
  const chapters = [...filmBox.querySelectorAll(".chapters button")];
  video.removeAttribute("controls");
  video.muted = true;
  document.getElementById("film-bar").hidden = false;
  big.hidden = false;
  const track = video.textTracks[0];
  if (track) track.mode = "hidden";

  let wanted = !reduce; // reduced motion: nothing plays until asked
  let visible = false;
  const sync = () => {
    const run = wanted && visible && document.visibilityState === "visible";
    if (run && video.paused) video.play().catch(() => {});
    if (!run && !video.paused) video.pause();
  };
  let raf = 0;
  const tick = () => {
    const t = video.currentTime;
    for (const b of chapters) {
      const a = Number(b.dataset.t);
      const z = Number(b.dataset.end);
      b.style.setProperty("--p", clamp((t - a) / (z - a)).toFixed(3));
      b.setAttribute("aria-current", String(t >= a && t < z));
    }
    raf = video.paused ? 0 : requestAnimationFrame(tick);
  };
  video.addEventListener("play", () => {
    filmBox.classList.add("playing");
    playBtn.setAttribute("aria-label", "Pause film");
    raf ||= requestAnimationFrame(tick);
  });
  video.addEventListener("pause", () => {
    filmBox.classList.remove("playing");
    playBtn.setAttribute("aria-label", "Play film");
  });
  video.addEventListener("seeked", tick);
  playBtn.addEventListener("click", () => {
    wanted = video.paused;
    if (wanted) video.play().catch(() => {});
    else video.pause();
  });
  big.addEventListener("click", () => {
    setSound(true);
    wanted = true;
    video.currentTime = 0;
    video.play().catch(() => {});
  });
  chapters.forEach((b) =>
    b.addEventListener("click", () => {
      video.currentTime = Number(b.dataset.t);
      wanted = true;
      video.play().catch(() => {});
    }),
  );
  cc.addEventListener("click", () => {
    const on = cc.getAttribute("aria-pressed") !== "true";
    cc.setAttribute("aria-pressed", String(on));
    if (track) track.mode = on ? "showing" : "hidden";
  });
  new IntersectionObserver(([e]) => ((visible = e.isIntersecting), sync()), { threshold: 0.35 }).observe(filmBox);
  document.addEventListener("visibilitychange", sync);
}

// ---------------------------------------------------------------- the guard board
const probe = document.getElementById("probe");
if (probe) {
  const text = document.getElementById("probe-text");
  const verdict = document.getElementById("verdict");
  const ms = document.getElementById("probe-ms");
  const send = document.getElementById("probe-send");
  const panel = new Panel(document.getElementById("guard-panel"));
  panels.push(panel);
  panel.resize();
  probe.querySelector(".samples").hidden = false;
  probe.querySelector(".probe-foot").hidden = false;

  let guard = null;
  const load = () => (guard ??= import("/guard-demo.js"));
  const LABEL = { delivered: "Delivered.", masked: "Masked, then delivered.", held: "Held for review." };
  const AFTER = {
    delivered: "Nothing sensitive, so it reaches Riley’s agent right away.",
    masked: "The rest is delivered; the key never reaches Riley’s agent.",
    held: "Riley releases or rejects it on the dashboard’s Review page.",
  };
  const BOARD = { delivered: ["DELIVERED ~", "blue"], masked: ["MASKED + SENT", "blue"], held: ["HELD FOR REVIEW", "amber"] };

  // Wrap the checked message into three board rows, flagged words in amber, masked ones as dots.
  const rows = (r) => {
    const chars = [...r.text].map((ch, i) => {
      const s = r.spans.find((x) => i >= x.start && i < x.end);
      return s?.kind === "masked" ? ["•", "blue"] : [ch === "\n" ? " " : ch, s ? "amber" : "white"];
    });
    const lines = [[]];
    let word = [];
    const flush = () => {
      // Words move to the next row whole; a word longer than a row (a key, a URL) is cut across rows.
      while (word.length) {
        let cur = lines[lines.length - 1];
        if (cur.length + (cur.length ? 1 : 0) + Math.min(word.length, 15) > 15) lines.push((cur = []));
        if (cur.length) cur.push([" ", "white"]);
        cur.push(...word.splice(0, 15 - cur.length));
      }
    };
    for (const c of chars) c[0] === " " ? flush() : word.push(c);
    flush();
    const out = lines.filter((l) => l.length).slice(0, 4);
    if (out.length > 3) out.length = 3, out[2] = [...out[2].slice(0, 12), [".", "white"], [".", "white"], [".", "white"]];
    while (out.length < 3) out.push([]);
    return out.map((l) => [l.map((c) => c[0]).join(""), l.map((c) => c[1])]);
  };

  let busyCheck = false;
  const run = async (opts = {}) => {
    const message = text.value.trim();
    if (!message || busyCheck) return;
    busyCheck = true;
    send.setAttribute("aria-busy", "true");
    try {
      const { check } = await load();
      const r = check(message);
      if (!opts.silent) play("send");
      panel.set([["THEO-CODEX >", "dim"], ...rows(r), [""]], { instant: opts.instant });
      const b = Object.assign(document.createElement("b"), { textContent: LABEL[r.verdict] });
      b.dataset.v = r.verdict;
      verdict.replaceChildren(b, ` ${r.reasons.length ? `${r.reasons.join(". ")}. ` : ""}${AFTER[r.verdict]}`);
      ms.textContent = `Checked in ${r.ms < 1 ? r.ms.toFixed(2) : r.ms.toFixed(1)} ms in this browser`;
      setTimeout(
        () => {
          panel.strips[4].set(...BOARD[r.verdict]);
          if (!opts.silent) play(r.verdict === "held" ? "held" : "deliver");
        },
        opts.instant ? 0 : 650,
      );
    } catch {
      verdict.textContent = "The guard check could not load. Reload the page to try again.";
    } finally {
      busyCheck = false;
      send.removeAttribute("aria-busy");
    }
  };
  probe.addEventListener("submit", (e) => {
    e.preventDefault();
    run();
  });
  for (const b of probe.querySelectorAll(".sample")) {
    b.addEventListener("click", () => {
      text.value = b.textContent;
      run();
    });
  }
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  });
  // The first message runs by itself when the box comes into view.
  const seen = new IntersectionObserver(([e]) => e.isIntersecting && (seen.disconnect(), run({ silent: true, instant: !motion })), { threshold: 0.35 });
  seen.observe(document.getElementById("guard-panel"));
}

// ---------------------------------------------------------------- the last board
const closeEl = document.getElementById("close-panel");
if (closeEl) {
  const closePanel = new Panel(closeEl);
  panels.push(closePanel);
  closePanel.resize();
  const LINES = [["SESSION READY", "blue"], [""], ["SEND THE LINK"], ["TO THEO"], [""]];
  if (!motion) closePanel.set(LINES, { instant: true });
  else new IntersectionObserver(([e], o) => e.isIntersecting && (o.disconnect(), closePanel.set(LINES)), { threshold: 0.5 }).observe(closeEl);
}

// ---------------------------------------------------------------- code tabs and copy
const code = document.getElementById("code");
if (code) {
  const tabs = [...code.querySelectorAll('[role="tab"]')];
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (step) select(tabs[(i + step + tabs.length) % tabs.length], true);
    });
  });
  const copy = code.querySelector("[data-copy-panel]");
  if (copy && navigator.clipboard) {
    copy.hidden = false;
    let t;
    copy.addEventListener("click", async () => {
      const shown = code.querySelector('[role="tabpanel"]:not([hidden])');
      try {
        await navigator.clipboard.writeText(shown.textContent.trim());
        copy.textContent = "Copied";
        copy.classList.add("done");
      } catch {
        getSelection()?.selectAllChildren(shown);
        copy.textContent = "Press Ctrl+C";
      }
      clearTimeout(t);
      t = setTimeout(() => ((copy.textContent = "Copy"), copy.classList.remove("done")), 1800);
    });
  }
}

// ---------------------------------------------------------------- download for this OS
// Windows gets the installer straight from the header; Mac and Linux go to the waitlist, set to their OS.
const ua = navigator.userAgent;
const mac = /Mac OS X|Macintosh/.test(ua) && !/iPhone|iPad/.test(ua);
const linux = /Linux/.test(ua) && !/Android/.test(ua);
if (mac || linux) {
  document.getElementById("hd-dl")?.setAttribute("href", "#download");
  const radio = document.querySelector(`.seg input[value="${mac ? "mac" : "linux"}"]`);
  if (radio) radio.checked = true;
}

// ---------------------------------------------------------------- the waitlist and The Relay
// Both post to the same list; the source tells the relay which email to send.
function signup(form, { source, ok, already }) {
  if (!form) return;
  const email = form.querySelector('input[type="email"]');
  const msg = form.querySelector(".news-msg");
  const button = form.querySelector('button[type="submit"]');
  const say = (t, kind) => {
    msg.textContent = t;
    msg.className = `news-msg ${kind}`;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return say("Enter an email address like you@company.com.", "bad");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const res = await fetch("/news/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.value.trim(), source: source() }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "That didn’t go through. Check your connection and try again.");
      say(data.already ? already() : ok(), "ok");
      email.value = "";
    } catch (err) {
      say(err.message, "bad");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });
}
const waitOs = () => document.querySelector(".seg input:checked")?.value ?? "mac";
const osName = () => (waitOs() === "linux" ? "Linux" : "Mac");
signup(document.getElementById("wait-form"), {
  source: () => `waitlist-${waitOs()}`,
  ok: () => `You’re on the list. We’ll email you when the ${osName()} build is ready.`,
  already: () => `You’re already on the ${osName()} waitlist.`,
});
signup(document.getElementById("news-form"), {
  source: () => "home",
  ok: () => "You’re in. A welcome note is on its way.",
  already: () => "You’re already subscribed.",
});

// ---------------------------------------------------------------- the footer mark lights up
const ftMark = document.getElementById("ft-mark");
if (ftMark && motion) new IntersectionObserver(([e], o) => e.isIntersecting && (o.disconnect(), ftMark.classList.add("in")), { threshold: 0.4 }).observe(ftMark);
