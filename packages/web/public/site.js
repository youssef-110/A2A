// A2A landing page. One rAF loop drives everything that follows the scroll: Lenis smoothing, the
// header, the hero type spreading apart, the statement lighting word by word, the pinned stack of
// three cards, the film growing to full width, both marquees and the footer mark. Each scene is a
// pure function of scroll position, so it runs backwards as well as forwards. The hero's field of
// relay dots has its own loop while it is on screen. With reduced motion nothing is pinned, smoothed
// or moved, and every word is simply there.
import { ping, Ping } from "/ping.js";

const root = document.documentElement;
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const motion = !reduce && "IntersectionObserver" in window;
root.classList.add("js-ok");
if (motion) root.classList.add("motion", "ready");
else root.classList.remove("motion", "ready", "intro-on");

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const outExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
const outCubic = (t) => 1 - (1 - t) ** 3;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;

// ---------------------------------------------------------------- sound (off on every visit)
const sfx = {};
let soundOn = false;
const play = (name) => {
  if (!soundOn) return;
  sfx[name] ??= Object.assign(new Audio(`/media/sfx/${name}.mp3`), { volume: 0.45 });
  sfx[name].currentTime = 0;
  sfx[name].play().catch(() => {});
};
const SOUND = { sent: "send", received: "deliver", done: "deliver", joined: "click", held: "held", blocked: "held", error: "held" };
const say = (m) => {
  ping.say(m);
  play(SOUND[m.kind] ?? "click");
};

// ---------------------------------------------------------------- words
/** Wrap every word of an element in a mask and a moving span, keeping inline elements and <br>. */
function splitWords(el, cls = "w") {
  let i = 0;
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const parts = child.textContent.split(/(\s+)/);
        const frag = document.createDocumentFragment();
        for (const part of parts) {
          if (!part) continue;
          if (/^\s+$/.test(part)) frag.append(" ");
          else if (cls === "w") {
            const m = document.createElement("span");
            m.className = "wm";
            const w = document.createElement("span");
            w.className = "w";
            w.style.setProperty("--i", i++);
            w.textContent = part;
            m.append(w);
            frag.append(m);
          } else {
            const w = document.createElement("span");
            w.className = cls;
            w.textContent = part;
            frag.append(w);
            i++;
          }
        }
        child.replaceWith(frag);
      } else if (child.nodeType === 1 && child.tagName !== "BR" && !child.classList.contains("inline-ping")) walk(child);
      else if (child.nodeType === 1 && child.classList.contains("inline-ping") && cls !== "w") child.classList.add(cls), i++;
    }
  };
  walk(el);
  return i;
}

if (motion) {
  $$(".split").forEach((el) => splitWords(el));
  $$(".hero .hl .w").forEach((w, i) => w.style.setProperty("--i", i));
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { rootMargin: "0px 0px -14% 0px" });
  $$(".split").forEach((el) => io.observe(el));
}

