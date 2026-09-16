import "./showcase.js";
const handhelds = document.querySelector("[data-handheld]");
if (handhelds) {
  const approach = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    approach.disconnect();
    void import("/assets/handheld-stages.js");
  }, { rootMargin: "400px" });
  approach.observe(handhelds);
}

// Homepage interactions: framework code tabs and the lazy motion demo.
for (const group of document.querySelectorAll("[data-subtabs]")) {
  const tabs = group.querySelectorAll(".subtab");
  tabs.forEach(t => t.addEventListener("click", () => {
    tabs.forEach(x => x.classList.remove("on"));
    group.querySelectorAll("pre").forEach(p => p.classList.remove("on"));
    t.classList.add("on");
    group.querySelector("#" + t.dataset.sub).classList.add("on");
  }));
}

// The scale panel reveals its markers once, when it scrolls into view.
const scale = document.querySelector("[data-scale]");
if (scale) {
  if (!("IntersectionObserver" in window)) scale.classList.add("on");
  else {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("on");
        io.unobserve(e.target);
      }
    }, { threshold: 0.35 });
    io.observe(scale);
  }
}

// Reference links leave the reading flow: open them in their own tab. The
// compatibility chips are receipts too, so they behave the same way.
for (const a of document.querySelectorAll("[data-refs] a, .cgrid a")) {
  a.target = "_blank";
  a.rel = "noreferrer";
}

// The motion stage is the real runtime in WebAssembly, so it boots only when
// the chapter is actually on screen.
const motionStage = document.querySelector("[data-motion-stage]");
if (motionStage) {
  let booted = false;
  const boot = async () => {
    if (booted) return;
    booted = true;
    try {
      const { mountPocketStage } = await import("/assets/pocket-stage-web.js");
      await mountPocketStage(motionStage, {
        bootApp: "motions-main",
        readyText: "yui540 motion studies, live",
        errorText: "Interactive 3D is unavailable in this browser.",
        receiptName: "__motionStageReceipt",
      });
    } catch (error) {
      motionStage.classList.add("has-error");
      const status = motionStage.querySelector("[data-stage-status]");
      if (status) status.textContent = "The motion studies could not be loaded.";
      console.error("motion stage failed", error);
    }
  };
  if (!("IntersectionObserver" in window)) void boot();
  else {
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      void boot();
    }, { rootMargin: "300px 0px", threshold: 0.01 });
    io.observe(motionStage);
  }
}
