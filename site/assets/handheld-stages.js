import { mountPocketStage, BTN } from "/assets/pocket-stage-web.js";
import { __packTouchWide, createTouchHitFacts } from "../../framework/src/touch.ts";

const KEYS = { ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT,
  KeyX: BTN.CROSS, Enter: BTN.CIRCLE, KeyZ: BTN.CIRCLE, KeyA: BTN.SQUARE,
  KeyS: BTN.TRIANGLE, KeyQ: BTN.LTRIGGER, KeyE: BTN.RTRIGGER, Space: BTN.START };

// One app realm per device: the PSP's page-level host cannot own a second app.
class HandheldHost {
  constructor(root, profile) {
    this.root = root;
    this.profile = profile;
    this.tickCount = 0;
    this.blitCount = 0;
    this.held = 0;
    this.contact = null;
    this.afterTick = new Set();
    this.visible = false;
    this.raf = 0;
    this.onError = (error) => { throw error; };
    this.onBlit = () => {};
    this.outputs = [root.querySelector("[data-stage-screen]"), root.querySelector("[data-stage-auxiliary]")]
      .filter(Boolean).map((canvas) => ({ canvas, ctx: canvas.getContext("2d"),
        image: new ImageData(canvas.width, canvas.height) }));
  }

  async boot() {
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    const loaded = new Promise((resolve, reject) => {
      iframe.addEventListener("load", resolve, { once: true });
      iframe.addEventListener("error", () => reject(Error("Demo runtime could not load")), { once: true });
    });
    iframe.src = "/pg/app-instance.html";
    document.body.append(iframe);
    this.iframe = iframe;
    await loaded;
    const demo = this.profile.demo;
    this.api = await iframe.contentWindow.PocketAppInstance.create({
      packageId: demo.package_id,
      viewport: this.profile.display.logical_size,
      rasterDensity: this.profile.display.raster_density,
      auxiliary: this.profile.display.auxiliary_size,
      wasmUrl: "/pg/pocketjs.wasm",
      bundleUrl: `/stage/handheld-apps/${demo.output}.js`,
      pakUrl: `/stage/handheld-apps/${demo.output}.pak`,
    });
    this.hits = createTouchHitFacts((x, y) => this.api.hitTestBounds(x, y, this.contact?.surface));
    this.step();
    this.paint();
    const canvas = this.root.querySelector("[data-stage-canvas]");
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-hidden", "false");
    canvas.setAttribute("aria-label", this.root.dataset.deviceLabel);
    canvas.addEventListener("keydown", (event) => {
      const bit = KEYS[event.code];
      if (bit) { event.preventDefault(); this.press(bit, true); }
    });
    canvas.addEventListener("keyup", (event) => {
      const bit = KEYS[event.code];
      if (bit) { event.preventDefault(); this.press(bit, false); }
    });
    canvas.addEventListener("blur", () => this.release());
    window.addEventListener("blur", () => this.release());
    this.observer = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.visible && !document.hidden ? this.wake() : this.stop();
    }, { threshold: .01 });
    this.observer.observe(this.root);
    document.addEventListener("visibilitychange", () => {
      this.visible && !document.hidden ? this.wake() : this.stop();
    });
  }

  press(bit, down) { this.held = down ? this.held | bit : this.held & ~bit; }
  touch(surface, point) {
    if (!point) { this.contact = null; return; }
    const size = surface === "auxiliary" ? this.profile.display.auxiliary_size : this.profile.display.logical_size;
    this.contact = { surface, x: Math.max(0, Math.min(size[0]-1, Math.round(point[0]))),
      y: Math.max(0, Math.min(size[1]-1, Math.round(point[1]))) };
  }
  release() { this.held = 0; this.contact = null; }
  afterNextTick(fn) { this.afterTick.add(fn); return () => this.afterTick.delete(fn); }
  step() {
    const c = this.contact;
    const touches = c ? [__packTouchWide(0, c.x, c.y)] : undefined;
    this.api.step(this.held, touches, this.hits?.(touches), c ? [c.surface === "auxiliary" ? 1 : 0] : undefined);
    this.tickCount++;
    for (const fn of [...this.afterTick]) { this.afterTick.delete(fn); fn(); }
  }
  paint() {
    this.outputs.forEach((output, i) => {
      output.image.data.set(i ? this.api.renderAuxiliary() : this.api.render(this.profile.display.raster_density));
      output.ctx.putImageData(output.image, 0, 0);
    });
    this.blitCount++;
    this.onBlit();
  }
  wake() {
    if (this.disposed || this.raf || !this.api || !this.visible || document.hidden) return;
    let last = performance.now(), accumulator = 0;
    const tick = (now) => {
      this.raf = 0;
      try {
        accumulator += Math.min(250, now-last); last = now;
        let steps = 0;
        while (accumulator >= 1000/60 && steps < 4) {
          this.step(); accumulator -= 1000/60; steps++;
        }
        if (steps) this.paint();
        if (this.visible && !document.hidden) this.raf = requestAnimationFrame(tick);
      } catch (error) { this.stop(); this.onError(error); }
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; this.release(); }
  dispose() {
    this.disposed = true;
    this.stop();
    this.afterTick.clear();
    this.observer?.disconnect();
    this.api?.dispose();
    this.iframe?.remove();
  }
}

async function boot(root) {
  const id = root.dataset.handheld;
  const profileUrl = `/stage/${id}/profile.json`;
  let host;
  try {
    const response = await fetch(profileUrl);
    if (!response.ok) throw Error("Device profile unavailable");
    const profile = await response.json();
    host = new HandheldHost(root, profile);
    host.onError = (error) => {
      host.dispose();
      root.classList.add("has-error");
      root.querySelector("[data-stage-status]").textContent = "The demo could not start.";
      console.error("handheld demo failed", error);
    };
    await host.boot();
    const stage = await mountPocketStage(root, { host, profileUrl, receiptName: `__${id.replaceAll("-", "_")}Receipt` });
    if (!stage) { host.dispose(); return; }
    host.onBlit = stage.refreshScreen;
    stage.refreshScreen();
    if (root.closest(".hero")) stage.setView("detail");
    root.dataset.demo = profile.demo.output;
  } catch (error) {
    host?.dispose();
    root.classList.add("has-error");
    root.querySelector("[data-stage-status]").textContent = "This device preview could not load.";
    console.error("handheld preview failed", error);
  }
}

for (const root of document.querySelectorAll("[data-handheld]")) {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    void boot(root);
  }, { rootMargin: "200px", threshold: .01 });
  observer.observe(root);
}
