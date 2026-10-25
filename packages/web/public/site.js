// a2a website: headline entrance, nav hairline, the hero conversation, the pinned
// how-it-works story, bento reveals, code tabs and the download button for this OS.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const io = (cb, opts) => ("IntersectionObserver" in window ? new IntersectionObserver(cb, opts) : null);

  // Headline: one span per word so the words can lift in on a stagger.
  const headline = document.getElementById("headline");
  if (headline) {
    const words = headline.textContent.trim().split(/\s+/);
    headline.setAttribute("aria-label", headline.textContent.trim());
    headline.replaceChildren(
      ...words.flatMap((w, i) => {
        const s = document.createElement("span");
        s.className = "w";
        s.style.setProperty("--i", i);
        s.setAttribute("aria-hidden", "true");
        s.textContent = w;
        return i < words.length - 1 ? [s, " "] : [s];
      }),
    );
  }

  // Nav gets its hairline once the page has moved: a sentinel instead of a scroll listener.
  const nav = document.getElementById("nav");
  if (nav) {
    const sentinel = document.createElement("div");
    sentinel.style.cssText = "position:absolute;top:0;height:8px;width:1px";
    document.body.prepend(sentinel);
    io((e) => nav.classList.toggle("scrolled", !e[0].isIntersecting))?.observe(sentinel);
  }

  // The hero: your agent asks, the question crosses the session, David's agent answers, it comes back.
  const stage = document.getElementById("stage");
  if (stage) {
    const lines = [...stage.querySelectorAll(".line")];
    const packet = document.getElementById("packet");
    const show = (step) => lines.filter((l) => Number(l.dataset.step) === step).forEach((l) => l.classList.add("show"));
    const fly = (dir) => {
      packet.classList.remove("go-right", "go-left");
      void packet.offsetWidth; // restart the animation
      packet.classList.add(dir);
    };
    if (reduce) lines.forEach((l) => l.classList.add("show"));
    else {
      const timeline = [
        [500, () => show(0)],
        [1400, () => show(1)],
        [1900, () => fly("go-right")],
        [2900, () => show(2)],
        [3800, () => show(3)],
        [4700, () => show(4)],
        [5000, () => fly("go-left")],
        [6000, () => show(5)],
      ];
      let timers = [];
      const run = () => {
        lines.forEach((l) => l.classList.remove("show"));
        timers = timeline.map(([t, fn]) => setTimeout(fn, t));
      };
      let loop;
      const start = () => {
        if (loop) return;
        setTimeout(run, 900); // after the hero has settled
        loop = setInterval(() => document.visibilityState === "visible" && run(), 13000);
      };
      const obs = io((e) => e[0].isIntersecting && start());
      obs ? obs.observe(stage) : start();
    }
  }

  // How it works: the stage on the left follows whichever step is in the middle of the screen.
  const story = document.getElementById("story");
  if (story) {
    const steps = [...story.querySelectorAll(".story-step")];
    // Small screens show each scene under its step instead of in the pinned stage.
    for (const step of steps) {
      const scene = story.querySelector(`.scene[data-scene="${step.dataset.step}"]`);
      step.querySelector(".scene-inline")?.append(scene.firstElementChild.cloneNode(true));
    }
    const set = (n) => {
      story.dataset.step = n;
      steps.forEach((s) => s.classList.toggle("on", s.dataset.step === n));
    };
    set("1");
    const o = io((entries) => entries.forEach((e) => e.isIntersecting && set(e.target.dataset.step)), { rootMargin: "-45% 0px -45% 0px" });
    steps.forEach((s) => o?.observe(s));
  }

  // Bento tiles rise in once; the voice waveform only moves while it is on screen.
  const reveals = document.querySelectorAll(".reveal");
  const ro = reduce ? null : io(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const sibs = [...e.target.parentElement.children];
        e.target.style.transitionDelay = `${(sibs.indexOf(e.target) % 3) * 90}ms`;
        e.target.classList.add("in");
        ro.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px" },
  );
  reveals.forEach((el) => (ro ? ro.observe(el) : el.classList.add("in")));
  const voice = document.getElementById("voice-tile");
  if (voice && !reduce) io((e) => voice.classList.toggle("live", e[0].isIntersecting))?.observe(voice);

  // Code tabs, with a pill that slides to the selected tab.
  const code = document.getElementById("code");
  if (code) {
    const pillBg = code.querySelector(".pill-bg");
    const tabs = [...code.querySelectorAll("[data-tab]")];
    const place = (tab) => {
      pillBg.style.width = `${tab.offsetWidth}px`;
      pillBg.style.transform = `translateX(${tab.offsetLeft}px)`;
    };
    tabs.forEach((tab) =>
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
        code.querySelectorAll("[data-panel]").forEach((p) => {
          p.hidden = p.dataset.panel !== tab.dataset.tab;
          if (!p.hidden) {
            p.classList.remove("swap");
            void p.offsetWidth;
            p.classList.add("swap");
          }
        });
        place(tab);
      }),
    );
    const first = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    if (first) requestAnimationFrame(() => place(first));
    addEventListener("resize", () => place(tabs.find((t) => t.getAttribute("aria-selected") === "true")));
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
