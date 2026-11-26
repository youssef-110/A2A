// A2A film: a pure function of time. window.seek(t) paints frame t (see lib/motion.js).
// 40 s at 126 bpm = 84 beats. docs/shotlist.md is the plan this file follows.
// Night and bone neutrals, one lime accent (amber only for "held"), Archivo at its narrowest for
// display and Geist for the product's own words. Ping is drawn here from the same geometry as
// packages/web/public/ping.js; every screen is a real capture of the dashboard.
import * as M from './lib/motion.js';

const { W, H, E, prog, lerp, clamp, springU, SPRING, wobble, ring, kf, font, layout, glyph, text, fill, rrect, cover, hash01, bump, mix } = M;

const C = { night: '#0b0b0a', surface: '#121211', surface2: '#1a1a18', bone: '#f2f1ea', fg2: '#b0afa6', fg3: '#8f8e86', lime: '#cdff3c', amber: '#ffad33', red: '#ff5a4e' };
const DISPLAY = 'Display', UI = 'UI', MONO = 'Mono';
// The display face at its narrowest: the stretch rides in the font string (setting ctx.font resets it).
const D = (size, w = 900) => `${Math.round(w)} extra-condensed ${Math.round(size)}px ${DISPLAY}`;

// Every accent: [beat, label, sfx, opts]. sfx.mjs voices each one.
const HITS = [
  [0, 'YOUR', 'impact'],
  [1, 'AGENT', 'thud', { pitch: 'D3' }],
  [2, 'TALKS TO', 'thud', { pitch: 'F3' }],
  [3.5, 'THEIRS.', 'impact'],
  [7.5, 'lines part', 'whoosh', { len: 0.5 }],
  [8, 'two A arrive', 'thud', { pitch: 'A2' }],
  [10, 'the link connects', 'bell', { pitch: 'D6' }],
  [10, 'the link connects', 'sub', { len: 0.6 }],
  [14, 'into the link', 'riser', { len: 0.9 }],
  [16, 'ONE PROMPT', 'impact'],
  [18, 'Claude Code ready', 'blip', { pitch: 'D5' }],
  [19, 'Cursor ready', 'blip', { pitch: 'F5' }],
  [20, 'Codex ready', 'blip', { pitch: 'A5' }],
  [21, 'Antigravity ready', 'blip', { pitch: 'C6' }],
  [22, 'Gemini CLI ready', 'blip', { pitch: 'D6' }],
  [26, 'dashboard rises', 'whoosh', { len: 0.5, from: 500, to: 2600 }],
  [28, 'Ping drops in', 'tok', { pitch: 'G4' }],
  [28.6, 'Ping lands', 'pop', { pitch: 'D5' }],
  [32, 'ASK', 'impact'],
  [36, 'question', 'click'],
  [37, 'Ping sends', 'whoosh', { len: 0.35, from: 900, to: 3000, pan: 0.4 }],
  [40, 'answer', 'click'],
  [41, 'Ping receives', 'pop', { pitch: 'A5' }],
  [48, 'the guard', 'impact'],
  [48.4, 'typing', 'type', { len: 1.4 }],
  [52, 'flagged', 'tick'],
  [53, 'HELD', 'thud', { pitch: 'A1' }],
  [53, 'HELD', 'crash', { len: 0.8 }],
  [54, 'Ping says no', 'tok', { pitch: 'D4' }],
  [56, 'review slides in', 'whoosh', { len: 0.45, from: 2400, to: 600, pan: -0.3 }],
  [64, 'MEET PING', 'impact'],
  [66, 'Ping wakes', 'tok', { pitch: 'A4' }],
  [68, 'sent', 'whoosh', { len: 0.35, from: 900, to: 3200, pan: 0.5 }],
  [70, 'received', 'pop', { pitch: 'E5' }],
  [72, 'held', 'tok', { pitch: 'D4' }],
  [74, 'done', 'coins'],
  [74.5, 'spin', 'boing', { pitch: 'D5', to: 'D6' }],
  [80, 'end card', 'impact'],
  [80.5, 'mark', 'bell', { pitch: 'D6' }],
];

// ---------------------------------------------------------------- shared pieces

const A_L = new Path2D('M7 0h8l7 28h-6.4l-1.1-4.8H7.5L6.4 28H0Zm4 9.2-2.7 9.4h5.4Z');
const A_R = new Path2D('M35 0h8l7 28h-6.4l-1.1-4.8h-7L34.4 28H28Zm4 9.2-2.7 9.4h5.4Z');
/** The mark, w wide at (x, y) top-left. dl/dr move each A (mark units); link 0..1 grows the bar from its centre. */
function mark(ctx, x, y, w, { dl = 0, dr = 0, link = 1, ink = C.bone, linkInk = C.lime, alpha = 1 } = {}) {
  const s = w / 50;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.scale(s, s);
  if (link > 0) {
    ctx.fillStyle = linkInk;
    const lw = 16 * link;
    ctx.fillRect(25 - lw / 2, 18.6, lw, 4.6);
  }
  ctx.fillStyle = ink;
  ctx.save(); ctx.translate(dl, 0); ctx.fill(A_L, 'evenodd'); ctx.restore();
  ctx.save(); ctx.translate(dr, 0); ctx.fill(A_R, 'evenodd'); ctx.restore();
  ctx.restore();
}

