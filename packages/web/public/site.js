// a2a website: sticky nav, scroll reveals, the hero conversation and the code tabs.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const nav = document.getElementById("nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // Sections rise in once as they enter the viewport.
  const items = document.querySelectorAll(".reveal");
  if (reduce || !("IntersectionObserver" in window)) items.forEach((el) => el.classList.add("in"));
  else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const siblings = [...e.target.parentElement.querySelectorAll(":scope > .reveal")];
          e.target.style.transitionDelay = `${Math.max(0, siblings.indexOf(e.target)) * 80}ms`;
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    items.forEach((el) => io.observe(el));
  }

  // The hero: your agent asks, the question crosses the relay, David's agent answers, it comes back.
  const stage = document.getElementById("stage");
  if (stage) {
    const lines = [...stage.querySelectorAll(".line")].sort((a, b) => a.dataset.step - b.dataset.step);
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
        [400, () => show(0)],
        [1300, () => show(1)],
        [1800, () => fly("go-right")],
        [2700, () => show(2)],
        [3600, () => show(3)],
        [4500, () => show(4)],
        [4800, () => fly("go-left")],
        [5700, () => show(5)],
      ];
      const run = () => {
        lines.forEach((l) => l.classList.remove("show"));
        for (const [t, fn] of timeline) setTimeout(fn, t);
      };
      // Start when the hero is visible; replay every 12 s while the tab is in view.
      let timer;
      const start = () => {
        if (timer) return;
        run();
        timer = setInterval(() => document.visibilityState === "visible" && run(), 12000);
      };
      new IntersectionObserver((e) => e[0].isIntersecting && start()).observe(stage);
    }
  }

  // Code tabs.
  const code = document.getElementById("code");
  if (code) {
    code.querySelectorAll("[data-tab]").forEach((tab) =>
      tab.addEventListener("click", () => {
        code.querySelectorAll("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
        code.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
      }),
    );
  }
})();