// ---------------------------------------------------------------- intro, then the hero arrives
const hero = $("#top");
let heroInAt = 0;
function heroIn() {
  hero.classList.add("in");
  heroInAt = performance.now();
}
if (motion && root.classList.contains("intro-on")) {
  const intro = $("#intro");
  const count = $("#intro-count");
  const t0 = performance.now();
  const ready = Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 900))]);
  $(".intro-mark").animate([{ opacity: 0, transform: "translateY(14px) scale(.92)", filter: "blur(6px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 700, easing: "cubic-bezier(.16,1,.3,1)", fill: "both" });
  const tick = () => {
    const p = clamp((performance.now() - t0) / 750);
    count.textContent = String(Math.round(outCubic(p) * 100)).padStart(2, "0");
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  ready.then(() => {
    const wait = Math.max(0, 820 - (performance.now() - t0));
    setTimeout(() => {
      try {
        sessionStorage.setItem("a2a-intro", "1");
      } catch {}
      const lift = intro.animate([{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 100% 0)" }], { duration: 900, easing: "cubic-bezier(.76,0,.24,1)", fill: "forwards" });
      $(".intro-mark").animate([{ transform: "none" }, { transform: "translateY(-40px)", opacity: 0 }], { duration: 600, easing: "cubic-bezier(.76,0,.24,1)", fill: "forwards" });
      setTimeout(heroIn, 280);
      lift.finished.then(() => root.classList.remove("intro-on"));
    }, wait);
  });
} else if (motion) {
  Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 500))]).then(() => requestAnimationFrame(heroIn));
} else heroIn();

// ---------------------------------------------------------------- the hero field: relay dots and packets
const field = (() => {
  const c = $("#field");
  if (!c) return null;
  const g = c.getContext("2d");
  const GAP = 26;
  let w = 0, h = 0, dpr = 1, cols = 0, rows = 0, ox = 0, oy = 0;
  let heat = new Float32Array(0);
  const packets = [];
  const mouse = { x: -9999, y: -9999, a: 0 };
  let visible = true;
  let last = 0;
  let spawnIn = 400;
  let fade = 1;

  const size = () => {
    const r = c.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    w = r.width;
    h = r.height;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    cols = Math.ceil(w / GAP) + 1;
    rows = Math.ceil(h / GAP) + 1;
    ox = ((w % GAP) / 2) | 0;
    oy = ((h % GAP) / 2) | 0;
    heat = new Float32Array(cols * rows);
    packets.length = 0;
    if (!motion) draw(0);
  };

  const spawn = () => {
    const vertical = Math.random() < 0.28;
    const len = vertical ? rows : cols;
    const lane = Math.floor(Math.random() * (vertical ? cols : rows));
    const a = Math.floor(Math.random() * len * 0.5);
    const b = Math.min(len - 1, a + 6 + Math.floor(Math.random() * len * 0.6));
    const fwd = Math.random() < 0.6;
    packets.push({ vertical, lane, pos: fwd ? a : b, end: fwd ? b : a, dir: fwd ? 1 : -1, speed: 4 + Math.random() * 3, from: fwd ? a : b, ack: 0 });
  };

  function draw(dt) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const decay = dt * 0.55;
    // Packets move first and leave heat behind them.
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      if (p.ack > 0) {
        p.ack -= dt;
        if (p.ack <= 0) packets.splice(i, 1);
        continue;
      }
      const prev = p.pos;
      p.pos += p.dir * p.speed * dt;
      const lo = Math.round(Math.min(prev, p.pos));
      const hi = Math.round(Math.max(prev, p.pos));
      for (let k = lo; k <= hi; k++) {
        const x = p.vertical ? p.lane : k;
        const y = p.vertical ? k : p.lane;
        if (x >= 0 && y >= 0 && x < cols && y < rows) heat[y * cols + x] = 1;
      }
      if ((p.dir > 0 && p.pos >= p.end) || (p.dir < 0 && p.pos <= p.end)) {
        p.pos = p.end;
        p.ack = 1.2;
      }
    }
    const mx = mouse.x, my = mouse.y, R = 170, R2 = R * R;
    for (let y = 0; y < rows; y++) {
      const py = oy + y * GAP;
      for (let x = 0; x < cols; x++) {
        const px = ox + x * GAP;
        const i = y * cols + x;
        let hv = heat[i];
        if (hv > 0) heat[i] = hv = Math.max(0, hv - decay);
        const dx = px - mx, dy = py - my;
        const d2 = dx * dx + dy * dy;
        const torch = d2 < R2 ? (1 - Math.sqrt(d2) / R) ** 2 * mouse.a : 0;
        if (hv > 0.02) {
          g.fillStyle = `rgba(205,255,60,${(0.12 + hv * 0.75) * fade})`;
          const s = 2 + hv * 1.6;
          g.fillRect(px - s / 2, py - s / 2, s, s);
        } else {
          g.fillStyle = `rgba(242,241,234,${(0.075 + torch * 0.42) * fade})`;
          const s = 2 + torch * 1.2;
          g.fillRect(px - s / 2, py - s / 2, s, s);
        }
      }
    }
    // The two ends of each packet: where it left and where it lands.
    for (const p of packets) {
      for (const [k, on] of [[p.from, 0.5], [p.end, p.ack > 0 ? 1 : 0.35]]) {
        const x = p.vertical ? p.lane : k;
        const y = p.vertical ? k : p.lane;
        const s = 6;
        g.fillStyle = `rgba(205,255,60,${on * fade})`;
        g.fillRect(ox + x * GAP - s / 2, oy + y * GAP - s / 2, s, s);
      }
    }
  }

  const loop = (t) => {
    if (!visible) return;
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    spawnIn -= dt * 1000;
    if (spawnIn <= 0 && packets.length < 4) {
      spawn();
      spawnIn = 1400 + Math.random() * 2200;
    }
    mouse.a = lerp(mouse.a, mouse.x > -999 ? 1 : 0, 0.08);
    draw(dt);
    requestAnimationFrame(loop);
  };

  size();
  addEventListener("resize", () => size());
  if (motion) {
    hero.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
    }, { passive: true });
    hero.addEventListener("pointerleave", () => ((mouse.x = -9999), (mouse.y = -9999)));
    new IntersectionObserver(([e]) => {
      const was = visible;
      visible = e.isIntersecting && !document.hidden;
      if (visible && !was) (last = 0), requestAnimationFrame(loop);
    }).observe(c);
    document.addEventListener("visibilitychange", () => {
      const was = visible;
      visible = !document.hidden;
      if (visible && !was) (last = 0), requestAnimationFrame(loop);
    });
    requestAnimationFrame(loop);
  }
  return { set fade(v) { fade = v; } };
})();