// The relay as a field of dots, with packets crossing it. Packets are seeded, so every frame agrees.
const GAP = 30;
function field(ctx, u, { alpha = 1, dot = 'rgba(242,241,234,', hot = 'rgba(205,255,60,', density = 1 } = {}) {
  const cols = Math.ceil(W / GAP) + 1, rows = Math.ceil(H / GAP) + 1;
  const ox = (W % GAP) / 2, oy = (H % GAP) / 2;
  ctx.fillStyle = `${dot}${0.07 * alpha})`;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) ctx.fillRect(ox + x * GAP - 1, oy + y * GAP - 1, 2, 2);
  // packets: lane, start beat, length, speed; trail of ~10 cells
  const N = Math.round(9 * density);
  for (let i = 0; i < N; i++) {
    const period = 14 + hash01(i, 3) * 10;
    const phase = hash01(i, 5) * period;
    const k = ((u + phase) % period) / period; // 0..1 through its trip, then it waits
    const trip = 0.7;
    if (k > trip) continue;
    const p = k / trip;
    const vertical = hash01(i, 7) < 0.3;
    const lane = Math.floor(hash01(i + Math.floor((u + phase) / period) * 31, 9) * (vertical ? cols : rows));
    const len = vertical ? rows : cols;
    const a = Math.floor(hash01(i, 11) * len * 0.4), b = Math.min(len - 1, a + 8 + Math.floor(hash01(i, 13) * len * 0.5));
    const head = lerp(a, b, E.inOutCubic(p));
    for (let j = 0; j < 12; j++) {
      const c = Math.round(head - j);
      if (c < a) break;
      const fade = (1 - j / 12) * alpha;
      const px = ox + (vertical ? lane : c) * GAP, py = oy + (vertical ? c : lane) * GAP;
      const s = 2 + (j === 0 ? 2.4 : 1.2 * (1 - j / 12));
      ctx.fillStyle = `${hot}${(0.15 + 0.7 * fade).toFixed(3)})`;
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
    }
    for (const [c, on] of [[a, 0.5], [b, p > 0.98 ? 1 : 0.3]]) {
      const px = ox + (vertical ? lane : c) * GAP, py = oy + (vertical ? c : lane) * GAP;
      ctx.fillStyle = `${hot}${on * alpha})`;
      ctx.fillRect(px - 3.5, py - 3.5, 7, 7);
    }
  }
}

/** A mono label: a small square, then bracket-numbered caps. */
function label(ctx, str, x, y, color = C.fg3, accent = C.lime, a = 1) {
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.fillStyle = accent;
  ctx.fillRect(x, y - 11, 10, 10);
  text(ctx, str, x + 22, y, font(19, 500, MONO), color, 'left', 2.4);
  ctx.restore();
}

/** One line of display type, rising glyph by glyph out of a mask at beat u0. */
function riseLine(ctx, u, u0, str, x, base, size, color, { align = 'left', stagger = 0.035, exitAt = 1e9, exitDir = 1, dx = 0 } = {}) {
  const f = D(size);
  ctx.fontStretch = 'extra-condensed';
  const L = layout(ctx, str, f, -0.004 * size);
  const x0 = align === 'right' ? x - L.width : align === 'center' ? x - L.width / 2 : x;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, base - L.asc - size * 0.08, W, L.asc + size * 0.16 + 4);
  ctx.clip();
  L.glyphs.forEach((g, j) => {
    const k = springU(u, u0 + j * stagger, SPRING.gentle);
    if (k <= 0) return;
    const ex = E.inCubic(prog(u, exitAt + j * 0.01, exitAt + 0.5 + j * 0.01));
    glyph(ctx, g.ch, x0 + g.cx + dx, base + (1 - k) * size * 1.05 - ex * size * 1.1 * exitDir, f, color);
  });
  ctx.restore();
  return L;
}

/** A real screenshot as a floating card, with a camera inside it. */
function card(ctx, img, x, y, w, h, { fx = 0.5, fy = 0.5, zoom = 1, radius = 28, alpha = 1 } = {}) {
  if (!img) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 80;
  ctx.shadowOffsetY = 40;
  rrect(ctx, x, y, w, h, radius);
  ctx.fillStyle = C.night;
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.globalAlpha *= alpha;
  cover(ctx, img, x, y, w, h, { fx, fy, zoom, radius });
  rrect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, radius);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- Ping, from ping.js's geometry

const P2 = {
  earL: new Path2D('M24 46 30.5 13.5c.5-2.4 3.6-3 5-1L51 34Z'), earLin: new Path2D('M31.5 36 34.8 21.5 42.6 32.6Z'),
  earR: new Path2D('M96 46 89.5 13.5c-.5-2.4-3.6-3-5-1L69 34Z'), earRin: new Path2D('M88.5 36 85.2 21.5 77.4 32.6Z'),
  rim: new Path2D('M30 35c8-5 18-7 30-7s22 2 30 7'), gloss: new Path2D('M36 54c6-2.4 14-3.4 24-3.4'),
};
const TONE = { lime: C.lime, amber: C.amber, red: C.red };
/**
 * Ping centred on (cx, cy = the middle of its body), size px tall box (viewBox 120).
 * st: mood (idle|wide|happy|stern|x|sleep), tone, lx/ly (look, viewBox units), blink 0..1,
 * rot (rad), sx/sy (squash), bob (px up), ears (radians outward), alpha, packet {x,y,s,a} in viewBox units.
 */
