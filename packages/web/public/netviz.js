// netviz: a live map of agents and the messages between them. Used by the dashboard (session and
// workspace maps) and the landing page demo. No dependencies; SVG plus requestAnimationFrame.
//
//   const net = createNetwork(svgElement, { width, height });
//   net.update(nodes, edges);                 // nodes: [{ id, label, sub, initials, colors: [bg, ink], online, status, hub }]
//   net.send(fromId, toId, { tone, label });  // tone: "msg" | "reply" | "board" | "held" | "blocked" | "done"
//
// Positions are stable: the hub sits in the middle, everyone else on an ellipse in id order.

const NS = "http://www.w3.org/2000/svg";
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function el(tag, attrs, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

const STYLE = `
.nv { display: block; width: 100%; height: auto; overflow: visible; font-family: var(--font, var(--sans, system-ui, sans-serif)); }
.nv .nv-edge { fill: none; stroke: var(--nv-line, rgb(255 255 255 / 0.12)); stroke-linecap: round; transition: stroke 0.6s, stroke-opacity 0.6s; }
.nv .nv-edge.board { stroke-dasharray: 1 7; }
.nv .nv-edge.live { stroke: var(--nv-line-live, rgb(255 255 255 / 0.28)); }
.nv .nv-edge.hot { stroke: var(--nv-hot, rgb(255 255 255 / 0.7)); transition: stroke 0.08s; }
.nv .nv-edge.hot.board { stroke: var(--nv-signal, #2997ff); }
.nv .nv-node { transition: opacity 0.4s; }
.nv .nv-node.off { opacity: 0.42; }
.nv .nv-body { transform-box: fill-box; transform-origin: center; transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
.nv .nv-node.bump .nv-body { transform: scale(1.12); transition: transform 0.12s ease-out; }
.nv .nv-face { stroke: rgb(0 0 0 / 0.25); stroke-width: 1; }
.nv .nv-ini { font-weight: 650; font-size: 14px; text-anchor: middle; dominant-baseline: central; letter-spacing: -0.02em; pointer-events: none; }
.nv .nv-ring { fill: none; stroke: var(--nv-line, rgb(255 255 255 / 0.12)); stroke-width: 2; }
.nv .st-working .nv-ring, .nv .st-coordinating .nv-ring { stroke: var(--nv-signal, #2997ff); stroke-dasharray: 10 6; animation: nv-spin 6s linear infinite; transform-box: fill-box; transform-origin: center; }
.nv .st-blocked .nv-ring { stroke: var(--nv-hold, #ff9f0a); }
.nv .st-done .nv-ring { stroke: var(--nv-allow, #30d158); }
.nv .nv-dot { fill: var(--nv-line, rgb(255 255 255 / 0.2)); stroke: var(--nv-bg, #111); stroke-width: 2.5; }
.nv .nv-node.on .nv-dot { fill: var(--nv-allow, #30d158); }
.nv .nv-name { fill: var(--nv-ink, #f5f5f7); font-size: 12.5px; font-weight: 560; text-anchor: middle; letter-spacing: -0.01em; }
.nv .nv-sub { fill: var(--nv-ink-3, #8e8e93); font-size: 11px; text-anchor: middle; }
.nv .nv-hub-core { fill: var(--nv-hub, #18181a); stroke: var(--nv-line-live, rgb(255 255 255 / 0.22)); stroke-width: 1.5; }
.nv .nv-hub-halo { fill: none; stroke: var(--nv-signal, #2997ff); stroke-opacity: 0.35; animation: nv-breathe 3.2s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
.nv .nv-hub-t { fill: var(--nv-ink-2, #c7c7cc); font-size: 10.5px; font-weight: 560; text-anchor: middle; dominant-baseline: central; letter-spacing: 0.02em; }
.nv .nv-trail { fill: none; stroke-linecap: round; stroke-width: 3; }
.nv .nv-head { filter: url(#nv-glow); }
.nv .nv-ripple { fill: none; stroke-width: 2; }
.nv .nv-chip rect { fill: var(--nv-chip, rgb(28 28 30 / 0.92)); stroke: var(--nv-line-live, rgb(255 255 255 / 0.16)); }
.nv .nv-chip text { fill: var(--nv-ink, #f5f5f7); font-size: 11.5px; dominant-baseline: central; }
.nv .nv-chip { transition: opacity 0.4s, transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
.nv .t-msg { stroke: var(--nv-ink, #f5f5f7); fill: var(--nv-ink, #f5f5f7); color: var(--nv-ink, #f5f5f7); }
.nv .t-reply { stroke: var(--nv-allow, #30d158); fill: var(--nv-allow, #30d158); color: var(--nv-allow, #30d158); }
.nv .t-board { stroke: var(--nv-signal, #2997ff); fill: var(--nv-signal, #2997ff); color: var(--nv-signal, #2997ff); }
.nv .t-held { stroke: var(--nv-hold, #ff9f0a); fill: var(--nv-hold, #ff9f0a); color: var(--nv-hold, #ff9f0a); }
.nv .t-blocked { stroke: var(--nv-block, #ff6961); fill: var(--nv-block, #ff6961); color: var(--nv-block, #ff6961); }
.nv .t-done { stroke: var(--nv-allow, #30d158); fill: var(--nv-allow, #30d158); color: var(--nv-allow, #30d158); }
.nv .nv-ripple.t-msg, .nv .nv-ripple.t-reply, .nv .nv-ripple.t-board, .nv .nv-ripple.t-held, .nv .nv-ripple.t-blocked, .nv .nv-ripple.t-done { fill: none; }
.nv .nv-trail.t-msg, .nv .nv-trail.t-reply, .nv .nv-trail.t-board, .nv .nv-trail.t-held, .nv .nv-trail.t-blocked, .nv .nv-trail.t-done { fill: none; }
@keyframes nv-spin { to { transform: rotate(360deg); } }
@keyframes nv-breathe { 50% { transform: scale(1.12); stroke-opacity: 0.08; } }
@media (prefers-reduced-motion: reduce) { .nv .st-working .nv-ring, .nv .st-coordinating .nv-ring, .nv .nv-hub-halo { animation: none; } }
`;

function injectStyle() {
  if (document.getElementById("nv-style")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "nv-style", textContent: STYLE }));
}

