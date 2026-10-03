import { DESK_APPS } from "../desk-apps.ts";
import { BTN } from "../../contracts/spec/spec.ts";
import { __packTouchWide, createTouchHitFacts } from "../../framework/src/touch.ts";
import { hitScreen, contentRect, appPoint } from "./geometry.ts";
import { DeskCompositor } from "./compositor.js";

const scene = document.querySelector("#scene"), canvas = document.querySelector("#composite");
const inputs = document.querySelector("#inputs"), status = document.querySelector("#status");
const pauseButton = document.querySelector("#pause"), originalButton = document.querySelector("#original");
const KEYS = { ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT,
  Enter: BTN.CIRCLE, KeyX: BTN.CROSS, KeyZ: BTN.CIRCLE, KeyQ: BTN.LTRIGGER, KeyE: BTN.RTRIGGER,
  KeyA: BTN.SQUARE, KeyS: BTN.TRIANGLE, Space: BTN.START };
const outputs = new Map(), hosts = [], bindings = new Map();
let compositor, observer, paused = false, original = false, lost = false, disposed = false, raf = 0;
let last = 0, accumulator = 0, lastPaint = 0, selected = null;

class DeskApp {
  constructor(config, screens) {
    this.config = config; this.screens = screens; this.state = "loading";
    this.held = 0; this.pending = 0; this.contact = null; this.events = [];
    this.ticks = 0; this.blits = 0; this.lastHash = null;
    this.outputs = screens.map(screen => {
      const size = screen.surface === "auxiliary" ? config.auxiliary : config.viewport;
      const density = screen.surface === "auxiliary" ? 1 : config.density;
      const canvas = document.createElement("canvas");
      canvas.width = size[0] * density; canvas.height = size[1] * density;
      const output = { canvas, ctx: canvas.getContext("2d"), image: new ImageData(canvas.width, canvas.height),
        size, screen, rect: contentRect(screen.framebuffer_size, size), version: 0 };
      canvas.hidden = true; canvas.dataset.framebuffer = screen.node; document.body.append(canvas);
      outputs.set(screen.node, output); bindings.set(screen.node, { host: this, output });
      return output;
    });
  }

  async boot() {
    const iframe = this.iframe = document.createElement("iframe");
    iframe.hidden = true; iframe.tabIndex = -1; iframe.setAttribute("aria-hidden", "true");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("App runtime load timed out")), 20000);
      iframe.onload = () => { clearTimeout(timer); resolve(); };
      iframe.onerror = () => { clearTimeout(timer); reject(Error("App runtime failed to load")); };
      iframe.src = "/pg/app-instance.html"; document.body.append(iframe);
    });
    if (disposed) return this.dispose();
    const c = this.config;
    this.api = await iframe.contentWindow.PocketAppInstance.create({ packageId: c.id,
      viewport: [...c.viewport], rasterDensity: c.density, auxiliary: c.auxiliary && [...c.auxiliary],
      wasmUrl: "/pg/pocketjs.wasm", bundleUrl: new URL(`./apps/${c.output}.js`, location.href).href,
      pakUrl: new URL(`./apps/${c.output}.pak`, location.href).href });
    if (disposed) return this.dispose();
    this.hits = createTouchHitFacts((x, y) => this.api.hitTestBounds(x, y, this.contact?.surface));
    this.state = "ready"; this.step(); this.paint();
  }

  press(bit, down) { this.held = down ? this.held | bit : this.held & ~bit; if (down) this.pending |= bit; }
  touch(contact, move = false) {
    // Preserve down/up even when both arrive between simulation ticks.
    const previous = this.events.at(-1);
    if (move && previous?.move) previous.contact = contact;
    else if (this.events.length < 32) this.events.push({ contact, move });
    else if (!contact) this.events[this.events.length - 1] = { contact: null, move: false };
  }
  release() { this.held = this.pending = 0; this.contact = null; this.events.length = 0; }
  step() {
    if (this.state !== "ready") return;
    if (this.events.length) this.contact = this.events.shift().contact;
    const c = this.contact, touches = c ? [__packTouchWide(0, c.x, c.y)] : undefined;
    this.api.step(this.held | this.pending, touches, this.hits(touches), c ? [c.surface === "auxiliary" ? 1 : 0] : undefined);
    this.pending = 0; this.ticks++;
  }
  paint() {
    if (this.state !== "ready") return;
    const hash = this.api.drawHash();
    if (hash !== 0n && hash === this.lastHash && !this.config.auxiliary) return;
    for (const output of this.outputs) {
      const pixels = output.screen.surface === "auxiliary" ? this.api.renderAuxiliary() : this.api.render(this.config.density);
      output.image.data.set(pixels); output.ctx.putImageData(output.image, 0, 0); output.version++;
    }
    this.lastHash = hash; this.blits++;
  }
  fail(error) {
    this.error = String(error); this.state = "error"; this.release();
    this.api?.dispose(); this.iframe?.remove();
    for (const output of this.outputs) output.version = 0;
    status.textContent = `${this.config.title} could not start: ${error.message ?? error}`;
    console.error(this.config.title, error);
  }
  dispose() { this.release(); this.api?.dispose(); this.iframe?.remove(); this.outputs.forEach(o => o.canvas.remove()); }
}

