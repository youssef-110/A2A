// Ping: the a2a courier. A small graphite creature with a black visor and two LED eyes that shows
// up when something happens (a message sent, an answer received, something held by the guard, a
// task done), says it in one line, and leaves. One instance per page; every product surface
// (site, dashboard, console, desktop) loads this same file.
//
//   import { ping } from "/ping.js";
//   ping.say({ kind: "received", title: "theo-codex replied", text: "GitHub, filesystem and Apify." });
//
// Kinds: sent, received, held, blocked, done, joined, info, error. Ping never shows hearts, blush or
// emoji; its whole face is two lit pixels. Everything moves with transform and opacity only, and
// with reduced motion it fades in and out without travelling.

const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const OFF_KEY = "a2a-ping";

const KIND = {
  sent: { label: "Sent", mood: "happy", tone: "lime" },
  received: { label: "Received", mood: "wide", tone: "lime" },
  held: { label: "Held", mood: "stern", tone: "amber" },
  blocked: { label: "Blocked", mood: "x", tone: "red" },
  error: { label: "Error", mood: "x", tone: "red" },
  done: { label: "Done", mood: "happy", tone: "lime" },
  joined: { label: "Joined", mood: "wide", tone: "lime" },
  info: { label: "Ping", mood: "idle", tone: "lime" },
};

