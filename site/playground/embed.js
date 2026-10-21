// site/playground/embed.js — live PocketJS demos embedded in a docs page.
//
// A `:::demo <app>` directive (site/doc-demos.ts) emits a `[data-doc-demo]`
// figure; this module boots one app per figure. A docs page may carry several.
//
// Why not site/playground/host.js: PocketHost is a page-level singleton. Its
// reset() assigns globalThis.ui / globalThis.frame / globalThis.__pak,
// framework/src/host.ts keeps `current` at module scope, and
// framework/src/gesture-core.ts keeps its recognizer table there too. Two of
// them on one page clobber each other. programs/web/app-instance.js is the
// primitive that already solves this: a hidden same-origin iframe gives each
// app its own JavaScript Realm and its own wasm Ui. The parent owns the
// visible canvas, the frame clock and the input channel; the realm owns the
// app. programs/web/system-engine.js is the reference implementation of that
// split and this file follows its shapes.

import { __packTouch, createTouchHitFacts } from "../../framework/src/touch.ts";

/** framework/src/touch.ts caps a frame at 8 simultaneous contacts. */
const MAX_CONTACTS = 8;
/** The fixed-timestep driver shape shared with host.js and system-engine.js. */
const STEP_MS = 1000 / 60;
const MAX_ELAPSED_MS = 250;
const MAX_CATCH_UP = 4;
/** The legacy wire form packs x:9,y:9 — site/doc-demos.ts rejects anything wider. */
const COORD_LIMIT = 512;

/** Copy of programs/web/system-engine.js createRealm(). */
async function createRealm(instanceUrl, options) {
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.tabIndex = -1;
  iframe.setAttribute("aria-hidden", "true");
  iframe.src = instanceUrl;
  document.body.appendChild(iframe);
  await new Promise((resolve, reject) => {
    iframe.addEventListener("load", resolve, { once: true });
    iframe.addEventListener("error", () => reject(new Error(`failed to load ${instanceUrl}`)), {
      once: true,
    });
  });
  const factory = iframe.contentWindow?.PocketAppInstance;
  if (!factory) {
    iframe.remove();
    throw new Error("app-instance Realm did not publish PocketAppInstance");
  }
  try {
    return { iframe, api: await factory.create(options) };
  } catch (error) {
    iframe.remove();
    throw error;
  }
}

function readConfig(figure) {
  const data = figure.dataset;
  const number = (name) => {
    const value = Number(data[name]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`[data-doc-demo] is missing a usable data-${name.toLowerCase()}`);
    }
    return value;
  };
  return {
    app: data.app ?? "demo",
    packageId: data.packageId ?? data.app ?? "demo",
    instanceUrl: data.instance,
    wasmUrl: data.wasm,
    bundleUrl: data.bundle,
    pakUrl: data.pak,
    width: number("width"),
    height: number("height"),
    rasterDensity: number("density"),
  };
}

/**
 * The pointer-to-contact driver.
 *
 * Browsers report pointers by edge (down / move / up); the guest reads a
 * LEVEL snapshot — framework/src/gesture-core.ts re-reads every live contact
 * on every frame, so a finger held still must be re-sent each frame or a long
 * press never fires. This table therefore holds contacts, not events, and
 * every step packs the whole table.
 *
 * Contact ids are pool slots (0..7, lowest free first), the same shape a
 * native panel driver hands the runtime.
 */
