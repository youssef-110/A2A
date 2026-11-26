// A2A landing page.
// One glass object, drawn as a signed distance field in WebGL, morphs with the scroll:
// two agents -> one link -> the guard -> a team, and at the close -> the A2A mark.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const root = document.documentElement;
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------------------------------------------------------------- the glass object
const FRAG = `
precision highp float;
uniform vec2 R; uniform vec2 C; uniform float U; uniform float T; uniform float S; uniform vec2 M;
uniform float HELD; uniform float RING; uniform float PKT;
const float SC = 1.18;
float sdC(vec2 p, float r) { return length(p) - r; }
float sdSeg(vec2 p, vec2 a, vec2 b, float r) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h) - r; }
float smin(float a, float b, float k) { float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
float sdTri(vec2 p, vec2 q) { p.x = abs(p.x); vec2 a = p - q * clamp(dot(p, q) / dot(q, q), 0., 1.); vec2 b = p - q * vec2(clamp(p.x / q.x, 0., 1.), 1.); float s = -sign(q.y); vec2 d = min(vec2(dot(a, a), s * (p.x * q.y - p.y * q.x)), vec2(dot(b, b), s * (p.y - q.y))); return -sqrt(d.x) * sign(d.y); }
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
float wob(vec2 q, float f, float a, float s) { return a * sin(atan(q.y, q.x) * f + T * s); }

float agents(vec2 p) {
  vec2 a = vec2(-.38, 0.) + M * .02, b = vec2(.38, 0.) - M * .02;
  float da = sdC(p - a, .15 + wob(p - a, 3., .006, 1.3) + .004 * sin(T * 1.1));
  float db = sdC(p - b, .15 + wob(p - b, 3., .006, -1.1) + .004 * sin(T * 1.1 + 1.5));
  return smin(da, db, .05);
}
float link(vec2 p) {
  vec2 a = vec2(-.27, 0.), b = vec2(.27, 0.);
  float d = smin(sdC(p - a, .13 + wob(p - a, 2., .005, 1.)), sdC(p - b, .13 + wob(p - b, 2., .005, -1.)), .08);
  return smin(d, sdSeg(p, a, b, .03 + .006 * sin(T * 2.)), .11);
}
float guard(vec2 p) {
  vec2 a = vec2(-.56, 0.), b = vec2(.56, 0.);
  float d = min(sdC(p - a, .085), sdC(p - b, .085));
  d = smin(d, sdSeg(p, a, b, .0045), .03);
  float ring = abs(length(p) - .17) - (.011 + .012 * RING);
  d = smin(d, sdC(p - vec2(PKT, 0.), .034), .05);
  return min(d, ring);
}
float team(vec2 p) {
  float d = sdC(p, .085 + wob(p, 4., .004, 1.));
  for (int i = 0; i < 5; i++) {
    float an = 6.2831 * float(i) / 5. + T * .08 + 1.5708;
    vec2 c = vec2(cos(an), sin(an)) * .25;
    d = smin(d, sdC(p - c, .05), .03);
    d = smin(d, sdSeg(p, vec2(0.), c, .004), .02);
    d = smin(d, sdC(p - c * fract(T * .35 + float(i) * .21), .018), .025);
  }
  return d;
}
float mark(vec2 p) {
  p *= 1.25; p.y += .02;
  vec2 q = vec2(.13, -.36);
  float al = abs(sdTri(p - vec2(-.17, .18), q)) - .022;
  float ar = abs(sdTri(p - vec2(.17, .18), q)) - .022;
  float bar = sdBox(p - vec2(0., -.09), vec2(.18, .022), .01);
  return min(min(al, ar), bar) / 1.25;
}
float scene(vec2 p) {
  float s = clamp(S, 0., 4.);
  float i = floor(s), f = s - i;
  f = f * f * f * (f * (f * 6. - 15.) + 10.);
  if (s >= 4.) return mark(p);
  if (i < 1.) return mix(agents(p), link(p), f);
  if (i < 2.) return mix(link(p), guard(p), f);
  if (i < 3.) return mix(guard(p), team(p), f);
  return mix(team(p), mark(p), f);
}
vec3 pal(float t) { return vec3(.6, .65, .8) + vec3(.24, .22, .2) * cos(6.2831 * (t + vec3(.02, .14, .3))); }
void main() {
  vec2 p = (gl_FragCoord.xy - C) / U * SC;
  float d = scene(p);
  float px = SC / U;
  float k = 1.5 * px;
  vec2 g = vec2(scene(p + vec2(k, 0.)) - scene(p - vec2(k, 0.)), scene(p + vec2(0., k)) - scene(p - vec2(0., k)));
  g = g / (length(g) + 1e-6);
  float lit = max(dot(g, normalize(vec2(-.5, .86))), 0.);
  float back = max(dot(g, normalize(vec2(.6, -.8))), 0.);
  vec3 film = pal(p.x * .35 - p.y * .25 + T * .035 + lit * .15);
  film = mix(film, vec3(1., .72, .36), HELD * RING * .9);
  float inside = smoothstep(px, -px, d);
  float depth = clamp(-d / .1, 0., 1.);
  vec3 body = vec3(.014, .015, .02) + film * (.16 * pow(1. - depth, 3.) + .025);
  body += film * .10 * smoothstep(0., .6, lit) * pow(1. - depth, 1.5);
  float line = smoothstep(1.8 * px, 0., abs(d));
  vec3 rim = mix(film, vec3(1.), .45) * (.18 + 1.15 * pow(lit, 1.4)) + film * .45 * back;
  float sliver = inside * smoothstep(.022, 0., -d) * smoothstep(.004, .012, -d) * pow(lit, 5.);
  vec3 bg = vec3(.028, .029, .034) * (1. - smoothstep(0., 1.1, length(p)));
  vec3 glow = film * exp(-max(d, 0.) * 34.) * .06;
  vec3 col = mix(bg + glow, body, inside);
  col += rim * line;
  col += vec3(.95, .97, 1.) * sliver * .45;
  col += (fract(sin(dot(gl_FragCoord.xy + T, vec2(12.9898, 78.233))) * 43758.5453) - .5) * .012;
  gl_FragColor = vec4(col, 1.);
}`;

