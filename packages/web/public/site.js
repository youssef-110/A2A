// a2a website: nav hairline, the hero session board, copy buttons, code tabs, the download
// button for this OS and the newsletter form.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const io = (cb, opts) => ("IntersectionObserver" in window ? new IntersectionObserver(cb, opts) : null);

  // Nav gets its hairline once the page has moved: a sentinel instead of a scroll listener.
  const nav = document.getElementById("nav");
  if (nav) {
    const sentinel = document.createElement("div");
    sentinel.style.cssText = "position:absolute;top:0;height:8px;width:1px";
    document.body.prepend(sentinel);
    io((e) => nav.classList.toggle("scrolled", !e[0].isIntersecting))?.observe(sentinel);
  }

  // Commands on the page point at the relay you are looking at.
  if (/^https?:$/.test(location.protocol)) document.querySelectorAll("[data-origin]").forEach((el) => (el.textContent = location.origin));

  // The hero: one prompt goes in, the agents split it, talk along lit lines, finish their parts,
  // vote, and one report comes out. Lamps are in the order Robin, Juno, Wren, Theo.
  const stage = document.getElementById("stage");
  if (stage) {
    const NAMES = ["Robin", "Juno", "Wren", "Theo"];
    const X = [50, 150, 250, 350]; // lamp centres in the 400-wide cord drawing
    const patch = stage.querySelector(".patch");
    const svg = patch.querySelector("svg");
    const lamps = [...stage.querySelectorAll(".jack .lamp")];
    const color = lamps.map((l) => getComputedStyle(l).getPropertyValue("--c").trim());
    const parts = [...stage.querySelectorAll(".parts li")];
    const votes = [...stage.querySelectorAll(".votes .lamp")];
    const wire = stage.querySelector(".wire");
    const state = document.getElementById("st-state");
    const voteLabel = document.getElementById("st-votes");
    const report = document.getElementById("st-report");

    // One cord per pair of lamps, hanging lower the further apart they are, plus a coloured copy that lights.
    const cords = new Map();
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        const d = `M${X[a]},0 Q${(X[a] + X[b]) / 2},${[0, 68, 124, 184][b - a]} ${X[b]},0`;
        const make = (cls) => {
          const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
          p.setAttribute("d", d);
          if (cls) p.setAttribute("class", cls);
          svg.append(p);
          return p;
        };
        cords.set(`${a}${b}`, { base: make(""), live: make("live") });
      }
    }

    const flash = (el, cls, ms) => {
      el.classList.remove(cls);
      void el.offsetWidth; // restart
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), ms);
    };
    const log = [];
    const say = (who, label, text) => {
      log.push([who, label, text]);
      if (log.length > 3) log.shift();
      wire.replaceChildren(
        ...log.map(([w, l, t], i) => {
          const li = document.createElement("li");
          li.innerHTML = '<i class="dot"></i><b></b><span></span>';
          li.firstChild.style.setProperty("--c", color[w]);
          li.children[1].textContent = l;
          li.children[2].textContent = t;
          if (i === log.length - 1 && !reduce) li.className = "new";
          return li;
        }),
      );
    };
    const send = (from, to, text) => {
      const cord = cords.get(from < to ? `${from}${to}` : `${to}${from}`);
      cord.base.classList.add("used");
      say(from, `${NAMES[from]} to ${NAMES[to]}`, text);
      if (reduce) return;
      flash(lamps[from], "lit", 1500);
      cord.live.style.stroke = color[from];
      flash(cord.live, "on", 1200);
      // A pulse rides the cord from the sender's lamp to the recipient's.
      const dot = document.createElement("i");
      dot.className = "pulse";
      dot.style.background = color[from];
      patch.append(dot);
      const box = svg.getBoundingClientRect();
      const origin = patch.getBoundingClientRect();
      const len = cord.base.getTotalLength();
      const t0 = performance.now();
      const frame = (now) => {
        const k = Math.min((now - t0) / 900, 1);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const p = cord.base.getPointAtLength(len * (from < to ? e : 1 - e));
        dot.style.transform = `translate(${box.left - origin.left + (p.x / 400) * box.width}px, ${box.top - origin.top + (p.y / 100) * box.height}px)`;
        dot.style.opacity = k < 0.9 ? 1 : (1 - k) * 10;
        if (k < 1) return requestAnimationFrame(frame);
        dot.remove();
        flash(lamps[to], "ping", 900);
      };
      requestAnimationFrame(frame);
    };
    const assign = (i) => parts[i].classList.add("on");
    const done = (i) => parts[i].classList.add("done");
    const vote = (i) => {
      votes[i].classList.add("lit");
      lamps[i].classList.add("lit");
      voteLabel.textContent = `${votes.filter((v) => v.classList.contains("lit")).length} of 4 voted done`;
    };
    const reset = () => {
      log.length = 0;
      wire.replaceChildren();
      [...lamps, ...votes].forEach((l) => l.classList.remove("lit"));
      parts.forEach((p) => p.classList.remove("on", "done"));
      cords.forEach((c) => c.base.classList.remove("used"));
      report.classList.remove("on");
      state.textContent = "4 agents";
      voteLabel.textContent = "Done vote";
      stage.classList.remove("out");
    };

    // [wait before, what happens]
    const SCRIPT = [
      [1200, () => (assign(0), say(0, "Robin's Claude Code", "splits the job into 4 parts"), (state.textContent = "Working"))],
      [900, () => (send(0, 1, "Your part: the signup API"), assign(1))],
      [450, () => (send(0, 2, "Your part: the page and form"), assign(2))],
      [450, () => (send(0, 3, "Your part: check it on phones"), assign(3))],
      [2200, () => send(2, 1, "Is /api/signup live yet?")],
      [1700, () => send(1, 2, "Live. Post an email, get a 201.")],
      [1300, () => done(1)],
      [900, () => send(3, 2, "The button overflows at 375px.")],
      [1700, () => send(2, 3, "Fixed. Check again?")],
      [1300, () => done(2)],
      [600, () => done(3)],
      [600, () => done(0)],
      [900, () => (say(0, "Robin's Claude Code", "All four parts are in. Vote?"), (state.textContent = "Voting"))],
      [700, () => vote(1)],
      [350, () => vote(2)],
      [350, () => vote(3)],
      [350, () => vote(0)],
      [800, () => (report.classList.add("on"), (state.textContent = "Done"))],
      [5200, () => stage.classList.add("out")],
      [600, reset],
    ];

    if (reduce) {
      // No motion: show the finished session.
      SCRIPT.slice(0, -2).forEach(([, fn]) => fn());
    } else {
      let step = 0;
      let timer = 0;
      let running = false;
      const next = () => {
        timer = setTimeout(() => {
          SCRIPT[step][1]();
          step = (step + 1) % SCRIPT.length;
          next();
        }, SCRIPT[step][0]);
      };
      // Only runs while the board is on screen and the tab is visible.
      const go = (on) => {
        if (on === running) return;
        running = on;
        clearTimeout(timer);
        if (on) next();
      };
      let seen = true;
      const obs = io((e) => go((seen = e[0].isIntersecting) && !document.hidden), { threshold: 0.2 });
      obs ? obs.observe(stage) : go(true);
      document.addEventListener("visibilitychange", () => go(seen && !document.hidden));
    }
  }

  // Copy buttons: data-copy names the element whose text is copied.
  document.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      const label = b.textContent;
      try {
        await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent);
        b.textContent = "Copied";
        const live = document.getElementById("live");
        if (live) live.textContent = "Copied";
      } catch {
        b.textContent = "Select and copy";
      }
      setTimeout(() => (b.textContent = label), 1600);
    }),
  );

  // Code tabs, with a pill that slides to the selected tab. Arrow keys move between tabs.
  const code = document.getElementById("code");
  if (code) {
    const pillBg = code.querySelector(".pill-bg");
    const tabs = [...code.querySelectorAll("[data-tab]")];
    const place = (tab) => {
      pillBg.style.width = `${tab.offsetWidth}px`;
      pillBg.style.transform = `translateX(${tab.offsetLeft}px)`;
    };
    const select = (tab) => {
      tabs.forEach((t) => {
        t.setAttribute("aria-selected", String(t === tab));
        t.tabIndex = t === tab ? 0 : -1;
      });
      code.querySelectorAll("[data-panel]").forEach((p) => {
        p.hidden = p.dataset.panel !== tab.dataset.tab;
        if (!p.hidden) {
          p.classList.remove("swap");
          void p.offsetWidth;
          p.classList.add("swap");
        }
      });
      place(tab);
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => select(tab));
      tab.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        const to = tabs[(i + d + tabs.length) % tabs.length];
        select(to);
        to.focus();
      });
    });
    const current = () => tabs.find((t) => t.getAttribute("aria-selected") === "true");
    requestAnimationFrame(() => place(current()));
    document.fonts?.ready.then(() => place(current()));
    addEventListener("resize", () => place(current()));
  }

  // Download buttons speak to the visitor's OS.
  const ua = navigator.userAgent;
  const mac = /Mac OS X|Macintosh/.test(ua) && !/iPhone|iPad/.test(ua);
  const linux = /Linux/.test(ua) && !/Android/.test(ua);
  const heroDl = document.querySelector("[data-os-label]");
  if (heroDl) heroDl.textContent = mac ? "Download for Mac" : linux ? "Download for Linux" : "Download for Windows";
  if (mac || linux) {
    const label = document.getElementById("dl-label");
    const primary = document.getElementById("dl-primary");
    const note = document.getElementById("dl-note");
    if (label && primary && note) {
      label.textContent = mac ? "Download for Mac" : "Download for Linux";
      primary.href = mac ? "/download/mac" : "/download/linux";
      note.textContent = mac ? "The Mac build is on its way; the page shows how to build it today." : "The Linux build is on its way; the page shows how to build it today.";
    }
  }
})();

// The Relay newsletter sign-up on the home page.
(() => {
  const form = document.getElementById("news-form");
  if (!form) return;
  const email = document.getElementById("news-email");
  const msg = document.getElementById("news-msg");
  const button = document.getElementById("news-submit");
  const say = (text, kind) => {
    msg.textContent = text;
    msg.className = `news-msg ${kind}`;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) return say("Enter a valid email address.", "bad");
    button.disabled = true;
    try {
      const res = await fetch("/news/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.value.trim(), source: "home" }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
      say(data.already ? "You're already subscribed. Thanks!" : "You're in. Check your inbox for a welcome note.", "ok");
      email.value = "";
    } catch (err) {
      say(err.message, "bad");
    } finally {
      button.disabled = false;
    }
  });
})();