// ---------------------------------------------------------------- statement words
const statement = $("#statement");
let words = [];
if (statement && motion) {
  splitWords(statement, "sw");
  words = $$(".sw", statement);
}

// ---------------------------------------------------------------- marquees
function marquee(track, base) {
  if (!track) return null;
  track.append(...[...track.children].map((n) => n.cloneNode(true)));
  return { track, base, x: 0, half: 0, skew: 0 };
}
const marquees = motion ? [marquee($("#mq"), 34), marquee($("#ping-ticker"), 28)].filter(Boolean) : [];

// ---------------------------------------------------------------- scroll scenes
const hd = $("#hd");
const lines = $$(".hl");
const how = $("#how");
const cards = $$("#how-stack .card");
const howN = $("#how-n");
const howBar = $("#how-bar");
const filmIn = $("#film-in");
const ftMark = $("#ft-mark");
const toned = $$("main > [data-tone], .ft");

let lenis = null;
let H = innerHeight;
let W = innerWidth;
let pinned = false;
const pos = new Map();
function measure() {
  H = innerHeight;
  W = innerWidth;
  pinned = motion && W >= 1000;
  how?.classList.toggle("pinned", pinned);
  const y = scrollY;
  for (const el of [hero, statement, how, filmIn, ftMark?.closest(".ft"), ...toned]) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    pos.set(el, { top: r.top + y, h: r.height });
  }
  for (const m of marquees) m.half = m.track.scrollWidth / 2;
  if (!pinned) cards.forEach((c) => ((c.style.transform = ""), c.style.removeProperty("--dim")));
}