const CSS = `
.a2a-ping{--pc:#cdff3c;--pc-ink:#cdff3c;--ps1:#5a5a53;--ps2:#2c2c28;--ps3:#151513;--prim:rgb(255 255 255/.22);position:fixed;right:max(16px,env(safe-area-inset-right));bottom:calc(var(--ping-lift,0px) + max(14px,env(safe-area-inset-bottom)));z-index:2147483000;transition:bottom .4s cubic-bezier(.22,1,.36,1);display:flex;align-items:flex-end;gap:2px;pointer-events:none;font:500 13px/1.35 "Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;letter-spacing:-.005em;-webkit-font-smoothing:antialiased}
.a2a-ping[data-side="left"]{right:auto;left:max(16px,env(safe-area-inset-left));flex-direction:row-reverse}
.a2a-ping[data-tone="amber"]{--pc:#ffad33;--pc-ink:#ffad33}
.a2a-ping[data-tone="red"]{--pc:#ff5a4e;--pc-ink:#ff7a70}
.a2a-ping[hidden]{display:none}
.ping-bot{position:relative;width:88px;height:88px;flex:none;pointer-events:auto;cursor:pointer;-webkit-tap-highlight-color:transparent;border:0;padding:0;background:none;color:inherit;will-change:transform}
.ping-bot:focus-visible{outline:2px solid var(--pc);outline-offset:2px;border-radius:24px}
.ping-bot svg{display:block;width:100%;height:100%;overflow:visible}
.ping-bubble{position:relative;max-width:min(300px,calc(100vw - 132px));margin-bottom:46px;padding:11px 14px 12px;border-radius:14px 14px 4px 14px;background:#121211;color:#f2f1ea;box-shadow:0 0 0 1px rgb(255 255 255/.09),0 18px 40px -14px rgb(0 0 0/.7);pointer-events:auto;transform-origin:100% 100%;opacity:0}
.a2a-ping[data-side="left"] .ping-bubble{border-radius:14px 14px 14px 4px;transform-origin:0 100%}
.ping-tag{display:flex;align-items:center;gap:7px;margin-bottom:3px;font:600 10.5px/1 "Geist Mono",ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--pc-ink)}
.ping-tag::before{content:"";width:6px;height:6px;border-radius:1px;background:var(--pc);box-shadow:0 0 8px var(--pc)}
.ping-tag i{font-style:normal;color:#8f8e86;margin-left:auto;letter-spacing:.04em}
.ping-title{display:block;overflow-wrap:anywhere}
.ping-text{display:block;margin-top:2px;color:#a9a89f;font-size:12.5px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.ping-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.p-eye-c{fill:var(--pc);transition:fill .25s ease}
.p-eye-s{stroke:var(--pc);transition:stroke .25s ease}
.p-led{fill:var(--pc);transition:fill .25s ease}
.p-glow{fill:var(--pc);transition:fill .25s ease}
.p-shape{opacity:0;transform:scale(.4);transform-box:fill-box;transform-origin:center;transition:opacity .14s ease,transform .22s cubic-bezier(.22,1,.36,1)}
.a2a-ping[data-mood="idle"] .e-dot,.a2a-ping[data-mood="wide"] .e-dot,.a2a-ping[data-mood="happy"] .e-happy,.a2a-ping[data-mood="stern"] .e-stern,.a2a-ping[data-mood="x"] .e-x,.a2a-ping[data-mood="sleep"] .e-flat{opacity:1;transform:none}
.a2a-ping[data-mood="wide"] .e-dot{transform:scale(1.16,1.22)}
.a2a-ping.blink .e-dot{transform:scale(1.05,.12)}
.p-rig{transform-box:view-box;transform-origin:60px 112px}
.p-body{transform-box:view-box;transform-origin:60px 100px}
.p-ear{transform-box:fill-box;transition:transform .32s cubic-bezier(.22,1,.36,1)}
.p-ear-l{transform-origin:100% 100%}.p-ear-r{transform-origin:0 100%}
.a2a-ping[data-mood="wide"] .p-ear-l,.a2a-ping[data-mood="happy"] .p-ear-l{transform:rotate(-7deg)}
.a2a-ping[data-mood="wide"] .p-ear-r,.a2a-ping[data-mood="happy"] .p-ear-r{transform:rotate(7deg)}
.a2a-ping[data-mood="stern"] .p-ear-l,.a2a-ping[data-mood="x"] .p-ear-l{transform:rotate(16deg) scaleY(.86)}
.a2a-ping[data-mood="stern"] .p-ear-r,.a2a-ping[data-mood="x"] .p-ear-r{transform:rotate(-16deg) scaleY(.86)}
.a2a-ping[data-mood="sleep"] .p-ear-l{transform:rotate(10deg)}.a2a-ping[data-mood="sleep"] .p-ear-r{transform:rotate(-10deg)}
.p-eyes{transition:transform .5s cubic-bezier(.22,1,.36,1)}
.p-packet{opacity:0;transform-box:view-box;transform-origin:60px 92px}
.p-spark{opacity:0;transform-box:fill-box;transform-origin:center}
@media (prefers-reduced-motion:no-preference){
 .a2a-ping.on .p-rig{animation:ping-bob 2.6s cubic-bezier(.45,0,.55,1) infinite alternate}
 .a2a-ping.on .p-shadow{animation:ping-shadow 2.6s cubic-bezier(.45,0,.55,1) infinite alternate}
 .a2a-ping.on[data-mood="sleep"] .p-rig,.a2a-ping.on[data-mood="sleep"] .p-shadow{animation-duration:4.2s}
 .p-led{animation:ping-led 3.2s ease-in-out infinite}
}
@keyframes ping-bob{to{transform:translateY(-4px)}}
@keyframes ping-shadow{to{transform:scale(.82);opacity:.55}}
@keyframes ping-led{0%,70%,100%{opacity:1}80%{opacity:.25}}
.p-shadow{transform-box:fill-box;transform-origin:center}
@media (max-width:520px){.ping-bot{width:70px;height:70px}.ping-bubble{margin-bottom:36px}}
.a2a-ping.inline{position:relative;right:auto;left:auto;bottom:auto;z-index:1;flex-direction:column;align-items:center;gap:8px;pointer-events:auto}
.a2a-ping.inline .ping-bot{width:var(--ping-size,320px);height:var(--ping-size,320px)}
.a2a-ping.inline .ping-bubble{margin:0;border-radius:14px;transform-origin:50% 100%;max-width:min(340px,90vw)}
@media (forced-colors:active){.ping-bubble{border:1px solid CanvasText}}
`;