/** A gentle curve between two points; the bend side depends on the pair's order so it is stable. */
function curve(p, q, bend = 0.14) {
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  return { x: mx - dy * bend, y: my + dx * bend };
}

const quad = (p, c, q, t) => ({ x: (1 - t) ** 2 * p.x + 2 * (1 - t) * t * c.x + t * t * q.x, y: (1 - t) ** 2 * p.y + 2 * (1 - t) * t * c.y + t * t * q.y });
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function createNetwork(svg, opts = {}) {
  injectStyle();
  const W = opts.width ?? 760;
  const H = opts.height ?? 470;
  const R = opts.radius ?? 25;
  svg.classList.add("nv");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const glow = el(
    "filter",
    { id: "nv-glow", x: "-200%", y: "-200%", width: "500%", height: "500%" },
    el("feGaussianBlur", { stdDeviation: 3.2, result: "b" }),
    el("feMerge", {}, el("feMergeNode", { in: "b" }), el("feMergeNode", { in: "SourceGraphic" })),
  );
  const edgesL = el("g", { class: "nv-edges" });
  const nodesL = el("g", { class: "nv-nodes" });
  const fxL = el("g", { class: "nv-fx" });
  svg.replaceChildren(el("defs", {}, glow), edgesL, nodesL, fxL);

  let pos = new Map();
  let nodeEls = new Map();
  let edgeEls = new Map();
  const lastActive = new Map();
  const chips = new Map();
  let hubId = null;

  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  function layout(nodes) {
    const ring = nodes.filter((n) => !n.hub);
    const hub = nodes.find((n) => n.hub);
    hubId = hub?.id ?? null;
    const m = new Map();
    if (hub) m.set(hub.id, { x: W / 2, y: H / 2 });
    const rx = W / 2 - 90;
    const ry = H / 2 - 70;
    ring.forEach((n, i) => {
      const a = (i / Math.max(ring.length, 1)) * Math.PI * 2 - Math.PI / 2;
      m.set(n.id, { x: W / 2 + Math.cos(a) * rx, y: H / 2 + Math.sin(a) * ry });
    });
    return m;
  }

  function nodeEl(n) {
    const [bg, ink] = n.colors ?? ["#2c2c2e", "#f5f5f7"];
    if (n.hub) {
      return el(
        "g",
        { class: "nv-node hub" },
        el("circle", { r: R + 12, class: "nv-hub-halo" }),
        el("g", { class: "nv-body" }, el("circle", { r: R + 6, class: "nv-hub-core" }), el("text", { class: "nv-hub-t", y: 0 }, n.label ?? "Task board")),
        n.sub ? el("text", { class: "nv-sub", y: R + 26 }, n.sub) : null,
      );
    }
    return el(
      "g",
      { class: `nv-node ${n.online ? "on" : "off"} ${n.status ? `st-${n.status}` : ""}` },
      el("title", {}, n.title ?? n.label),
      el("circle", { r: R + 5, class: "nv-ring" }),
      el("g", { class: "nv-body" }, el("circle", { r: R, class: "nv-face", fill: bg }), el("text", { class: "nv-ini", fill: ink }, n.initials ?? "?")),
      el("circle", { r: 5, cx: R * 0.72, cy: -R * 0.72, class: "nv-dot" }),
      el("text", { class: "nv-name", y: R + 21 }, n.label),
      n.sub ? el("text", { class: "nv-sub", y: R + 36 }, n.sub) : null,
    );
  }

  function edgePath(a, b) {
    const p = pos.get(a);
    const q = pos.get(b);
    const [s, t] = a < b ? [p, q] : [q, p];
    const c = curve(s, t);
    return `M${s.x},${s.y} Q${c.x},${c.y} ${t.x},${t.y}`;
  }

  function update(nodes, edges = []) {
    pos = layout(nodes);
    const nextNodes = new Map();
    for (const n of nodes) {
      const g = nodeEl(n);
      const p = pos.get(n.id);
      g.setAttribute("transform", `translate(${p.x} ${p.y})`);
      g.dataset.id = n.id;
      nextNodes.set(n.id, g);
    }
    nodesL.replaceChildren(...nextNodes.values());
    nodeEls = nextNodes;
    const nextEdges = new Map();
    const now = performance.now();
    for (const e of edges) {
      if (!pos.has(e.a) || !pos.has(e.b) || e.a === e.b) continue;
      const k = key(e.a, e.b);
      const live = now - (lastActive.get(k) ?? -1e9) < 20_000;
      const path = el("path", { d: edgePath(e.a, e.b), class: `nv-edge ${e.board ? "board" : ""} ${live ? "live" : ""}`, "stroke-width": Math.min(1.2 + Math.log2((e.weight ?? 1) + 1), 5).toFixed(2) });
      nextEdges.set(k, path);
    }
    edgesL.replaceChildren(...nextEdges.values());
    edgeEls = nextEdges;
  }

  function ripple(at, tone, from = R, to = R + 26, dur = 900) {
    const c = el("circle", { cx: at.x, cy: at.y, r: from, class: `nv-ripple t-${tone}`, "stroke-opacity": 0.8 });
    fxL.append(c);
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min((now - t0) / dur, 1);
      const e = 1 - (1 - k) ** 3;
      c.setAttribute("r", from + (to - from) * e);
      c.setAttribute("stroke-opacity", (0.8 * (1 - k)).toFixed(3));
      if (k < 1) requestAnimationFrame(step);
      else c.remove();
    };
    requestAnimationFrame(step);
  }

  function chip(id, at, text, tone) {
    if (!text) return;
    chips.get(id)?.remove();
    const label = text.length > 46 ? `${text.slice(0, 45)}…` : text;
    const w = Math.min(14 + label.length * 6.3, 300);
    const above = at.y > H / 2 ? -1 : 1;
    let x = at.x - w / 2;
    x = Math.max(6, Math.min(W - w - 6, x));
    // Below a node sit its name and app, so a chip there goes under them; above, it can sit close.
    const y = above > 0 ? at.y + R + 46 : at.y - R - 40;
    const g = el(
      "g",
      { class: "nv-chip", opacity: 0, transform: `translate(0 ${above * -6})` },
      el("rect", { x, y, width: w, height: 26, rx: 13 }),
      el("circle", { cx: x + 12, cy: y + 13, r: 3.5, class: `t-${tone}` }),
      el("text", { x: x + 21, y: y + 13 }, label),
    );
    fxL.append(g);
    chips.set(id, g);
    requestAnimationFrame(() => {
      g.setAttribute("opacity", 1);
      g.setAttribute("transform", "translate(0 0)");
    });
    setTimeout(() => {
      g.setAttribute("opacity", 0);
      setTimeout(() => {
        g.remove();
        if (chips.get(id) === g) chips.delete(id);
      }, 450);
    }, opts.chipMs ?? 2600);
  }

  function bump(id) {
    const n = nodeEls.get(id);
    if (!n) return;
    n.classList.add("bump");
    setTimeout(() => n.classList.remove("bump"), 160);
  }

  /** Animates one message: a comet along the edge, a ripple and a short chip at the recipient. */
  function send(from, to, { tone = "msg", label = "", duration } = {}) {
    const p = pos.get(from);
    const q = pos.get(to);
    if (!p || !q || from === to) return;
    const k = key(from, to);
    lastActive.set(k, performance.now());
    const edge = edgeEls.get(k);
    edge?.classList.add("live", "hot");
    setTimeout(() => edge?.classList.remove("hot"), 700);
    if (reduced()) {
      bump(to);
      chip(to, q, label, tone);
      return;
    }
    const [s, t] = from < to ? [p, q] : [q, p];
    const c = curve(s, t);
    const forward = from < to;
    const at = (u) => quad(s, c, t, forward ? u : 1 - u);
    const dur = duration ?? Math.min(1300, 700 + Math.hypot(q.x - p.x, q.y - p.y) * 0.9);
    const trail = el("path", { class: `nv-trail t-${tone}`, "stroke-opacity": 0.85 });
    const head = el("circle", { r: 5, class: `nv-head t-${tone}`, cx: p.x, cy: p.y });
    fxL.append(trail, head);
    ripple(p, tone, R, R + 12, 500);
    const t0 = performance.now();
    const step = (now) => {
      const k2 = Math.min((now - t0) / dur, 1);
      const u = ease(k2);
      const tail = Math.max(0, u - 0.22);
      const pts = [];
      for (let i = 0; i <= 10; i++) pts.push(at(tail + ((u - tail) * i) / 10));
      trail.setAttribute("d", `M${pts.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" L")}`);
      const hp = at(u);
      head.setAttribute("cx", hp.x);
      head.setAttribute("cy", hp.y);
      if (k2 < 1) return requestAnimationFrame(step);
      head.remove();
      const fade = performance.now();
      const out = (n2) => {
        const f = Math.min((n2 - fade) / 300, 1);
        trail.setAttribute("stroke-opacity", (0.85 * (1 - f)).toFixed(3));
        if (f < 1) requestAnimationFrame(out);
        else trail.remove();
      };
      requestAnimationFrame(out);
      ripple(q, tone);
      bump(to);
      chip(to, q, label, tone);
    };
    requestAnimationFrame(step);
  }

  return { update, send, get hub() { return hubId; }, positions: () => pos };
}