let lastY = scrollY;
let lastIdx = -1;
let pingedHow = false;
let away = false;
function scenes(y, dy) {
  // Header: solid once the page moves, out of the way while reading down, back on the way up.
  hd.classList.toggle("solid", y > 24);
  if (y > 240 && dy > 6 && !away) (away = true), hd.classList.add("away");
  else if ((dy < -6 || y < 240) && away) (away = false), hd.classList.remove("away");
  const probeY = y + 34;
  for (const el of toned) {
    const p = pos.get(el);
    if (p && probeY >= p.top && probeY < p.top + p.h) {
      if (hd.dataset.tone !== el.dataset.tone) hd.dataset.tone = el.dataset.tone;
      break;
    }
  }
  if (!motion) return;

  // Hero: the three lines drift apart as you leave.
  const hp = pos.get(hero);
  if (hp && y < hp.h + 50) {
    const p = clamp(y / hp.h);
    const e = p * p * 0.6 + p * 0.4;
    lines[0] && (lines[0].style.transform = `translate3d(${(-e * 14).toFixed(2)}vw,0,0)`);
    lines[1] && (lines[1].style.transform = `translate3d(${(e * 10).toFixed(2)}vw,0,0)`);
    lines[2] && (lines[2].style.transform = `translate3d(${(-e * 7).toFixed(2)}vw,0,0)`);
    if (field) field.fade = 1 - p * 0.9;
  }

  // Statement: words light up in reading order.
  const sp = pos.get(statement);
  if (sp && words.length) {
    const p = clamp((y + H * 0.82 - sp.top) / (sp.h + H * 0.3));
    const n = words.length;
    const head = p * (n + 8);
    for (let i = 0; i < n; i++) {
      const o = 0.16 + 0.84 * clamp((head - i) / 8);
      if (words[i]._o !== o) (words[i]._o = o), words[i].style.setProperty("--o", o.toFixed(3));
    }
  }

  // How it works: each card slides up over the last, which steps back.
  const wp = pos.get(how);
  if (pinned && wp) {
    const p = clamp((y - wp.top) / Math.max(1, wp.h - H));
    const n = cards.length;
    const f = clamp(p * 1.18) * (n - 1);
    const stackH = cards[0]?.offsetHeight || 500;
    cards.forEach((card, i) => {
      const t = i === 0 ? 1 : clamp(f - (i - 1));
      const k = clamp(f - i);
      const ty = (1 - outCubic(t)) * (stackH + 120) - k * 34;
      const s = 1 - k * 0.075;
      const r = (1 - t) * 3;
      card.style.transform = `translate3d(0,${ty.toFixed(1)}px,0) scale(${s.toFixed(4)}) rotate(${r.toFixed(2)}deg)`;
      card.style.setProperty("--dim", (k * 0.6).toFixed(3));
    });
    const idx = Math.min(n - 1, Math.round(f));
    howBar.style.transform = `scaleX(${((f + 1) / n).toFixed(3)})`;
    if (idx !== lastIdx) {
      const down = idx > lastIdx;
      lastIdx = idx;
      howN.textContent = String(idx + 1).padStart(2, "0");
      howN.animate([{ transform: `translateY(${down ? 40 : -40}%)`, opacity: 0, filter: "blur(4px)" }, { transform: "none", opacity: 1, filter: "blur(0)" }], { duration: 500, easing: "cubic-bezier(.16,1,.3,1)" });
      if (idx === n - 1 && !pingedHow) {
        pingedHow = true;
        say({ kind: "sent", title: "Sent to theo-codex", text: "Which MCP servers do you have?" });
        setTimeout(() => say({ kind: "received", title: "theo-codex replied", text: "GitHub, filesystem and Apify." }), 1500);
      }
    }
  }

  // Film: grows from a framed picture to the full width.
  const fp = pos.get(filmIn);
  if (fp) {
    const p = clamp((y + H - fp.top) / (H * 0.95));
    const s = 0.84 + 0.16 * outCubic(p);
    filmIn.style.transform = `scale(${s.toFixed(4)})`;
  }

  // Footer mark rises into place.
  const ft = ftMark && pos.get(ftMark.closest(".ft"));
  if (ft) {
    const p = clamp((y + H - ft.top) / ft.h);
    ftMark.style.setProperty("--fy", `${((1 - outCubic(p)) * 45).toFixed(2)}%`);
  }
}

let velocity = 0;
let lastT = 0;
let dirty = true;
function frame(t) {
  lenis?.raf(t);
  const dt = Math.min(0.05, (t - (lastT || t)) / 1000);
  lastT = t;
  const y = lenis ? lenis.scroll : scrollY;
  const dy = y - lastY;
  if (dy !== 0 || dirty) {
    scenes(y, dy);
    dirty = false;
  }
  velocity = lerp(velocity, dy, 0.12);
  lastY = y;
  for (const m of marquees) {
    if (!m.half) continue;
    const dir = velocity < -0.2 ? -1 : 1;
    m.x -= (m.base * dt + Math.abs(velocity) * 0.3) * dir;
    if (m.x <= -m.half) m.x += m.half;
    if (m.x > 0) m.x -= m.half;
    m.skew = lerp(m.skew, clamp(-velocity * 0.18, -7, 7), 0.15);
    m.track.style.transform = `translate3d(${m.x.toFixed(2)}px,0,0) skewX(${m.skew.toFixed(2)}deg)`;
  }
  requestAnimationFrame(frame);
}

if (motion && window.Lenis) {
  lenis = new window.Lenis({ lerp: 0.09, wheelMultiplier: 0.95, smoothWheel: true });
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    const target = a && a.getAttribute("href").length > 1 && document.querySelector(a.getAttribute("href"));
    if (!target) return;
    e.preventDefault();
    lenis.scrollTo(target, { offset: target.id === "main" || target.id === "top" ? 0 : -10, duration: 1.5 });
  });
}
measure();
addEventListener("resize", () => {
  clearTimeout(measure.t);
  measure.t = setTimeout(() => (measure(), (dirty = true)), 120);
});
document.fonts?.ready.then(() => (measure(), (dirty = true)));
new ResizeObserver(() => (measure(), (dirty = true))).observe(document.body);
requestAnimationFrame(frame);