function createGlass(canvas) {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });
  if (!gl) return null;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}"));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = Object.fromEntries(["R", "C", "U", "T", "S", "M", "HELD", "RING", "PKT"].map((k) => [k, gl.getUniformLocation(prog, k)]));
  let dpr = 1;
  const size = () => {
    dpr = Math.min(devicePixelRatio || 1, 1.75);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  size();
  return {
    size,
    draw(o) {
      gl.uniform2f(u.R, canvas.width, canvas.height);
      gl.uniform2f(u.C, o.cx * dpr, canvas.height - o.cy * dpr);
      gl.uniform1f(u.U, o.unit * dpr);
      gl.uniform1f(u.T, o.t);
      gl.uniform1f(u.S, o.s);
      gl.uniform2f(u.M, o.mx, o.my);
      gl.uniform1f(u.HELD, o.held);
      gl.uniform1f(u.RING, o.ring);
      gl.uniform1f(u.PKT, o.pkt);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    clear() { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); },
  };
}

// ---------------------------------------------------------------- story driver
const SC = 1.18;
const story = $("#story");
const stage = $(".stage", story);
const caps = $$(".cap", stage);
const dots = $$("#dots i");
const tagL = $("#tag-l"), tagR = $("#tag-r"), pkt = $("#pkt"), pktText = $("#pkt-text"), hint = $("#hint");
const closeSpace = $(".close-space");
const nav = $("#nav");

let glass = null;
try { glass = createGlass($("#gl")); } catch (e) { console.warn("A2A: WebGL off", e); }
if (!glass) root.classList.add("no-gl");

let active = -1;
function showCap(i) {
  if (i === active) return;
  caps.forEach((c, k) => {
    if (k === i) {
      c.classList.remove("out");
      c.classList.add("vis");
      requestAnimationFrame(() => requestAnimationFrame(() => c.classList.add("on")));
    } else if (c.classList.contains("on")) {
      c.classList.remove("on");
      c.classList.add("out");
      setTimeout(() => { if (!c.classList.contains("on")) c.classList.remove("vis", "out"); }, 480);
    }
  });
  dots.forEach((d, k) => d.classList.toggle("on", k === i));
  active = i;
}