class ContactPool {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    /** slot index -> contact, or null. */
    this.slots = new Array(MAX_CONTACTS).fill(null);
    /** pointerId -> slot index. */
    this.bySource = new Map();
  }

  clamp(x, y) {
    return {
      x: Math.max(0, Math.min(this.width - 1, Math.min(COORD_LIMIT - 1, Math.round(x)))),
      y: Math.max(0, Math.min(this.height - 1, Math.min(COORD_LIMIT - 1, Math.round(y)))),
    };
  }

  down(pointerId, x, y) {
    if (this.bySource.has(pointerId)) return this.move(pointerId, x, y);
    const slot = this.slots.indexOf(null);
    if (slot < 0) return false; // the wire holds 8; a 9th finger is dropped
    const point = this.clamp(x, y);
    this.slots[slot] = { x: point.x, y: point.y, sent: 0, lifted: false };
    this.bySource.set(pointerId, slot);
    return true;
  }

  move(pointerId, x, y) {
    const slot = this.bySource.get(pointerId);
    if (slot === undefined) return false; // hover, not a contact
    const contact = this.slots[slot];
    if (contact.lifted) return false;
    const point = this.clamp(x, y);
    contact.x = point.x;
    contact.y = point.y;
    return true;
  }

  /**
   * A release is deferred until the contact has been in at least one frame:
   * a tap that lands and lifts inside one 16 ms step would otherwise never be
   * seen at all, and the gesture layer would see no down edge to lift.
   */
  up(pointerId, x, y) {
    const slot = this.bySource.get(pointerId);
    if (slot === undefined) return false;
    this.bySource.delete(pointerId);
    const contact = this.slots[slot];
    if (typeof x === "number") {
      const point = this.clamp(x, y);
      contact.x = point.x;
      contact.y = point.y;
    }
    contact.lifted = true;
    return true;
  }

  clear() {
    this.slots.fill(null);
    this.bySource.clear();
  }

  get liveCount() {
    return this.slots.reduce((count, contact) => count + (contact ? 1 : 0), 0);
  }

  /** Pack the whole table for one frame, then retire lifted contacts. */
  pack() {
    const packed = [];
    for (let slot = 0; slot < MAX_CONTACTS; slot++) {
      const contact = this.slots[slot];
      if (!contact) continue;
      packed.push(__packTouch(slot, contact.x, contact.y));
      contact.sent++;
    }
    for (let slot = 0; slot < MAX_CONTACTS; slot++) {
      const contact = this.slots[slot];
      if (contact && contact.lifted && contact.sent > 0) this.slots[slot] = null;
    }
    return packed.length > 0 ? packed : undefined;
  }
}

class DocDemo {
  constructor(figure) {
    this.figure = figure;
    this.config = readConfig(figure);
    this.canvas = figure.querySelector("[data-doc-demo-canvas]");
    this.status = figure.querySelector("[data-doc-demo-status]");
    if (!this.canvas) throw new Error("[data-doc-demo] carries no canvas");
    this.canvas.width = this.config.width;
    this.canvas.height = this.config.height;
    this.context = this.canvas.getContext("2d");
    this.context.imageSmoothingEnabled = false;
    this.image = this.context.createImageData(this.config.width, this.config.height);
    this.pool = new ContactPool(this.config.width, this.config.height);
    this.realm = null;
    this.api = null;
    this.hitFacts = null;
    this.booting = null;
    this.running = false;
    this.raf = 0;
    this.last = 0;
    this.accumulator = 0;
    this.frames = 0;
    this.failed = false;
    // Verification counters: how many packed contacts the guest has actually
    // been handed, and the hit facts resolved for the most recent frame.
    this.contactsSeen = 0;
    this.lastHits = [];
    this.tick = this.tick.bind(this);
  }

  setStatus(text, state) {
    this.figure.dataset.state = state;
    if (this.status) this.status.textContent = text;
  }