// The face is two pixels on a visor. Each eye holds every shape it can make; the mood shows one.
const eye = (cx) => `
  <g class="p-eye" transform="translate(${cx} 64)">
    <rect class="p-shape e-dot p-eye-c" x="-3.6" y="-5.6" width="7.2" height="11.2" rx="2.2"/>
    <path class="p-shape e-happy p-eye-s" d="M-5 2.6 0 -2.6 5 2.6" fill="none" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path class="p-shape e-stern p-eye-s" d="${cx < 60 ? "M-5 -2.2 5 2.2" : "M-5 2.2 5 -2.2"}" fill="none" stroke-width="3.6" stroke-linecap="round"/>
    <path class="p-shape e-x p-eye-s" d="M-3.6 -3.6 3.6 3.6M3.6 -3.6 -3.6 3.6" fill="none" stroke-width="3" stroke-linecap="round"/>
    <path class="p-shape e-flat p-eye-s" d="M-4.6 1.4h9.2" fill="none" stroke-width="3" stroke-linecap="round"/>
  </g>`;

let uid = 0;
function svg() {
  const id = `pg${++uid}`;
  return `<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--ps1)"/><stop offset=".55" style="stop-color:var(--ps2)"/><stop offset="1" style="stop-color:var(--ps3)"/></linearGradient>
    <linearGradient id="${id}e" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--ps1)"/><stop offset="1" style="stop-color:var(--ps3)"/></linearGradient>
    <linearGradient id="${id}v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0d0c"/><stop offset="1" stop-color="#030303"/></linearGradient>
    <radialGradient id="${id}r" cx=".5" cy=".5" r=".5"><stop offset="0" class="p-glow" stop-opacity=".5" style="stop-color:var(--pc)"/><stop offset="1" style="stop-color:var(--pc)" stop-opacity="0"/></radialGradient>
    <clipPath id="${id}c"><rect x="31" y="50" width="58" height="28" rx="14"/></clipPath>
    <filter id="${id}g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <ellipse class="p-shadow" cx="60" cy="114" rx="23" ry="4.2" fill="#000" opacity=".5"/>
  <g class="p-rig">
    <g class="p-body">
      <g class="p-ear p-ear-l"><path d="M24 46 30.5 13.5c.5-2.4 3.6-3 5-1L51 34Z" fill="url(#${id}e)"/><path d="M31.5 36 34.8 21.5 42.6 32.6Z" fill="#000" opacity=".45"/></g>
      <g class="p-ear p-ear-r"><path d="M96 46 89.5 13.5c-.5-2.4-3.6-3-5-1L69 34Z" fill="url(#${id}e)"/><path d="M88.5 36 85.2 21.5 77.4 32.6Z" fill="#000" opacity=".45"/></g>
      <rect x="18" y="28" width="84" height="72" rx="30" fill="url(#${id}b)"/>
      <path d="M30 35c8-5 18-7 30-7s22 2 30 7" fill="none" style="stroke:var(--prim)" stroke-width="1.6" stroke-linecap="round"/>
      <rect x="18.7" y="28.7" width="82.6" height="70.6" rx="29.3" fill="none" stroke="#fff" stroke-opacity=".06" stroke-width="1.4"/>
      <circle class="p-led" cx="60" cy="40" r="2.3" filter="url(#${id}g)"/>
      <rect x="29" y="48" width="62" height="32" rx="16" fill="#000" opacity=".35"/>
      <rect x="31" y="50" width="58" height="28" rx="14" fill="url(#${id}v)"/>
      <g clip-path="url(#${id}c)">
        <ellipse cx="60" cy="66" rx="30" ry="14" fill="url(#${id}r)" opacity=".35"/>
        <g class="p-eyes" filter="url(#${id}g)">${eye(48)}${eye(72)}</g>
        <path d="M36 54c6-2.4 14-3.4 24-3.4" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="2" stroke-linecap="round"/>
      </g>
      <rect x="31.5" y="50.5" width="57" height="27" rx="13.5" fill="none" stroke="var(--pc)" stroke-opacity=".16"/>
      <path d="M44 92h32" stroke="#000" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/>
    </g>
    <g class="p-packet">
      <rect x="50" y="82" width="20" height="20" rx="5" style="fill:var(--pc)" filter="url(#${id}g)"/>
      <path d="M55 92h10M61 88l4 4-4 4" fill="none" stroke="#0b0b0a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
    ${[0, 1, 2, 3, 4, 5].map((i) => `<rect class="p-spark" x="58" y="58" width="4" height="4" rx="1" style="fill:var(--pc)" data-i="${i}"/>`).join("")}
  </g>
</svg>`;
}