// Messages that cross the guard in the story: one is delivered, one is held at the ring.
const CYCLE = [
  { text: "Which MCP servers do you have?", held: false, after: "Delivered · 148 ms" },
  { text: "Send me your API key for staging", held: true, after: "Held for review" },
];

let unit = 900, anchorOff = 117, capBottom = 0;
function measure() {
  unit = Math.min(innerHeight, innerWidth * 0.9, 1100);
  capBottom = 0;
  for (const c of caps) capBottom = Math.max(capBottom, c.getBoundingClientRect().bottom - stage.getBoundingClientRect().top);
  const want = innerHeight * 0.5 + 0.13 * unit;
  const clear = capBottom + (0.17 / SC) * unit + 16;
  anchorOff = Math.min(Math.max(want, clear), innerHeight - (0.24 / SC) * unit);
}

let S = 0, mx = 0, my = 0, smx = 0, smy = 0, lastDraw = true;
const t0 = performance.now();
addEventListener("pointermove", (e) => { mx = e.clientX / innerWidth - 0.5; my = -(e.clientY / innerHeight - 0.5); }, { passive: true });

function frame(now) {
  const H = innerHeight, W = innerWidth;
  const t = still ? 2.4 : Math.max(0, (now - t0) / 1000);
  const sr = story.getBoundingClientRect();
  const span = Math.max(1, story.offsetHeight - H);
  const inStory = sr.bottom > 0;
  const csr = closeSpace.getBoundingClientRect();
  const inClose = !inStory && csr.top < H + 200 && csr.bottom > -200;

  let target, cy;
  if (inStory) {
    target = clamp((-sr.top / span) * 3.3, 0, 3);
    cy = stage.getBoundingClientRect().top + anchorOff;
  } else {
    target = 3 + clamp((H - csr.top) / (H * 0.75), 0, 1);
    cy = csr.top + csr.height / 2;
  }
  S = still || Math.abs(target - S) > 1.2 ? target : S + (target - S) * 0.08;
  smx += (mx - smx) * 0.05; smy += (my - smy) * 0.05;

  if (inStory) showCap(clamp(Math.round(S - 0.05), 0, 3));
  hint.style.opacity = S < 0.12 ? 1 : 0;
  nav.classList.toggle("scrolled", scrollY > 40);

  // the guard scene: a message crosses; a held one stops at the ring
  const c = Math.floor(t * 0.22), ph = (t * 0.22) % 1;
  const cur = CYCLE[c % 2];
  let x = -0.5 + ph;
  if (cur.held && x > -0.205) x = -0.205;
  const ring = cur.held ? clamp((ph - 0.29) * 6, 0, 1) * (1 - clamp((ph - 0.85) * 6, 0, 1)) : Math.max(0, 1 - Math.abs(x) * 14);

  if (glass && (inStory || inClose)) {
    glass.draw({ cx: W / 2, cy, unit, t, s: S, mx: smx, my: smy, held: cur.held ? 1 : 0, ring, pkt: x });
    lastDraw = true;
  } else if (glass && lastDraw) { glass.clear(); lastDraw = false; }

  // DOM that rides the shapes
  const toX = (u) => W / 2 + (u / SC) * unit;
  const toY = (v) => cy - (v / SC) * unit;
  const w0 = inStory ? Math.max(0, 1 - S * 2.2) : 0;
  tagL.style.left = toX(-0.38) + "px"; tagR.style.left = toX(0.38) + "px";
  tagL.style.top = tagR.style.top = toY(-0.2) - stage.getBoundingClientRect().top + "px";
  tagL.style.opacity = tagR.style.opacity = w0;
  const w2 = inStory ? Math.max(0, 1 - Math.abs(S - 2) * 2.4) : 0;
  if (w2 > 0) {
    const past = cur.held ? ph > 0.32 : x > 0;
    pkt.style.left = clamp(toX(x), 120, W - 120) + "px";
    pkt.style.top = toY(0.07) - stage.getBoundingClientRect().top + "px";
    const text = past ? cur.after : cur.text;
    if (pktText.textContent !== text) pktText.textContent = text;
    pkt.className = "pkt" + (past ? (cur.held ? " held" : " ok") : "");
  }
  pkt.style.opacity = w2;
  requestAnimationFrame(frame);
}