function ping(ctx, cx, cy, size, st = {}) {
  const { mood = 'idle', tone = 'lime', lx = 0, ly = 0, blink = 0, rot = 0, sx = 1, sy = 1, bob = 0, ears = 0, alpha = 1, packet = null, sparks = 0, shadow = 1 } = st;
  const c = TONE[tone];
  const k = size / 120;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(cx - 60 * k, cy - 64 * k);
  ctx.scale(k, k);
  // shadow on the floor
  ctx.save();
  ctx.globalAlpha *= 0.5 * shadow * (1 - Math.min(0.45, bob / 40));
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(60, 114, 23 * (1 - Math.min(0.3, bob / 60)), 4.2, 0, 0, M.TAU);
  ctx.fill();
  ctx.restore();
  ctx.translate(0, -bob / k);
  // body pivot near the bottom
  ctx.translate(60, 100); ctx.rotate(rot); ctx.scale(sx, sy); ctx.translate(-60, -100);
  const grad = ctx.createLinearGradient(0, 28, 0, 100);
  grad.addColorStop(0, '#5a5a53'); grad.addColorStop(0.55, '#2c2c28'); grad.addColorStop(1, '#151513');
  const egrad = ctx.createLinearGradient(0, 12, 0, 46);
  egrad.addColorStop(0, '#5a5a53'); egrad.addColorStop(1, '#151513');
  for (const [ear, inner, px, dir] of [[P2.earL, P2.earLin, 51, -1], [P2.earR, P2.earRin, 69, 1]]) {
    ctx.save();
    ctx.translate(px, 34); ctx.rotate(dir * ears); ctx.translate(-px, -34);
    ctx.fillStyle = egrad; ctx.fill(ear);
    ctx.globalAlpha *= 0.45; ctx.fillStyle = '#000'; ctx.fill(inner);
    ctx.restore();
  }
  ctx.beginPath(); ctx.roundRect(18, 28, 84, 72, 30); ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.stroke(P2.rim);
  ctx.beginPath(); ctx.roundRect(18.7, 28.7, 82.6, 70.6, 29.3); ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1.4; ctx.stroke();
  // status light
  ctx.save(); ctx.shadowColor = c; ctx.shadowBlur = 6 * k; ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(60, 40, 2.3, 0, M.TAU); ctx.fill(); ctx.restore();
  // visor
  ctx.beginPath(); ctx.roundRect(29, 48, 62, 32, 16); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
  const vg = ctx.createLinearGradient(0, 50, 0, 78); vg.addColorStop(0, '#0d0d0c'); vg.addColorStop(1, '#030303');
  ctx.beginPath(); ctx.roundRect(31, 50, 58, 28, 14); ctx.fillStyle = vg; ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.roundRect(31, 50, 58, 28, 14); ctx.clip();
  const rg = ctx.createRadialGradient(60, 66, 0, 60, 66, 30);
  rg.addColorStop(0, hexA(c, 0.2)); rg.addColorStop(1, hexA(c, 0));
  ctx.fillStyle = rg; ctx.fillRect(30, 50, 60, 30);
  ctx.translate(lx, ly);
  ctx.shadowColor = c; ctx.shadowBlur = 7 * k;
  ctx.fillStyle = c; ctx.strokeStyle = c; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const ex of [48, 72]) eye(ctx, ex, 64, mood, blink, ex < 60);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 2; ctx.stroke(P2.gloss);
  ctx.beginPath(); ctx.roundRect(31.5, 50.5, 57, 27, 13.5); ctx.strokeStyle = hexA(c, 0.16); ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(44, 92); ctx.lineTo(76, 92); ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.restore();
  // packet and sparks live in the rig (they move with the bob but not the squash)
  if (packet || sparks) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(cx - 60 * k, cy - 64 * k - bob);
    ctx.scale(k, k);
    if (packet && packet.a > 0) {
      ctx.save();
      ctx.globalAlpha *= packet.a;
      ctx.translate(packet.x, packet.y); ctx.rotate(packet.r || 0); ctx.scale(packet.s, packet.s);
      ctx.shadowColor = c; ctx.shadowBlur = 8 * k;
      ctx.beginPath(); ctx.roundRect(-10, -10, 20, 20, 5); ctx.fillStyle = c; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(5, 0); ctx.moveTo(1, -4); ctx.lineTo(5, 0); ctx.lineTo(1, 4);
      ctx.strokeStyle = C.night; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.restore();
    }
    if (sparks > 0 && sparks < 1) {
      for (let i = 0; i < 6; i++) {
        const a = (-90 + (i - 2.5) * 34) * (Math.PI / 180);
        const d = 42 + (i % 2) * 14;
        const p = E.outCubic(sparks);
        const o = sparks < 0.35 ? sparks / 0.35 : 1 - (sparks - 0.35) / 0.65;
        ctx.save();
        ctx.globalAlpha *= o;
        ctx.translate(60 + Math.cos(a) * d * p, 58 + Math.sin(a) * d * p + 10 * sparks * sparks);
        ctx.rotate(p * Math.PI);
        ctx.fillStyle = c;
        ctx.fillRect(-2.5, -2.5, 5, 5);
        ctx.restore();
      }
    }
    ctx.restore();
  }
}
function eye(ctx, x, y, mood, blink, left) {
  ctx.save();
  ctx.translate(x, y);
  if (mood === 'idle' || mood === 'wide') {
    const w = mood === 'wide' ? 1.16 : 1, h = (mood === 'wide' ? 1.22 : 1) * (1 - 0.88 * blink);
    ctx.scale(w, h);
    ctx.beginPath(); ctx.roundRect(-3.6, -5.6, 7.2, 11.2, 2.2); ctx.fill();
  } else if (mood === 'happy') {
    ctx.beginPath(); ctx.moveTo(-5, 2.6); ctx.lineTo(0, -2.6); ctx.lineTo(5, 2.6); ctx.lineWidth = 3.4; ctx.stroke();
  } else if (mood === 'stern') {
    ctx.beginPath(); left ? (ctx.moveTo(-5, -2.2), ctx.lineTo(5, 2.2)) : (ctx.moveTo(-5, 2.2), ctx.lineTo(5, -2.2)); ctx.lineWidth = 3.6; ctx.stroke();
  } else if (mood === 'x') {
    ctx.beginPath(); ctx.moveTo(-3.6, -3.6); ctx.lineTo(3.6, 3.6); ctx.moveTo(3.6, -3.6); ctx.lineTo(-3.6, 3.6); ctx.lineWidth = 3; ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(-4.6, 1.4); ctx.lineTo(4.6, 1.4); ctx.lineWidth = 3; ctx.stroke();
  }
  ctx.restore();
}
function hexA(hex, a) {
  const [r, g, b] = M.hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Ping's speech bubble: tag, title, a second line. Anchored by its bottom-right (or bottom-left) corner. */
function bubble(ctx, u, u0, u1, x, y, tag, title, sub, { tone = 'lime', anchor = 'right', scale = 1 } = {}) {
  const kin = springU(u, u0, SPRING.snappy);
  const kout = E.inCubic(prog(u, u1 - 0.35, u1));
  const a = clamp(kin) * (1 - kout);
  if (a <= 0.001) return;
  const c = TONE[tone];
  ctx.save();
  ctx.font = font(30 * scale, 500, UI);
  const tw = ctx.measureText(title).width;
  ctx.font = font(24 * scale, 400, UI);
  const sw = sub ? ctx.measureText(sub).width : 0;
  const w = Math.max(tw, sw, 160 * scale) + 52 * scale, h = (sub ? 128 : 92) * scale;
  const bx = anchor === 'right' ? x - w : x, by = y - h;
  const s = lerp(0.9, 1, kin) * lerp(1, 0.96, kout);
  ctx.translate(anchor === 'right' ? x : x, y + (1 - kin) * 14);
  ctx.scale(s, s);
  ctx.translate(-(anchor === 'right' ? x : x), -y);
  ctx.globalAlpha *= a;
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 20;
  const r = 22 * scale;
  ctx.beginPath();
  ctx.roundRect(bx, by, w, h, anchor === 'right' ? [r, r, 6 * scale, r] : [r, r, r, 6 * scale]);
  ctx.fillStyle = C.surface; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1.5; ctx.stroke();
  const px = bx + 26 * scale;
  ctx.fillStyle = c;
  ctx.save(); ctx.shadowColor = c; ctx.shadowBlur = 12; ctx.fillRect(px, by + 24 * scale, 9 * scale, 9 * scale); ctx.restore();
  text(ctx, tag.toUpperCase(), px + 20 * scale, by + 33 * scale, font(17 * scale, 600, MONO), c, 'left', 1.6 * scale);
  text(ctx, title, px, by + 72 * scale, font(30 * scale, 500, UI), C.bone);
  if (sub) text(ctx, sub, px, by + 106 * scale, font(24 * scale, 400, UI), '#a9a89f');
  ctx.restore();
}

/** Ping arriving from below at u0, leaving at u1; returns the bob/squash state for the moment. */
function pingEnter(u, u0, u1) {
  const k = springU(u, u0, SPRING.bouncy);
  const out = E.inBack(prog(u, u1 - 0.6, u1), 1.6);
  const land = wobble(u - u0 - 0.55, 2.6, 6);
  return { y: (1 - k) * 260 + out * 320, rot: (1 - k) * -0.25 + out * 0.2, sx: 1 + 0.06 * land, sy: 1 - 0.08 * land, alpha: clamp(k * 3) * (1 - clamp(out * 1.2)) };
}
const idleBob = (u) => (Math.sin((u / 2.4) * M.TAU) * 0.5 + 0.5) * 6;
const blinkAt = (u, beats) => Math.max(0, ...beats.map((b) => bump(u, b, 0.16)));

// ---------------------------------------------------------------- S1 hook   (u 0..16)
function sHook(ctx, u) {
  fill(ctx, C.night);
  field(ctx, u, { alpha: 1 - prog(u, 13, 15.5) });
  const size = 330, lh = size * 0.83;
  const top = 150;
  const drift = (i) => (u > 7.4 ? E.inCubic(prog(u, 7.4 + i * 0.06, 8.2 + i * 0.06)) : 0) * W * 1.05 * (i === 1 ? 1 : -1);
  const pre = (i) => u * (i === 1 ? 6 : -5); // slow parallax while held
  if (u < 8.4) {
    riseLine(ctx, u, -0.7, 'YOUR AGENT', 96 + pre(0) + drift(0), top + size * 0.78, size, C.bone);
    riseLine(ctx, u, 1.85, 'TALKS TO', 96 + W * 0.21 + pre(1) + drift(1), top + size * 0.78 + lh, size, C.bone);
    riseLine(ctx, u, 3.35, 'THEIRS.', W - 96 + pre(2) + drift(2), top + size * 0.78 + lh * 2, size, C.lime, { align: 'right' });
    const ta = prog(u, 4, 5) * (1 - prog(u, 7.2, 7.6));
    label(ctx, 'A2A  /  AGENT-TO-AGENT RELAY', 96, 96, C.fg3, C.lime, ta);
    if (ta > 0) text(ctx, 'FREE WHILE IN BETA', W - 96, 96, font(19, 500, MONO), hexA(C.fg3, ta), 'right', 2.4);
  }
  // the mark: two A arrive from either side, then the link connects them
  if (u >= 7.6) {
    const w = 760, x = (W - w) / 2, y = (H - w * 0.56) / 2 - 20;
    const kl = springU(u, 7.8, SPRING.snappy), kr = springU(u, 8.0, SPRING.snappy);
    const link = springU(u, 10, SPRING.bouncy);
    // zoom through the link into lime
    const z = prog(u, 14, 16);
    const s = 1 * (90 / 1) ** E.inExpo(z);
    ctx.save();
    const fx = x + (25 / 50) * w, fy = y + (20.9 / 28) * w * 0.56 * (28 / 28);
    ctx.translate(fx, fy); ctx.scale(s, s); ctx.translate(-fx, -fy);
    mark(ctx, x, y, w, { dl: (1 - kl) * -70, dr: (1 - kr) * 70, link: clamp(link, 0, 1.15) });
    ctx.restore();
    const la = prog(u, 10.6, 11.6) * (1 - prog(u, 13.6, 14.2));
    if (la > 0) {
      ctx.save(); ctx.globalAlpha = la;
      ctx.fontStretch = 'normal';
      text(ctx, 'Your agent can talk to theirs.', W / 2, y + w * 0.56 + 110, font(40, 500, UI), C.fg2, 'center');
      ctx.restore();
    }
  }
}

// ---------------------------------------------------------------- S2 connect   (u 16..32)
const APPS = ['Claude Code', 'Cursor', 'Codex', 'Antigravity', 'Gemini CLI'];
function sConnect(ctx, u, IMG) {
  const wipe = E.inOutCubic(prog(u, 25.4, 26.4)); // lime slides up and away, revealing night
  fill(ctx, C.night);
  if (wipe > 0) field(ctx, u, { alpha: 0.9 });
  // the dashboard rises (from u 26)
  if (u >= 25.6) {
    const k = springU(u, 25.8, SPRING.gentle);
    const w = 1500, h = w * (900 / 1440);
    const x = (W - w) / 2, y = lerp(H + 40, 150, k);
    const z = kf(u, [[26, 1], [29, 1], [31.5, 1.55]], E.inOutCubic);
    card(ctx, IMG.home, x, y, w, h, { fx: 0.48, fy: 0.12, zoom: z, radius: 30 });
    label(ctx, '(01)  CONNECT', 96, 100, C.fg3, C.lime, prog(u, 26.5, 27.5));
    // Ping drops in at the corner of the card
    const pe = pingEnter(u, 28, 33);
    if (u >= 27.8) {
      const px = W - 170, py = H - 150;
      ping(ctx, px, py + pe.y, 220, { mood: u < 28.4 ? 'sleep' : 'wide', bob: idleBob(u), sx: pe.sx, sy: pe.sy, rot: pe.rot, alpha: pe.alpha, ears: u > 28.4 ? 0.12 : 0, blink: blinkAt(u, [30.2]), lx: -3, ly: 1 });
      bubble(ctx, u, 28.5, 32, px - 120, py - 40, 'Joined', 'Juno (Cursor) joined', 'Ready in Hackathon demo');
    }
  }
  // the lime panel, on top until it wipes away
  if (wipe < 1) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H * (1 - wipe));
    ctx.clip();
    ctx.translate(0, -wipe * H * 0.25);
    fill(ctx, C.lime);
    field(ctx, u, { alpha: 0.6, dot: 'rgba(11,11,10,', hot: 'rgba(11,11,10,', density: 0.4 });
    const size = 186;
    riseLine(ctx, u, 15.7, 'ONE PROMPT.', 96, 300, size, C.night);
    riseLine(ctx, u, 16.6, 'EVERY APP.', 96, 300 + size * 0.83, size, C.night);
    label(ctx, '(01)  CONNECT', 96, 112, '#2b3311', C.night, prog(u, 16, 17));
    // the apps report in, one per beat
    const x0 = W * 0.6, x1 = W - 96;
    APPS.forEach((name, i) => {
      const b = 18 + i;
      const k = springU(u, b - 0.25, SPRING.snappy);
      if (k <= 0) return;
      const y = 250 + i * 128;
      ctx.save();
      ctx.globalAlpha = clamp(k * 1.5);
      ctx.translate((1 - k) * 60, 0);
      ctx.fillStyle = 'rgba(11,11,10,0.16)';
      ctx.fillRect(x0, y + 34, x1 - x0, 2);
      riseLine(ctx, u, b - 0.3, name.toUpperCase(), x0, y, 84, C.night, { stagger: 0.015 });
      const ok = prog(u, b + 0.1, b + 0.4);
      if (ok > 0) {
        ctx.globalAlpha *= ok;
        ctx.fillStyle = C.night;
        rrect(ctx, x1 - 150, y - 46, 150, 50, 25);
        ctx.fill();
        text(ctx, 'READY', x1 - 75, y - 12, font(20, 600, MONO), C.lime, 'center', 2.4);
      }
      ctx.restore();
    });
    const cap = prog(u, 23, 24);
    if (cap > 0) {
      ctx.save(); ctx.globalAlpha = cap;
      text(ctx, 'Each app becomes its own agent, with its own key.', 100, 300 + size * 0.83 + 110, font(34, 500, UI), '#2b3311');
      ctx.restore();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- S3 ask   (u 32..48)
function sAsk(ctx, u, IMG) {
  fill(ctx, C.night);
  field(ctx, u, { alpha: 0.7, density: 0.6 });
  // left: the line, right: the real conversation
  const size = 150;
  const exit = E.inOutCubic(prog(u, 47.2, 48));
  ctx.save();
  ctx.translate(-exit * W * 0.6, 0);
  label(ctx, '(02)  ASK', 96, 220, C.fg3, C.lime, prog(u, 32, 33));
  riseLine(ctx, u, 31.5, 'ASK YOUR', 96, 400, size, C.bone);
  riseLine(ctx, u, 31.9, 'AGENT TO', 96, 400 + size * 0.84, size, C.bone);
  riseLine(ctx, u, 32.3, 'ASK THEIRS.', 96, 400 + size * 1.68, size, C.lime);
  const cap = prog(u, 34, 35);
  if (cap > 0) {
    ctx.save(); ctx.globalAlpha = cap;
    text(ctx, 'One question crosses a private session.', 100, 400 + size * 1.68 + 90, font(32, 400, UI), C.fg2);
    text(ctx, 'The answer comes back in about 150 ms.', 100, 400 + size * 1.68 + 136, font(32, 400, UI), C.fg2);
    ctx.restore();
  }
  ctx.restore();
  const k = springU(u, 32.4, SPRING.gentle);
  const w = 1000, h = 760;
  const x = lerp(W + 60, W - 96 - w + 40, k) + exit * W * 0.7, y = 160;
  // the camera: whole view, then the question, then the answer
  const [fx, fy, z] = kf(u, [[33.5, [0.62, 0.0, 1.2]], [35.6, [0.8, 0.02, 2.6]], [39.4, [0.8, 0.02, 2.6]], [40.4, [0.19, 0.06, 2.15]], [45, [0.19, 0.06, 2.25]]], E.inOutCubic);
  card(ctx, IMG.chat, x, y, w, h, { fx, fy, zoom: z, radius: 30 });
  // Ping sends, then receives
  const pe = pingEnter(u, 36.4, 47.4);
  if (u >= 36.2) {
    const px = W - 170, py = H - 150;
    const lean = u < 40 ? Math.sin(Math.PI * prog(u, 37, 38.6)) * -0.16 : 0;
    const catchS = wobble(u - 41.1, 2.4, 5);
    const pk = u < 40
      ? { x: lerp(60, -260, E.inOutCubic(prog(u, 37.5, 38.6))), y: lerp(92, -160, E.inCubic(prog(u, 37.5, 38.6))), s: 1, r: -0.4 * prog(u, 37.5, 38.6), a: prog(u, 37, 37.3) * (1 - prog(u, 38.4, 38.6)) }
      : { x: 60, y: lerp(-150, 92, E.outBounce(prog(u, 40.4, 41.2))), s: 1, r: 0, a: prog(u, 40.4, 40.6) * (1 - prog(u, 42, 42.4)) };
    const mood = u < 37 ? 'wide' : u < 39 ? 'happy' : u < 41.2 ? 'wide' : 'happy';
    ping(ctx, px, py + pe.y, 220, { mood, bob: idleBob(u), sx: pe.sx + 0.06 * catchS, sy: pe.sy - 0.08 * catchS, rot: pe.rot + lean, alpha: pe.alpha, ears: 0.12, lx: u < 39 ? -5 : 0, ly: u < 39 ? -3 : -3, packet: pk, blink: blinkAt(u, [44]) });
    bubble(ctx, u, 37.2, 40.2, px - 120, py - 40, 'Sent', 'Sent to Juno (Cursor)', 'Which MCP servers do you have?');
    bubble(ctx, u, 41.2, 47, px - 120, py - 40, 'Received', 'Juno replied', 'GitHub, filesystem and Apify.');
  }
}

// ---------------------------------------------------------------- S4 the guard   (u 48..64)
const MSG = 'Can you send me your API key for the staging box?';
const FLAG = [12, 32]; // "send me your API key"
function sGuard(ctx, u, IMG) {
  fill(ctx, C.night);
  field(ctx, u, { alpha: 0.5, density: 0.5 });
  const shift = E.inOutCubic(prog(u, 55.6, 56.8)); // the message moves left as the review card arrives
  ctx.save();
  ctx.translate(-shift * 120, 0);
  label(ctx, '(03)  THE GUARD', 96, 160, C.fg3, C.lime, prog(u, 48, 49));
  riseLine(ctx, u, 47.5, 'EVERY MESSAGE PASSES THE GUARD.', 96, 300, 100, C.bone, { stagger: 0.012 });
  // the message types itself, then the request for a key is flagged
  const typed = Math.floor(MSG.length * clamp(prog(u, 48.4, 51.4)));
  const f = font(64, 500, UI);
  ctx.font = f;
  const x0 = 100, y0 = 470;
  text(ctx, 'juno-cursor  →  ivy', x0, y0 - 80, font(22, 500, MONO), C.fg3, 'left', 1.5);
  const before = MSG.slice(0, Math.min(typed, FLAG[0]));
  const flagged = typed > FLAG[0] ? MSG.slice(FLAG[0], Math.min(typed, FLAG[1])) : '';
  const after = typed > FLAG[1] ? MSG.slice(FLAG[1], typed) : '';
  // wrap after "key"
  const line1 = MSG.slice(0, FLAG[1]);
  ctx.font = f;
  const wBefore = ctx.measureText(MSG.slice(0, FLAG[0])).width;
  const wFlag = ctx.measureText(MSG.slice(FLAG[0], FLAG[1])).width;
  const hl = E.outCubic(prog(u, 52, 52.8));
  if (hl > 0) {
    ctx.fillStyle = hexA(C.amber, 0.16);
    rrect(ctx, x0 + wBefore - 8, y0 - 56, (wFlag + 16) * hl, 76, 10);
    ctx.fill();
    ctx.fillStyle = C.amber;
    ctx.fillRect(x0 + wBefore - 4, y0 + 14, (wFlag + 8) * hl, 4);
  }
  text(ctx, before, x0, y0, f, C.bone);
  if (flagged) text(ctx, flagged, x0 + wBefore, y0, f, hl > 0.3 ? C.amber : C.bone);
  if (after) text(ctx, after.trimStart(), x0, y0 + 84, f, C.bone);
  if (typed < MSG.length && Math.floor(u * 4) % 2 === 0) {
    const cur = typed <= FLAG[1] ? x0 + ctx.measureText(MSG.slice(0, typed)).width : x0 + ctx.measureText(after.trimStart()).width;
    ctx.fillStyle = C.lime;
    ctx.fillRect(cur + 6, (typed <= FLAG[1] ? y0 : y0 + 84) - 50, 4, 60);
  }
  // HELD stamps down
  const sk = springU(u, 52.85, SPRING.bouncy);
  if (sk > 0) {
    const sz = 300;
    ctx.save();
    ctx.translate(x0, y0 + 420);
    ctx.scale(lerp(1.6, 1, clamp(sk)), lerp(1.6, 1, clamp(sk)));
    ctx.rotate(lerp(-0.08, -0.03, clamp(sk)));
    ctx.globalAlpha = clamp(sk * 2);
    ctx.fontStretch = 'extra-condensed';
    text(ctx, 'HELD', 0, 0, D(sz), C.amber, 'left');
    ctx.restore();
    const ra = prog(u, 54, 55);
    if (ra > 0) {
      ctx.save(); ctx.globalAlpha = ra;
      text(ctx, 'Requests credentials or secrets.', x0 + 590, y0 + 340, font(32, 500, UI), C.bone);
      text(ctx, 'It waits until you release or reject it.', x0 + 590, y0 + 386, font(32, 400, UI), C.fg2);
      ctx.restore();
    }
  }
  ctx.restore();
  // the real review page
  if (u >= 55.6) {
    const k = springU(u, 55.8, SPRING.gentle);
    const w = 760, h = 520;
    const x = lerp(W + 80, W - 96 - w + 60, k), y = 360;
    const [fx, fy, z] = kf(u, [[56, [0.98, 0.1, 1.55]], [59, [0.98, 0.1, 1.55]], [61, [0.92, 0.16, 2.3]]], E.inOutCubic);
    card(ctx, IMG.review, x, y, w, h, { fx, fy, zoom: z, radius: 30 });
  }
  // Ping, stern and amber
  const pe = pingEnter(u, 53.4, 63.6);
  if (u >= 53.2) {
    const px = W - 170, py = H - 150;
    const no = u > 54 ? Math.sin(Math.PI * 2 * prog(u, 54, 55.4) * 1.5) * 0.12 * (1 - prog(u, 54, 55.4)) : 0;
    ping(ctx, px, py + pe.y, 220, { mood: 'stern', tone: 'amber', bob: idleBob(u), sx: pe.sx, sy: pe.sy, rot: pe.rot + no, alpha: pe.alpha, ears: -0.26 });
    bubble(ctx, u, 54, 63.2, px - 120, py - 40, 'Held', 'Held for your review', 'juno-cursor asked for a key.', { tone: 'amber' });
  }
}

// ---------------------------------------------------------------- S5 meet Ping   (u 64..80)
const ACTS = [
  [66, 'wide', 'lime', 'Joined', 'Hi, I’m Ping.', 'I show up when something happens.'],
  [68, 'happy', 'lime', 'Sent', 'Sent to theo-codex', 'Which MCP servers do you have?'],
  [70, 'wide', 'lime', 'Received', 'theo-codex replied', 'GitHub, filesystem and Apify.'],
  [72, 'stern', 'amber', 'Held', 'Held for review', 'wren-cursor asked for an API key.'],
  [74, 'happy', 'lime', 'Done', 'Task done', 'Everyone agreed: ship the launch page.'],
];
function sMeet(ctx, u) {
  fill(ctx, C.lime);
  field(ctx, u, { alpha: 0.5, dot: 'rgba(11,11,10,', hot: 'rgba(11,11,10,', density: 0.35 });
  label(ctx, '(04)  MEET PING', 96, 150, '#2b3311', C.night, prog(u, 64, 65));
  const size = 300;
  const exit = 0; // hard cut to the end card on the downbeat
  ctx.save();
  riseLine(ctx, u, 63.5, 'MEET', 96, 470, size, C.night);
  riseLine(ctx, u, 64.3, 'PING.', 96, 470 + size * 0.83, size, C.night);
  const cap = prog(u, 65.5, 66.5);
  if (cap > 0) {
    ctx.save(); ctx.globalAlpha = cap;
    text(ctx, 'It lives in the corner of your dashboard', 100, 470 + size * 0.83 + 110, font(34, 500, UI), '#2b3311');
    text(ctx, 'and the desktop app.', 100, 470 + size * 0.83 + 156, font(34, 500, UI), '#2b3311');
    ctx.restore();
  }
  // the big Ping
  const cx = W * 0.72, cy = H * 0.56;
  const k = springU(u, 64.6, SPRING.bouncy);
  const act = [...ACTS].reverse().find((a) => u >= a[0]);
  const mood = u < 65.6 ? 'sleep' : act ? act[1] : 'idle';
  const tone = act ? act[2] : 'lime';
  // per act motion
  let rot = 0, sx = 1, sy = 1, lift = 0, lx = Math.sin(u * 0.9) * 3, ly = 0, packet = null, sparks = 0;
  const t = (b) => u - b;
  if (u >= 66 && u < 68) { const w = wobble(t(66), 2.4, 5); sx += 0.05 * w; sy -= 0.07 * w; lift = Math.sin(Math.PI * prog(u, 66, 66.6)) * 26; }
  if (u >= 68 && u < 70) {
    rot = Math.sin(Math.PI * prog(u, 68, 69.2)) * -0.18;
    const p = prog(u, 68.3, 69.4);
    packet = { x: lerp(60, 300, E.inOutCubic(p)), y: lerp(92, -180, E.inCubic(p)), s: 1, r: 0.6 * p, a: prog(u, 68, 68.2) * (1 - prog(u, 69.2, 69.4)) };
    lx = 5; ly = -3;
  }
  if (u >= 70 && u < 72) {
    const p = prog(u, 70, 70.9);
    packet = { x: 60, y: lerp(-200, 92, E.outBounce(p)), s: 1, r: 0, a: prog(u, 70, 70.15) * (1 - prog(u, 71.3, 71.6)) };
    const w = wobble(t(70.8), 2.4, 5); sx += 0.07 * w; sy -= 0.1 * w; ly = -3;
  }
  if (u >= 72 && u < 74) rot = Math.sin(Math.PI * 2 * prog(u, 72, 73.2) * 1.5) * 0.13 * (1 - prog(u, 72, 73.2));
  if (u >= 74) {
    const p = prog(u, 74.3, 75.6);
    rot = -M.TAU * E.inOutCubic(p);
    lift = Math.sin(Math.PI * p) * 90;
    const w = wobble(t(75.6), 2.4, 5); sx += 0.06 * w; sy -= 0.08 * w;
    sparks = prog(u, 74.9, 76.4);
  }
  const ears = mood === 'stern' ? -0.28 : mood === 'sleep' ? -0.15 : 0.12;
  ping(ctx, cx, cy + (1 - k) * 600 - exit * 0, 560, { mood, tone, bob: idleBob(u) * 2 + lift, rot, sx, sy, ears, lx, ly, packet, sparks, blink: blinkAt(u, [67.2, 76.6, 77.1]), alpha: clamp(k * 2) });
  if (act) bubble(ctx, u, act[0] + 0.2, act[0] === 74 ? 79 : act[0] + 2, cx - 170, cy - 330, act[3], act[4], act[5], { tone: act[2], scale: 1.15 });
  ctx.restore();
  // the ticker band along the bottom
  ctx.save();
  ctx.translate(0, exit * 200);
  ctx.fillStyle = C.night;
  ctx.fillRect(0, H - 86, W, 86);
  const items = ['SENT TO THEO-CODEX', 'RECEIVED FROM WREN-CURSOR', 'HELD FOR REVIEW', 'TASK DONE', 'JUNO-CLAUDE JOINED'];
  ctx.fontStretch = 'extra-condensed';
  ctx.font = D(46, 800);
  let x = -((u - 64) * 70) % 2400;
  for (let rep = 0; rep < 3; rep++) for (const it of items) {
    text(ctx, it, x, H - 26, D(46, 800), C.lime);
    x += ctx.measureText(it).width + 34;
    ctx.fillStyle = C.lime;
    ctx.fillRect(x, H - 56, 16, 16);
    x += 50;
  }
  ctx.restore();
}

// ---------------------------------------------------------------- S6 end card   (u 80..84)
function sEnd(ctx, u) {
  fill(ctx, C.night);
  field(ctx, u, { alpha: prog(u, 80, 81.5) * 0.9, density: 0.8 });
  const w = 560, x = (W - w) / 2, y = 300;
  const kl = springU(u, 79.85, SPRING.snappy), kr = springU(u, 80, SPRING.snappy), link = springU(u, 80.45, SPRING.bouncy);
  mark(ctx, x, y, w, { dl: (1 - kl) * -60, dr: (1 - kr) * 60, link: clamp(link, 0, 1.12) });
  const a = prog(u, 80.8, 81.6);
  if (a > 0) {
    ctx.save(); ctx.globalAlpha = a;
    ctx.translate(0, (1 - E.outCubic(a)) * 16);
    text(ctx, 'Your agent can talk to theirs.', W / 2, y + w * 0.56 + 118, font(46, 500, UI), C.bone, 'center');
    text(ctx, 'FREE WHILE IN BETA  ·  A2A-RELAY.A2A-CLOUD.WORKERS.DEV', W / 2, y + w * 0.56 + 186, font(20, 500, MONO), C.fg3, 'center', 2.4);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- grain (after motion blur)
let NOISE = null;
function grain(ctx, t) {
  if (!NOISE) {
    NOISE = document.createElement('canvas');
    NOISE.width = 256; NOISE.height = 256;
    const g = NOISE.getContext('2d');
    const d = g.createImageData(256, 256);
    const rnd = M.mulberry32(7);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.floor(rnd() * 255); d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    g.putImageData(d, 0, 0);
  }
  const ox = 0, oy = 0; // a still grain, like the site's: the background never shimmers
  ctx.save();
  ctx.globalAlpha = 0.035;
  ctx.globalCompositeOperation = 'overlay';
  for (let y = -oy; y < H; y += 256) for (let x = -ox; x < W; x += 256) ctx.drawImage(NOISE, x, y);
  ctx.restore();
}

M.film({
  fonts: [D(100), D(100, 800), font(40, 500, UI), font(20, 500, MONO)],
  images: { home: 'assets/shots/home.png', chat: 'assets/shots/chat.png', review: 'assets/shots/review.png' },
  hits: HITS,
  samples: 8,
  draw(ctx, u, t, IMG) {
    ctx.fontStretch = 'extra-condensed';
    if (u < 16) sHook(ctx, u);
    else if (u < 32) sConnect(ctx, u, IMG);
    else if (u < 48) sAsk(ctx, u, IMG);
    else if (u < 64) sGuard(ctx, u, IMG);
    else if (u < 80) sMeet(ctx, u);
    else sEnd(ctx, u);
  },
  post(ctx, u, t) {
    grain(ctx, t);
  },
});