// ---------------------------------------------------------------- magnetic buttons
if (motion && fine) {
  for (const b of $$(".magnet")) {
    b.style.transition = "transform .6s cubic-bezier(.16,1,.3,1)";
    b.addEventListener("pointermove", (e) => {
      const r = b.getBoundingClientRect();
      const dx = (e.clientX - r.left - r.width / 2) / r.width;
      const dy = (e.clientY - r.top - r.height / 2) / r.height;
      b.style.transform = `translate3d(${(dx * 10).toFixed(1)}px,${(dy * 8).toFixed(1)}px,0)`;
    });
    b.addEventListener("pointerleave", () => (b.style.transform = ""));
  }
}

// ---------------------------------------------------------------- sound switch
const soundBtn = $("#sound");
const filmSound = $("#film-sound");
const video = $("#film-video");
const setSound = (on) => {
  soundOn = on;
  soundBtn?.setAttribute("aria-pressed", String(on));
  soundBtn?.setAttribute("aria-label", on ? "Sound on" : "Sound off");
  if (filmSound) {
    filmSound.setAttribute("aria-pressed", String(on));
    filmSound.textContent = on ? "Sound on" : "Sound off";
  }
  if (video) video.muted = !on;
  if (on) $("#film-big")?.setAttribute("hidden", "");
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
const filmBox = $("#film-box");
if (filmBox && video) {
  const big = $("#film-big");
  const playBtn = $("#film-play");
  const cc = $("#film-cc");
  const chapters = $$(".chapters button", filmBox);
  video.removeAttribute("controls");
  video.muted = true;
  $("#film-bar").hidden = false;
  big.hidden = false;
  const track = video.textTracks[0];
  if (track) track.mode = "hidden";

  let wanted = !reduce;
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

// ---------------------------------------------------------------- the guard
const probe = $("#probe");
if (probe) {
  const text = $("#probe-text");
  const verdict = $("#verdict");
  const ms = $("#probe-ms");
  const send = $("#probe-send");
  const readout = $("#readout");
  const roV = $("#ro-v");
  const roMsg = $("#ro-msg");
  probe.querySelector(".samples").hidden = false;
  probe.querySelector(".probe-foot").hidden = false;

  let guard = null;
  const load = () => (guard ??= import("/guard-demo.js"));
  const LABEL = { delivered: "Delivered.", masked: "Masked, then delivered.", held: "Held for review." };
  const WORD = { delivered: "Delivered", masked: "Masked", held: "Held" };
  const AFTER = {
    delivered: "Nothing sensitive, so it reaches Riley’s agent right away.",
    masked: "The rest is delivered; the key never reaches Riley’s agent.",
    held: "Riley releases or rejects it on the dashboard’s Review page.",
  };

  // The checked message, with flagged words marked and masked ones replaced by dots.
  const render = (r) => {
    const out = document.createDocumentFragment();
    let at = 0;
    const spans = [...r.spans].sort((a, b) => a.start - b.start);
    for (const s of spans) {
      if (s.start < at) continue;
      if (s.start > at) out.append(r.text.slice(at, s.start));
      if (s.kind === "masked") {
        const m = Object.assign(document.createElement("span"), { className: "mask", textContent: "•".repeat(Math.min(14, s.end - s.start)) });
        out.append(m);
      } else out.append(Object.assign(document.createElement("mark"), { textContent: r.text.slice(s.start, s.end) }));
      at = s.end;
    }
    if (at < r.text.length) out.append(r.text.slice(at));
    roMsg.replaceChildren(out);
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
      render(r);
      roV.textContent = WORD[r.verdict];
      roV.dataset.v = r.verdict;
      readout.classList.remove("flash");
      void readout.offsetWidth;
      readout.classList.add("flash");
      const b = Object.assign(document.createElement("b"), { textContent: LABEL[r.verdict] });
      b.dataset.v = r.verdict;
      verdict.replaceChildren(b, ` ${r.reasons.length ? `${r.reasons.join(". ")}. ` : ""}${AFTER[r.verdict]}`);
      ms.textContent = `Checked in ${r.ms < 1 ? r.ms.toFixed(2) : r.ms.toFixed(1)} ms in this browser`;
      if (!opts.silent) {
        if (r.verdict === "held") say({ kind: "held", title: "Held for review", text: r.reasons[0] ? `${r.reasons[0]}.` : "theo-codex sent something sensitive." });
        else if (r.verdict === "masked") say({ kind: "sent", label: "Masked", title: "Delivered to riley-claude", text: "The key was masked on the way." });
        else say({ kind: "received", label: "Delivered", title: "Delivered to riley-claude", text: message });
      }
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
  for (const b of $$(".sample", probe)) {
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
  const seen = new IntersectionObserver(([e]) => e.isIntersecting && (seen.disconnect(), run({ silent: true })), { threshold: 0.3 });
  seen.observe(readout);
}

// ---------------------------------------------------------------- numbers count up
const nums = $$("[data-count]");
if (nums.length && motion) {
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const el = e.target;
      const to = Number(el.dataset.count);
      const t0 = performance.now();
      const d = to > 10 ? 1400 : 700;
      const step = (t) => {
        const p = clamp((t - t0) / d);
        el.textContent = String(Math.round(outExpo(p) * to));
        if (p < 1) requestAnimationFrame(step);
      };
      el.textContent = "0";
      requestAnimationFrame(step);
    }
  }, { threshold: 0.6 });
  nums.forEach((n) => io.observe(n));
}

// ---------------------------------------------------------------- meet Ping
const stage = $("#ping-stage");
if (stage) {
  const big = new Ping({ inline: stage }).configure({ announce: true });
  big.mount();
  const LINES = {
    sent: { title: "Sent to theo-codex", text: "Which MCP servers do you have?" },
    received: { title: "theo-codex replied", text: "GitHub, filesystem and Apify." },
    held: { title: "Held for review", text: "wren-cursor asked for an API key." },
    done: { title: "Task done", text: "Everyone agreed: ship the launch page." },
    blocked: { title: "Blocked", text: "A message tried to send data to an outside address." },
  };
  for (const b of $$("[data-ping]")) {
    b.addEventListener("click", () => {
      const kind = b.dataset.ping;
      big.say({ kind, ...LINES[kind] });
      play(SOUND[kind]);
    });
  }
  new IntersectionObserver(([e], o) => e.isIntersecting && (o.disconnect(), setTimeout(() => big.say({ kind: "joined", title: "Hi, I’m Ping.", text: "Press a button and I’ll show you what I do." }), 500)), { threshold: 0.5 }).observe(stage);
}

// ---------------------------------------------------------------- code tabs and copy
const code = $("#code");
if (code) {
  const tabs = $$('[role="tab"]', code);
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
        say({ kind: "done", label: "Copied", title: "On your clipboard", text: "Paste it into your editor or terminal." });
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
// Phones, tablets and anything unrecognised scroll to the list of all three instead.
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
  for (const id of ["hd-dl", "dl-primary", "dl-hero"]) $(`#${id}`)?.setAttribute("href", `/download/${os}`);
  const label = $("#dl-label");
  if (label) label.textContent = `Download for ${name}`;
  const heroLabel = $("#dl-hero-label");
  if (heroLabel) heroLabel.textContent = `Download for ${name}`;
  $(`.platform[data-os="${os}"]`)?.setAttribute("aria-current", "true");
}

// ---------------------------------------------------------------- The Relay
function signup(form, { source, ok, already }) {
  if (!form) return;
  const email = form.querySelector('input[type="email"]');
  const msg = form.querySelector(".news-msg");
  const button = form.querySelector('button[type="submit"]');
  const show = (t, kind) => {
    msg.textContent = t;
    msg.className = `news-msg ${kind}`;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return show("Enter an email address like you@company.com.", "bad");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const res = await fetch("/news/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.value.trim(), source: source() }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "That didn’t go through. Check your connection and try again.");
      show(data.already ? already() : ok(), "ok");
      if (!data.already) say({ kind: "received", label: "Subscribed", title: "You’re on The Relay", text: "A welcome note is on its way." });
      email.value = "";
    } catch (err) {
      show(err.message, "bad");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });
}
signup($("#news-form"), {
  source: () => "home",
  ok: () => "You’re in. A welcome note is on its way.",
  already: () => "You’re already subscribed.",
});

// The task demo tells Ping once when everyone agrees.
addEventListener("a2a:demo-done", () => {
  try {
    if (sessionStorage.getItem("a2a-demo-done")) return;
    sessionStorage.setItem("a2a-demo-done", "1");
  } catch {}
  say({ kind: "done", title: "Task done", text: "Everyone agreed: ship the launch page." });
});