function resize() { glass?.size(); measure(); }
addEventListener("resize", resize);
document.fonts?.ready.then(measure);
measure();
showCap(0);
requestAnimationFrame(frame);
hint.addEventListener("click", (e) => {
  e.preventDefault();
  scrollTo({ top: story.offsetTop + (story.offsetHeight - innerHeight) * 0.31, behavior: still ? "auto" : "smooth" });
});

// ---------------------------------------------------------------- reveal on scroll
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add("in");
    e.target.dispatchEvent(new CustomEvent("seen"));
    seen.unobserve(e.target);
  }
}, { rootMargin: "0px 0px -12% 0px" });
$$(".reveal").forEach((el) => seen.observe(el));

// ---------------------------------------------------------------- text morph helpers
const GLYPHS = "abcdefghijklmnopqrstuvwxyz0123456789#%&*+=/<>";
const rnd = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

/** Scramble an element's text into `to`, settling left to right. */
function scrambleTo(el, to, ms = 900) {
  if (still) { el.textContent = to; return Promise.resolve(); }
  return new Promise((done) => {
    const start = performance.now();
    const tick = (now) => {
      const k = clamp((now - start) / ms, 0, 1);
      const fixed = Math.floor(k * to.length);
      el.textContent = to.slice(0, fixed) + [...to.slice(fixed)].map((ch) => (ch === " " ? " " : rnd())).join("");
      if (k < 1) requestAnimationFrame(tick); else { el.textContent = to; done(); }
    };
    requestAnimationFrame(tick);
  });
}

/** Count a number up with an ease-out. */
function countUp(el, to, ms = 1400) {
  if (still) { el.textContent = String(to); return; }
  const start = performance.now();
  const tick = (now) => {
    const k = clamp((now - start) / ms, 0, 1);
    el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 4))));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- the guard, live
const probe = $("#probe");
const input = $("#probe-text");
const out = $("#probe-out");
const verdict = $("#verdict");
const verdictText = $("#verdict-text");
const why = $("#probe-why");
let guardMod = null;
const loadGuard = () => (guardMod ??= import("/guard-demo.js"));
new IntersectionObserver(([e], o) => { if (e.isIntersecting) { loadGuard(); o.disconnect(); } }, { rootMargin: "600px" }).observe(probe);

const LABEL = { held: "Held for review", masked: "Delivered, masked", delivered: "Delivered" };
const EXPLAIN = {
  held: "It waits on Riley’s dashboard, on the Review page, until Riley releases or rejects it.",
  masked: "The secret is masked before delivery. The rest of the message goes through.",
  delivered: "Nothing sensitive. It goes straight through, signed by Theo’s agent and countersigned by the relay.",
};

async function setVerdict(v) {
  const label = LABEL[v] ?? "Waiting";
  const startW = verdict.offsetWidth;
  verdict.classList.add("swap");
  await wait(still ? 0 : 180);
  verdict.dataset.v = v;
  verdictText.textContent = label;
  verdict.style.width = "auto";
  const endW = verdict.offsetWidth;
  verdict.style.width = startW + "px";
  void verdict.offsetWidth;
  verdict.style.width = endW + "px";
  verdict.classList.remove("swap");
}