  async boot() {
    this.booting ??= (async () => {
      this.setStatus(`Loading ${this.config.app}…`, "loading");
      const realm = await createRealm(this.config.instanceUrl, {
        viewport: [this.config.width, this.config.height],
        rasterDensity: this.config.rasterDensity,
        wasmUrl: this.config.wasmUrl,
        pakUrl: this.config.pakUrl,
        bundleUrl: this.config.bundleUrl,
        packageId: this.config.packageId,
      });
      this.realm = realm;
      this.api = realm.api;
      // Each NEW contact id resolves once through the realm's bounds query
      // (spec op 42) against the frame the reader was looking at, and carries
      // that node id until it lifts — framework/src/touch.ts.
      this.hitFacts = createTouchHitFacts((x, y) => this.api.hitTestBounds(x, y));
      this.bindPointer();
      this.step(); // one frame so the canvas is never blank
      this.paint();
      this.setStatus("", "ready");
    })().catch((error) => {
      this.failed = true;
      this.setStatus(`This demo could not start: ${error.message}`, "error");
      console.error(`doc demo ${this.config.app} failed`, error);
      throw error;
    });
    return this.booting;
  }

  /** Client coordinates to logical pixels — programs/web/system-engine.js. */
  logicalPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * this.config.width / (rect.width || 1),
      y: (event.clientY - rect.top) * this.config.height / (rect.height || 1),
    };
  }

  bindPointer() {
    const canvas = this.canvas;
    // No keydown handler and no tabIndex here: an embedded demo that captures
    // arrow keys would take page scrolling away from the reader.
    const down = (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const point = this.logicalPoint(event);
      if (!this.pool.down(event.pointerId, point.x, point.y)) return;
      event.preventDefault();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events (the verifier) have no active pointer to capture.
      }
    };
    const move = (event) => {
      const point = this.logicalPoint(event);
      if (this.pool.move(event.pointerId, point.x, point.y)) event.preventDefault();
    };
    const up = (event) => {
      const point = this.logicalPoint(event);
      if (!this.pool.up(event.pointerId, point.x, point.y)) return;
      event.preventDefault();
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // Already released, or never captured.
      }
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  }

  step() {
    const packed = this.pool.pack();
    const hits = this.hitFacts(packed);
    this.api.step(0, packed, hits);
    this.contactsSeen += packed ? packed.length : 0;
    this.lastHits = hits ? [...hits] : [];
    this.frames++;
  }

  paint() {
    this.image.data.set(this.api.render());
    this.context.putImageData(this.image, 0, 0);
  }

  /** Advance exactly n frames and repaint. Used by the boot frame and tests. */
  stepFrames(count) {
    for (let i = 0; i < count; i++) this.step();
    this.paint();
  }

  start() {
    if (this.running || !this.api) return;
    this.running = true;
    this.last = performance.now();
    this.accumulator = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  tick(now) {
    if (!this.running) return;
    this.accumulator += Math.min(MAX_ELAPSED_MS, now - this.last);
    this.last = now;
    let count = 0;
    while (this.accumulator >= STEP_MS && count < MAX_CATCH_UP) {
      this.step();
      this.accumulator -= STEP_MS;
      count++;
    }
    if (count > 0) this.paint();
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Boot on approach, then tick only while the reader can see the demo. */
  observe() {
    if (!("IntersectionObserver" in window)) {
      void this.boot().then(() => this.start()).catch(() => {});
      return;
    }
    const approach = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      approach.disconnect();
      void this.boot().catch(() => {});
    }, { rootMargin: "300px 0px", threshold: 0.01 });
    approach.observe(this.figure);

    const visible = new IntersectionObserver((entries) => {
      const showing = entries.some((entry) => entry.isIntersecting);
      if (showing && !this.failed) void this.boot().then(() => this.start()).catch(() => {});
      else this.stop();
    }, { threshold: 0.01 });
    visible.observe(this.figure);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stop();
    });
  }
}

const demos = [];
for (const figure of document.querySelectorAll("[data-doc-demo]")) {
  try {
    const demo = new DocDemo(figure);
    demos.push(demo);
    demo.observe();
  } catch (error) {
    figure.dataset.state = "error";
    console.error("doc demo could not be prepared", error);
  }
}
// Verification handle (site/verify-doc-demos.ts), the twin of __pgHost.
globalThis.__pocketDocDemos = demos;