const E_OUT = "cubic-bezier(.22,1,.36,1)";
const E_INOUT = "cubic-bezier(.65,0,.35,1)";

export class Ping {
  /** inline: an element to live in (always visible, at --ping-size) instead of the page corner. */
  constructor(opts = {}) {
    this.inline = opts.inline ?? null;
    this.queue = [];
    this.showing = false;
    this.timer = 0;
    this.hover = false;
    this.look = { x: 0, y: 0, tx: 0, ty: 0 };
    this.side = "right";
    this.announce = true;
  }

  get enabled() {
    try {
      return localStorage.getItem(OFF_KEY) !== "off";
    } catch {
      return true;
    }
  }
  set enabled(on) {
    try {
      localStorage.setItem(OFF_KEY, on ? "on" : "off");
    } catch {}
    if (!on) this.hide(true);
  }

  /** Options: side ("right" | "left"), announce (write the line to its own live region). */
  configure(opts = {}) {
    if (opts.side) this.side = opts.side;
    if (opts.announce !== undefined) this.announce = opts.announce;
    if (this.el) this.el.dataset.side = this.side;
    return this;
  }

  mount() {
    if (this.el) return this;
    if (!document.getElementById("a2a-ping-css")) {
      const s = document.createElement("style");
      s.id = "a2a-ping-css";
      s.textContent = CSS;
      document.head.append(s);
    }
    const el = document.createElement("div");
    el.className = this.inline ? "a2a-ping inline on" : "a2a-ping";
    el.hidden = !this.inline;
    el.dataset.side = this.side;
    el.dataset.mood = "idle";
    el.dataset.tone = "lime";
    el.innerHTML = `<div class="ping-bubble"><span class="ping-tag"><span class="ping-k"></span><i class="ping-n"></i></span><span class="ping-title"></span><span class="ping-text"></span></div><button class="ping-bot" type="button" aria-label="Dismiss notification">${svg()}</button><div class="ping-sr" role="status" aria-live="polite"></div>`;
    (this.inline ?? document.body).append(el);
    this.el = el;
    this.bot = el.querySelector(".ping-bot");
    this.bubble = el.querySelector(".ping-bubble");
    this.rig = el.querySelector(".p-rig");
    this.body = el.querySelector(".p-body");
    this.eyes = el.querySelector(".p-eyes");
    this.packet = el.querySelector(".p-packet");
    this.sparks = [...el.querySelectorAll(".p-spark")];
    this.sr = el.querySelector(".ping-sr");
    if (this.inline) {
      this.showing = true;
      this.bubbleGone = true;
      this.bot.setAttribute("aria-label", "Ping");
      this.bot.addEventListener("click", () => this.act(["joined", "done", "info"][Math.floor(Math.random() * 3)]));
      this.blinkLater();
    } else this.bot.addEventListener("click", () => this.hide());
    for (const t of [this.bot, this.bubble]) {
      t.addEventListener("pointerenter", () => ((this.hover = true), this.mood("happy")));
      t.addEventListener("pointerleave", () => {
        this.hover = false;
        this.mood(this.current?.mood ?? "idle");
        if (this.showing && !this.timer) this.timer = setTimeout(() => this.next(), 1400);
      });
    }
    addEventListener("pointermove", (e) => {
      if (!this.showing) return;
      const r = this.bot.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height * 0.55);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 260);
      this.look.tx = (dx / d) * 5.2 * k;
      this.look.ty = (dy / d) * 3 * k;
      this.lookLoop();
    }, { passive: true });
    return this;
  }

  lookLoop() {
    if (this.lookRaf) return;
    const step = () => {
      const L = this.look;
      L.x += (L.tx - L.x) * 0.18;
      L.y += (L.ty - L.y) * 0.18;
      this.eyes.style.transform = `translate(${L.x.toFixed(2)}px,${L.y.toFixed(2)}px)`;
      this.lookRaf = Math.abs(L.tx - L.x) + Math.abs(L.ty - L.y) > 0.05 ? requestAnimationFrame(step) : 0;
    };
    this.lookRaf = requestAnimationFrame(step);
  }

  lookAt(x, y) {
    this.look.tx = x;
    this.look.ty = y;
    this.lookLoop();
  }

  mood(m) {
    if (this.el) this.el.dataset.mood = m;
  }

  blinkLater() {
    clearTimeout(this.blinkT);
    if (!this.showing) return;
    this.blinkT = setTimeout(() => {
      if (!this.el) return;
      this.el.classList.add("blink");
      setTimeout(() => this.el.classList.remove("blink"), 130);
      if (Math.random() < 0.25) setTimeout(() => (this.el.classList.add("blink"), setTimeout(() => this.el.classList.remove("blink"), 120)), 260);
      this.blinkLater();
    }, 2200 + Math.random() * 3200);
  }

  /** Show one line. Lines that arrive while Ping is talking wait their turn (at most four). */
  say(input) {
    const m = typeof input === "string" ? { kind: "info", title: input } : { kind: "info", ...input };
    if ((!this.enabled && !this.inline) || typeof document === "undefined") return;
    this.mount();
    if (this.queue.length >= 4) this.queue.shift();
    this.queue.push(m);
    if (!this.showing) this.next();
    else if (!this.hover && !this.timer) this.timer = setTimeout(() => this.next(), 600);
    else this.el.querySelector(".ping-n").textContent = `+${this.queue.length}`;
  }

  async next() {
    clearTimeout(this.timer);
    this.timer = 0;
    const m = this.queue.shift();
    if (!m) return this.hide();
    const k = KIND[m.kind] ?? KIND.info;
    this.current = { ...k, ...m };
    const first = !this.showing;
    this.showing = true;
    if (this.inline && this.bubbleGone) (this.bubbleGone = false), this.bubbleIn();
    const el = this.el;
    el.hidden = false;
    el.classList.add("on");
    el.dataset.tone = k.tone;
    el.querySelector(".ping-k").textContent = m.label ?? k.label;
    el.querySelector(".ping-n").textContent = this.queue.length ? `+${this.queue.length}` : "";
    el.querySelector(".ping-title").textContent = m.title ?? "";
    const t = el.querySelector(".ping-text");
    t.textContent = m.text ?? "";
    t.hidden = !m.text;
    if (this.announce) this.sr.textContent = [m.title, m.text].filter(Boolean).join(". ");
    this.mood(k.mood);
    if (this.inline) this.el.dataset.tone = k.tone;
    if (first && !this.inline) await this.enter();
    else this.bubbleSwap();
    this.act(m.kind);
    this.blinkLater();
    const life = m.sticky ? 0 : Math.max(2600, Math.min(6500, 1800 + ((m.title?.length ?? 0) + (m.text?.length ?? 0)) * 38)) - (this.queue.length ? 900 : 0);
    if (life && !this.hover) this.timer = setTimeout(() => this.next(), life);
  }

  enter() {
    const r = reduce();
    if (r) {
      this.bot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "both" });
      this.bubble.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "both" });
      return Promise.resolve();
    }
    this.mood("sleep");
    const a = this.bot.animate(
      [
        { transform: "translate3d(0,120%,0) rotate(-14deg) scale(.9)", opacity: 0 },
        { transform: "translate3d(0,-14%,0) rotate(4deg) scale(1.02)", opacity: 1, offset: 0.55 },
        { transform: "translate3d(0,4%,0) rotate(-1.5deg) scale(.99)", offset: 0.78 },
        { transform: "translate3d(0,0,0) rotate(0) scale(1)", opacity: 1 },
      ],
      { duration: 620, easing: "cubic-bezier(.3,.7,.3,1)", fill: "both" },
    );
    this.body.animate(
      [{ transform: "scale(1,1)" }, { transform: "scale(1.06,.9)", offset: 0.7 }, { transform: "scale(.97,1.04)", offset: 0.85 }, { transform: "scale(1,1)" }],
      { duration: 620, easing: "ease-out" },
    );
    setTimeout(() => this.mood(this.current?.mood ?? "idle"), 330);
    this.bubbleIn(260);
    return a.finished.catch(() => {});
  }

  bubbleIn(delay = 0) {
    this.bubble.getAnimations().forEach((a) => a.cancel());
    const left = this.side === "left";
    this.bubble.animate(
      [
        { opacity: 0, transform: `translate3d(${left ? -10 : 10}px,6px,0) scale(.94)`, filter: "blur(4px)" },
        { opacity: 1, transform: "none", filter: "blur(0)" },
      ],
      { duration: 360, delay: reduce() ? 0 : delay, easing: E_OUT, fill: "both" },
    );
  }

  bubbleSwap() {
    if (reduce()) return;
    this.bubble.animate(
      [{ opacity: 0.2, transform: "translate3d(0,8px,0)", filter: "blur(3px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
      { duration: 300, easing: E_OUT },
    );
    this.body.animate([{ transform: "scale(1)" }, { transform: "scale(1.04,.95)" }, { transform: "scale(1)" }], { duration: 280, easing: E_OUT });
  }

  /** The little performance that goes with each kind of news. */
  act(kind) {
    if (reduce()) return;
    const body = this.body;
    const pk = this.packet;
    const dir = this.side === "left" ? 1 : -1;
    if (kind === "sent") {
      this.lookAt(dir * 5, -3);
      body.animate(
        [{ transform: "rotate(0) scale(1)" }, { transform: `rotate(${-dir * 9}deg) scale(.97,1.03)`, offset: 0.35 }, { transform: `rotate(${dir * 5}deg) scale(1.03,.96)`, offset: 0.6 }, { transform: "rotate(0) scale(1)" }],
        { duration: 760, easing: E_INOUT },
      );
      pk.animate(
        [
          { opacity: 0, transform: "translate(0,10px) scale(.4)" },
          { opacity: 1, transform: "translate(0,0) scale(1)", offset: 0.25 },
          { opacity: 1, transform: `translate(${dir * 6}px,4px) scale(1) rotate(${-dir * 10}deg)`, offset: 0.4 },
          { opacity: 0, transform: `translate(${dir * 150}px,-110px) scale(.55) rotate(${dir * 30}deg)` },
        ],
        { duration: 900, easing: "cubic-bezier(.5,0,.2,1)" },
      );
      setTimeout(() => this.lookAt(0, 0), 1000);
    } else if (kind === "received") {
      this.lookAt(0, -4);
      pk.animate(
        [
          { opacity: 0, transform: "translate(0,-110px) scale(.7) rotate(-20deg)" },
          { opacity: 1, transform: "translate(0,-8px) scale(1) rotate(0)", offset: 0.55 },
          { opacity: 1, transform: "translate(0,0) scale(1.08,.9)", offset: 0.68 },
          { opacity: 1, transform: "translate(0,0) scale(1)", offset: 0.85 },
          { opacity: 0, transform: "translate(0,2px) scale(.6)" },
        ],
        { duration: 1100, easing: "cubic-bezier(.3,.6,.3,1)" },
      );
      body.animate(
        [{ transform: "translateY(0) scale(1)" }, { transform: "translateY(0) scale(1)", offset: 0.48 }, { transform: "translateY(3px) scale(1.07,.9)", offset: 0.6 }, { transform: "translateY(-2px) scale(.98,1.03)", offset: 0.76 }, { transform: "none" }],
        { duration: 1100, easing: E_OUT },
      );
      setTimeout(() => (this.lookAt(0, 0), this.current?.kind === "received" && !this.hover && this.mood("happy")), 800);
    } else if (kind === "held") {
      body.animate(
        [{ transform: "rotate(0)" }, { transform: "rotate(-7deg)", offset: 0.2 }, { transform: "rotate(6deg)", offset: 0.45 }, { transform: "rotate(-4deg)", offset: 0.7 }, { transform: "rotate(0)" }],
        { duration: 720, easing: E_INOUT },
      );
    } else if (kind === "blocked" || kind === "error") {
      body.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(-3px) skewX(-6deg)", offset: 0.12 }, { transform: "translateX(3px) skewX(5deg)", offset: 0.24 }, { transform: "translateX(-2px)", offset: 0.36 }, { transform: "translateX(1px) skewX(2deg)", offset: 0.5 }, { transform: "none" }],
        { duration: 520, easing: "linear" },
      );
      this.el.animate([{ filter: "drop-shadow(-2px 0 0 rgb(255 90 78/.8)) drop-shadow(2px 0 0 rgb(80 200 255/.6))" }, { filter: "none" }], { duration: 420, easing: "steps(4,end)" });
    } else if (kind === "done") {
      body.animate(
        [{ transform: "translateY(0) rotate(0)" }, { transform: "translateY(4px) scale(1.06,.92) rotate(0)", offset: 0.15 }, { transform: "translateY(-22px) scale(.96,1.05) rotate(-180deg)", offset: 0.5 }, { transform: "translateY(0) scale(1.05,.94) rotate(-360deg)", offset: 0.85 }, { transform: "translateY(0) rotate(-360deg)" }],
        { duration: 900, easing: E_INOUT },
      );
      this.burst(380);
    } else if (kind === "joined") {
      body.animate([{ transform: "translateY(0)" }, { transform: "translateY(-10px) scale(.97,1.04)", offset: 0.4 }, { transform: "translateY(0) scale(1.04,.95)", offset: 0.75 }, { transform: "none" }], { duration: 560, easing: E_OUT });
    } else {
      body.animate([{ transform: "rotate(0)" }, { transform: "rotate(-5deg)", offset: 0.4 }, { transform: "rotate(0)" }], { duration: 420, easing: E_INOUT });
    }
  }

  /** Six square sparks thrown out of the body. Pixels, never hearts. */
  burst(delay = 0) {
    this.sparks.forEach((s, i) => {
      const a = (-90 + (i - 2.5) * 34) * (Math.PI / 180);
      const d = 40 + (i % 2) * 12;
      s.animate(
        [
          { opacity: 0, transform: "translate(0,0) scale(.4) rotate(0)" },
          { opacity: 1, transform: `translate(${Math.cos(a) * d * 0.5}px,${Math.sin(a) * d * 0.5}px) scale(1.2) rotate(45deg)`, offset: 0.35 },
          { opacity: 0, transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d + 10}px) scale(.5) rotate(90deg)` },
        ],
        { duration: 720, delay: delay + i * 18, easing: E_OUT },
      );
    });
  }

  async hide(now = false) {
    clearTimeout(this.timer);
    clearTimeout(this.blinkT);
    this.timer = 0;
    if (!this.showing || !this.el) return;
    if (this.inline) {
      this.queue.length = 0;
      this.mood("idle");
      this.bubbleGone = true;
      this.bubble.animate([{ opacity: 1 }, { opacity: 0, transform: "translate3d(0,6px,0)" }], { duration: 220, easing: "ease-in", fill: "forwards" });
      this.blinkLater();
      return;
    }
    this.showing = false;
    this.queue.length = 0;
    const el = this.el;
    if (now || reduce()) {
      this.bubble.getAnimations().forEach((a) => a.cancel());
      el.hidden = true;
      el.classList.remove("on");
      return;
    }
    this.mood("happy");
    this.bubble.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translate3d(0,6px,0) scale(.96)", filter: "blur(3px)" }], { duration: 180, easing: "ease-in", fill: "forwards" });
    const a = this.bot.animate(
      [
        { transform: "translate3d(0,0,0) scale(1)" },
        { transform: "translate3d(0,6%,0) scale(1.08,.88)", offset: 0.2 },
        { transform: "translate3d(0,-22%,0) scale(.95,1.06)", offset: 0.5 },
        { transform: "translate3d(0,130%,0) rotate(10deg) scale(.95)", opacity: 1 },
      ],
      { duration: 520, delay: 80, easing: "cubic-bezier(.5,0,.75,0)", fill: "both" },
    );
    await a.finished.catch(() => {});
    if (this.showing) return; // something new arrived while leaving
    el.hidden = true;
    el.classList.remove("on");
    this.mood("idle");
    this.lookAt(0, 0);
  }
}

export const ping = new Ping();
export default ping;