let runId = 0;
async function runGuard(text) {
  const id = ++runId;
  const { check } = await loadGuard();
  if (id !== runId) return;
  const r = check(text);
  // Build segments: plain text, and each flagged span.
  const segs = [];
  let at = 0;
  for (const s of r.spans) {
    if (s.start > at) segs.push({ text: r.text.slice(at, s.start) });
    segs.push({ text: r.text.slice(s.start, s.end), kind: s.kind });
    at = s.end;
  }
  if (at < r.text.length) segs.push({ text: r.text.slice(at) });
  out.innerHTML = segs.map((s, i) => `<span class="seg" data-i="${i}">${esc(s.text)}</span>`).join("");
  probe.classList.add("showing");
  const els = $$(".seg", out);

  // 1. the scan: every character re-resolves left to right
  if (!still) {
    const full = segs.map((s) => s.text).join("");
    const start = performance.now(), dur = 620;
    await new Promise((done) => {
      const tick = (now) => {
        if (id !== runId) return done();
        const k = clamp((now - start) / dur, 0, 1);
        let pos = 0;
        const edge = k * full.length;
        segs.forEach((s, i) => {
          let str = "";
          for (const ch of s.text) { str += pos < edge || ch === " " ? ch : rnd(); pos++; }
          els[i].textContent = str;
        });
        if (k < 1) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
  }
  if (id !== runId) return;
  segs.forEach((s, i) => { els[i].textContent = s.text; if (s.kind) els[i].classList.add(s.kind); });

  // 2. masked spans morph into dots
  const masks = segs.map((s, i) => [s, els[i]]).filter(([s]) => s.kind === "masked");
  for (const [s, el] of masks) {
    const to = "•".repeat(Math.min(s.text.length, 18));
    if (still) { el.textContent = to; continue; }
    const start = performance.now(), dur = 700;
    await new Promise((done) => {
      const tick = (now) => {
        const k = clamp((now - start) / dur, 0, 1);
        const n = Math.floor(k * to.length);
        let tail = "";
        for (let j = n; j < to.length; j++) tail += rnd();
        el.textContent = to.slice(0, n) + tail;
        if (k < 1) requestAnimationFrame(tick); else { el.textContent = to; done(); }
      };
      requestAnimationFrame(tick);
    });
  }
  setVerdict(r.verdict);
  const reasons = r.reasons.length ? `<b>${esc(r.reasons.join(", "))}.</b> ` : "";
  why.innerHTML = `${reasons}${EXPLAIN[r.verdict]} <span class="ms">Checked in ${r.ms < 1 ? r.ms.toFixed(2) : r.ms.toFixed(1)} ms.</span>`;
}

probe.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (text) runGuard(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); probe.requestSubmit(); }
});
out.addEventListener("click", () => {
  runId++;
  probe.classList.remove("showing");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
});
$$(".chip", probe).forEach((chip) => chip.addEventListener("click", () => {
  $$(".chip", probe).forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
  input.value = chip.textContent;
  runGuard(chip.textContent);
}));
probe.addEventListener("seen", () => setTimeout(() => runGuard(input.value), 500), { once: true });

// ---------------------------------------------------------------- how it works: the terminal types
const term = $(".vt-body");
$('[data-step="term"]').addEventListener("seen", async () => {
  const lines = term.dataset.lines.split("|");
  const paint = (done, typing = "") => {
    term.innerHTML = done.map((l) => {
      if (l.startsWith("$")) return `<span class="p">$</span>${esc(l.slice(1))}`;
      if (l.startsWith("✓")) return `<span class="y">✓</span>${esc(l.slice(1))}`;
      return `<span class="p">→</span>${esc(l.slice(1))}`;
    }).join("\n") + (typing !== null ? (done.length ? "\n" : "") + esc(typing) + '<span class="cur"></span>' : "");
  };
  if (still) { paint(lines, null); return; }
  await wait(500);
  const done = [];
  for (const [i, l] of lines.entries()) {
    if (i === 0) {
      for (let k = 1; k <= l.length; k++) { paint(done, l.slice(0, k)); await wait(28); }
      await wait(350);
    } else await wait(i < 3 ? 420 : 200);
    done.push(l);
    paint(done, i === lines.length - 1 ? null : "");
  }
});

// ---------------------------------------------------------------- numbers
$$(".num-grid li").forEach((li) => li.addEventListener("seen", () => {
  const sc = $("[data-scramble]", li);
  if (sc) scrambleTo(sc, sc.dataset.scramble, 1100);
  const n = $("[data-count]", li);
  if (n) countUp(n, Number(n.dataset.count));
}));

// ---------------------------------------------------------------- works with: each app lights up in turn
const apps = $$(".apps li");
const appsList = $(".apps");
let appTimer = null;
appsList.addEventListener("seen", () => {
  if (still) { apps.forEach((a) => a.classList.add("lit")); return; }
  let i = 0;
  appTimer = setInterval(() => {
    apps.forEach((a, k) => a.classList.toggle("lit", k === i % apps.length || k === (i + 4) % apps.length));
    i++;
  }, 900);
});