function running() { return !paused && !original && !lost && !disposed && !document.hidden; }
function stop() { cancelAnimationFrame(raf); raf = 0; hosts.forEach(h => h.release()); }
function wake() {
  if (!compositor || raf || !running()) return;
  last = performance.now(); accumulator = 0;
  raf = requestAnimationFrame(tick);
}
function tick(now) {
  raf = 0;
  if (!running()) return;
  accumulator += Math.min(250, now - last); last = now;
  let steps = 0;
  while (accumulator >= 1000 / 60 && steps < 4) {
    for (const host of hosts) { try { host.step(); } catch (error) { host.fail(error); } }
    accumulator -= 1000 / 60; steps++;
  }
  if (steps === 4) accumulator = Math.min(accumulator, 1000 / 60);
  if (now - lastPaint >= 1000 / 30) {
    for (const host of hosts) { try { host.paint(); } catch (error) { host.fail(error); } }
    compositor.draw(outputs); lastPaint = now;
  }
  raf = requestAnimationFrame(tick);
}

function convexHull(vertices) {
  const points = [...new Map(vertices.map(v => [`${v[0]},${v[1]}`, [v[0], v[1]]])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = list => { const h = []; for (const p of list) { while (h.length > 1 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
  return [...half(points), ...half([...points].reverse())];
}

function wireScreen(screen) {
  const { host, output } = bindings.get(screen.node);
  const button = document.createElement("button");
  button.type = "button"; button.className = "screen-input"; button.dataset.screen = screen.node;
  button.setAttribute("aria-label", `${host.config.title} · ${screen.device} ${screen.surface}`);
  button.style.clipPath = `polygon(${convexHull(screen.vertices).map(([x, y]) => `${x * 100}% ${(1 - y) * 100}%`).join(",")})`;
  inputs.append(button);
  let pointer = null;
  const select = () => {
    if (selected !== host) selected?.release();
    selected = host;
    status.textContent = `${host.config.title} · ${host.config.help}`;
  };
  const point = event => {
    const r = scene.getBoundingClientRect();
    const uv = hitScreen(screen, (event.clientX - r.left) / r.width, 1 - (event.clientY - r.top) / r.height);
    return uv && appPoint(uv, output.rect, output.size);
  };
  button.addEventListener("focus", select);
  button.addEventListener("blur", () => { pointer = null; host.release(); });
  button.addEventListener("pointerdown", event => {
    if (!running() || host.state !== "ready" || pointer !== null || event.button !== 0) return;
    const p = point(event); if (!p) return;
    event.preventDefault(); button.focus({ preventScroll: true }); select();
    pointer = event.pointerId; button.setPointerCapture(pointer);
    host.touch({ surface: screen.surface, x: p[0], y: p[1] });
  });
  button.addEventListener("pointermove", event => {
    if (pointer !== event.pointerId || !running()) return;
    const p = point(event);
    if (p) host.touch({ surface: screen.surface, x: p[0], y: p[1] }, true);
  });
  const up = event => {
    if (pointer !== event.pointerId) return;
    pointer = null; host.touch(null);
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
  };
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", () => { pointer = null; host.release(); });
  button.addEventListener("lostpointercapture", () => { if (pointer !== null) { pointer = null; host.release(); } });
  button.addEventListener("keydown", event => {
    const bit = KEYS[event.code]; if (!bit) return;
    event.preventDefault(); if (running() && !event.repeat) host.press(bit, true);
  });
  button.addEventListener("keyup", event => { const bit = KEYS[event.code]; if (bit) { event.preventDefault(); host.press(bit, false); } });
  button.addEventListener("wheel", event => {
    if (host.config.device !== "android-budget" || !running()) return;
    event.preventDefault(); button.focus({ preventScroll: true }); select();
    const bit = event.deltaY > 0 ? BTN.DOWN : BTN.UP; host.press(bit, true); host.press(bit, false);
  }, { passive: false });
}

pauseButton.onclick = () => { paused = !paused; pauseButton.textContent = paused ? "Resume" : "Pause"; paused ? stop() : wake(); };
originalButton.onclick = () => {
  original = !original;
  originalButton.setAttribute("aria-pressed", String(original)); originalButton.textContent = original ? "Show apps" : "View original";
  canvas.hidden = inputs.hidden = original;
  original ? stop() : wake();
};
document.addEventListener("visibilitychange", () => document.hidden ? stop() : wake());
window.addEventListener("blur", () => hosts.forEach(h => h.release()));
window.addEventListener("pagehide", event => {
  stop();
  if (!event.persisted) { disposed = true; observer?.disconnect(); hosts.forEach(h => h.dispose()); compositor?.dispose(); }
});
window.addEventListener("pageshow", () => wake());
canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); lost = true; stop(); inputs.hidden = true; status.textContent = "Graphics connection lost. Restoring…"; });

async function boot() {
  const response = await fetch("./web.json");
  if (!response.ok) throw Error("Screen projection unavailable");
  const projection = await response.json();
  const plate = document.querySelector("#plate"); await plate.decode();
  compositor = new DeskCompositor(canvas, plate, projection.screens);
  canvas.addEventListener("webglcontextrestored", () => {
    try {
      compositor = new DeskCompositor(canvas, plate, projection.screens); lost = false; inputs.hidden = original;
      compositor.draw(outputs); status.textContent = "Graphics restored · Click a screen to interact"; wake();
    }
    catch (error) { status.textContent = error.message; }
  });
  for (const config of DESK_APPS) {
    const host = new DeskApp(config, projection.screens.filter(s => s.device === config.device));
    hosts.push(host);
    try { await host.boot(); } catch (error) { host.fail(error); }
    compositor.draw(outputs);
  }
  projection.screens.forEach(wireScreen);
  pauseButton.disabled = false;
  const ready = hosts.filter(h => h.state === "ready").length;
  if (ready === hosts.length) status.textContent = "Click a screen to interact · Tab switches devices";
  scene.dataset.ready = String(ready === hosts.length);
  observer = new ResizeObserver(() => { if (!lost && !disposed) compositor.draw(outputs); }); observer.observe(scene);
  wake();
}

// Read-only receipt for browser QA; app input still goes through the DOM host.
globalThis.__deskReceipt = () => ({ paused, original, running: running(), selected: selected?.config.device,
  hosts: hosts.map(h => ({ device: h.config.device, state: h.state, ticks: h.ticks, blits: h.blits,
    held: h.held, pending: h.pending, contact: h.contact, queued: h.events.length, error: h.error,
    outputs: h.outputs.map(o => ({ node: o.screen.node, size: [o.canvas.width, o.canvas.height], version: o.version })) })) });
boot().catch(error => { stop(); inputs.hidden = true; canvas.hidden = true; status.textContent = error.message; console.error(error); });