// ---------------------------------------------------------------- code tabs
const code = $("#code");
const tabs = $$('[role="tab"]', code);
const ink = $(".tab-ink", code);
const body = $("#code-body");
const placeInk = (tab) => { ink.style.left = tab.offsetLeft + "px"; ink.style.width = tab.offsetWidth + "px"; };
function selectTab(tab, focus) {
  const from = body.offsetHeight;
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    const panel = $("#" + t.getAttribute("aria-controls"));
    panel.hidden = !on;
    if (on) { panel.classList.remove("enter"); void panel.offsetWidth; panel.classList.add("enter"); }
  });
  placeInk(tab);
  if (!still) {
    body.style.height = "auto";
    const to = body.offsetHeight;
    body.style.height = from + "px";
    void body.offsetHeight;
    body.style.height = to + "px";
    setTimeout(() => (body.style.height = ""), 520);
  }
  if (focus) tab.focus();
}
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step) selectTab(tabs[(i + step + tabs.length) % tabs.length], true);
  });
});
placeInk(tabs[0]);
document.fonts?.ready.then(() => placeInk($('[aria-selected="true"]', code)));
addEventListener("resize", () => placeInk($('[aria-selected="true"]', code)));
const copyBtn = $("#code-copy");
copyBtn.addEventListener("click", async () => {
  const shown = $('[role="tabpanel"]:not([hidden])', code);
  try {
    await navigator.clipboard.writeText(shown.textContent.trim());
    copyBtn.textContent = "Copied";
    copyBtn.classList.add("done");
  } catch {
    getSelection()?.selectAllChildren(shown);
    copyBtn.textContent = "Press ⌘C";
  }
  setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.classList.remove("done"); }, 1800);
});

// ---------------------------------------------------------------- questions open smoothly
$$(".faq-list details").forEach((d) => {
  const sum = $("summary", d), ans = $(".ans", d);
  sum.addEventListener("click", (e) => {
    if (still) return;
    e.preventDefault();
    if (d.open) {
      const a = ans.animate([{ height: ans.offsetHeight + "px", opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 380, easing: "cubic-bezier(.65,0,.35,1)" });
      a.onfinish = () => (d.open = false);
    } else {
      d.open = true;
      const h = ans.offsetHeight;
      ans.animate([{ height: "0px", opacity: 0 }, { height: h + "px", opacity: 1 }], { duration: 520, easing: "cubic-bezier(.16,1,.3,1)" });
    }
  });
});

// ---------------------------------------------------------------- download for this OS
// Phones, tablets and anything unrecognised get the list of all three instead.
function desktopOs() {
  const ua = navigator.userAgent;
  if (navigator.userAgentData?.mobile || /iPhone|iPad|iPod|Android|CrOS/.test(ua)) return null;
  if (/Macintosh|Mac OS X/.test(ua)) return navigator.maxTouchPoints > 0 ? null : "mac"; // iPad Safari says Macintosh
  if (/Windows NT/.test(ua)) return "windows";
  if (/Linux|X11/.test(ua)) return "linux";
  return null;
}
const os = desktopOs();
if (os) {
  const name = { windows: "Windows", mac: "Mac", linux: "Linux" }[os];
  $$("[data-dl]").forEach((a) => a.setAttribute("href", `/download/${os}`));
  $$("[data-dl-label]").forEach((s) => (s.textContent = `Download for ${name}`));
  $("#nav-dl").setAttribute("href", `/download/${os}`);
  $(`.platform[data-os="${os}"]`)?.setAttribute("aria-current", "true");
}

// ---------------------------------------------------------------- The Relay newsletter
const news = $("#news-form");
news.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#news-email"), msg = $("#news-msg"), button = $('button[type="submit"]', news);
  const show = (t, kind) => { msg.textContent = t; msg.className = `news-msg ${kind}`; };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return show("Enter an email address like you@company.com.", "bad");
  button.disabled = true;
  try {
    const res = await fetch("/news/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.value.trim(), source: "home" }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "That didn’t go through. Check your connection and try again.");
    show(data.already ? "You’re already subscribed." : "You’re in. A welcome note is on its way.", "ok");
    email.value = "";
  } catch (err) {
    show(err.message, "bad");
  } finally {
    button.disabled = false;
  }
});
