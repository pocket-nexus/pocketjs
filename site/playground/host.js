// Canvas host using the shared Runtime for package admission, generated UI,
// input, guest turns and presentation. runIIFE boots a script synchronously;
// runModule retains the Runtime behind the browser import promise gate.

import { createWasmUiSync, FB_W, FB_H } from "../../hosts/web/wasm-ops.js";
import { drawHud, wasmMemoryBytes } from "../../hosts/web/hud.js";
import { SHOT_W, SHOT_H, downscaleShot } from "../../hosts/sim/shot.ts";

/** spec PSM_8888 — the frozen-shot upload format (contracts/spec/spec.ts psm). */
const PSM_8888 = 3;

// contracts/spec/spec.ts BTN — the PSP button bitmask.
export const BTN = {
  SELECT: 0x0001, START: 0x0008,
  UP: 0x0010, RIGHT: 0x0020, DOWN: 0x0040, LEFT: 0x0080,
  LTRIGGER: 0x0100, RTRIGGER: 0x0200,
  TRIANGLE: 0x1000, CIRCLE: 0x2000, CROSS: 0x4000, SQUARE: 0x8000,
};

const KEYMAP = {
  ArrowUp: BTN.UP, ArrowRight: BTN.RIGHT, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT,
  KeyX: BTN.CROSS, Enter: BTN.CIRCLE, KeyZ: BTN.CIRCLE, KeyA: BTN.SQUARE,
  KeyS: BTN.TRIANGLE, ShiftLeft: BTN.SELECT, ShiftRight: BTN.SELECT, Space: BTN.START,
  // Shoulder triggers: literal L / R keys, plus Q / E as a left-hand alternate.
  KeyL: BTN.LTRIGGER, KeyR: BTN.RTRIGGER, KeyQ: BTN.LTRIGGER, KeyE: BTN.RTRIGGER,
};

export class PocketHost {
  constructor() {
    this.wasm = null;
    this.canvas = null;
    this.ctx = null;
    this.imageData = null;
    this.held = 0;
    this.rafId = 0;
    this.acc = 0;
    this.last = 0;
    this.frameCb = null;
    this.onLog = () => {};
    this.onFps = () => {};
    this.onError = () => {};
    this.onBlit = () => {};
    this.showHud = true;
    this.idleAfterMs = Infinity;
    this.activeUntil = Infinity;
    this.lastDrawHash = null;
    this.tickCount = 0;
    this.blitCount = 0;
    this.afterTick = [];
    this._statsFrames = 0;
    this._statsT = 0;
    this._hudFps = 0; // on-canvas HUD, sampled once/second (see hud.js)
    this._hudMem = 0;
    this.switching = null; // multi-app policy (enableAppSwitching)
  }

  /**
   * Turn this host into a multi-app host (docs/LAUNCHER.md, the browser twin of
   * hosts/psp/src/switch.rs + hosts/sim/launcher.ts): the three app* ops are
   * installed on every guest, SELECT is reserved as the summon chord for
   * non-launcher guests, and a switch fetches + evals the target bundle in
   * place — the same whole-guest swap runIIFE always was.
   *
   *   host.enableAppSwitching({
   *     launcher: "launcher-main",
   *     apps: [{ output, id, title }, ...],
   *     fetchBundle: async (output) => ({ js, pak }),   // caller caches
   *     onSwitch: (output) => {},                       // optional
   *   });
   */
  enableAppSwitching(config) {
    this.switching = {
      launcher: config.launcher,
      apps: config.apps,
      fetchBundle: config.fetchBundle,
      onSwitch: config.onSwitch ?? (() => {}),
      current: config.launcher,
      resume: null,
      shot: null,
      shotHandle: -1,
      // Latched: a SELECT still held from the press that caused the last
      // swap must release before it can summon again.
      prevSelect: true,
      pending: null,
      busy: false,
    };
  }

  _switchProviders() {
    const sw=this.switching;
    if(!sw)return {};
    return {
      appTable:()=>JSON.stringify({apps:sw.apps,current:sw.current,resume:sw.resume}),
      appLaunch:output=>{
        if(output!==sw.launcher && !sw.apps.some(a=>a.output===output))return 0;
        sw.pending={to:output,summon:false};return 1;
      },
      appShot:()=>sw.shot ? sw.shotHandle : -1,
    };
  }

  _prepareSwitchShot() {
    const sw=this.switching;
    if(sw?.shot && sw.shotHandle<0)sw.shotHandle=this.wasm.ops.uploadTexture(sw.shot,SHOT_W,SHOT_H,PSM_8888);
  }

  async _performSwitch() {
    const sw = this.switching;
    const { to, summon } = sw.pending;
    sw.pending = null;
    sw.busy = true;
    try {
      if (summon) {
        // The frozen frame is the guest's last presented frame (spec op 41).
        sw.shot = downscaleShot(this.wasm.render());
        sw.resume = sw.current;
      } else {
        sw.shot = null;
        sw.resume = null;
      }
      sw.shotHandle = -1;
      this.stop(); // the display holds the last blit through the fetch+eval
      const { js, pak } = await sw.fetchBundle(to);
      sw.current = to;
      sw.prevSelect = true;
      this.runIIFE(js, pak);
      sw.onSwitch(to);
    } catch (error) {
      this.onError(error);
      this.onLog("SWITCH ERROR: " + (error && error.stack ? error.stack : error));
      // Mirror the native broken-guest rule: fall back into the launcher
      // rather than wedging on a dead guest.
      if (to !== sw.launcher) {
        sw.pending = { to: sw.launcher, summon: false };
        sw.busy = false;
        return this._performSwitch();
      }
    } finally {
      sw.busy = false;
    }
  }

  /** Bind to a canvas + instantiate the wasm. Call once. `wasmUrl` defaults to
   *  ./pocketjs.wasm (next to this module). */
  async mount(canvas, opts = {}) {
    this.onLog = opts.onLog ?? this.onLog;
    this.onFps = opts.onFps ?? this.onFps;
    this.onError = opts.onError ?? this.onError;
    this.onBlit = opts.onBlit ?? this.onBlit;
    this.showHud = opts.showHud ?? this.showHud;
    this.idleAfterMs = opts.idleAfterMs ?? this.idleAfterMs;
    this.canvas = canvas;
    canvas.width = FB_W;
    canvas.height = FB_H;
    this.ctx = canvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.imageData = this.ctx.createImageData(FB_W, FB_H);

    // Keyboard only while the visible surface is focused (an editor may share
    // the page). Embedded stages can keep this 2D canvas hidden and nominate
    // their WebGL canvas as the keyboard target.
    const keyboardTarget = opts.keyboardTarget ?? canvas;
    keyboardTarget.tabIndex = 0;
    const down=e=>this._onKey(e,true),up=e=>this._onKey(e,false),blur=()=>{this.held=0;},hide=()=>this.dispose();
    keyboardTarget.addEventListener("keydown",down);
    keyboardTarget.addEventListener("keyup",up);
    keyboardTarget.addEventListener("blur",blur);
    globalThis.addEventListener?.("pagehide",hide);
    this._removeListeners=()=>{
      keyboardTarget.removeEventListener("keydown",down);
      keyboardTarget.removeEventListener("keyup",up);
      keyboardTarget.removeEventListener("blur",blur);
      globalThis.removeEventListener?.("pagehide",hide);
    };

    const url = opts.wasmUrl ?? new URL("./pocketjs.wasm", import.meta.url).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error("pocketjs.wasm not found at " + url);
    this._wasmModule = await WebAssembly.compile(await res.arrayBuffer());
    this.wasm = createWasmUiSync(this._wasmModule);
    this.onLog("wasm ready");
    return this;
  }

  get ops() {
    return this.wasm.ops;
  }

  _onKey(e, down) {
    const bit = KEYMAP[e.code];
    if (bit === undefined) return;
    e.preventDefault();
    if (down) this.held |= bit;
    else this.held &= ~bit;
    this.wake();
  }

  /** Virtual on-screen d-pad/buttons. */
  press(bit, down) {
    if (down) this.held |= bit;
    else this.held &= ~bit;
    this.wake();
  }

  /** Fresh core + host globals. Call before installing a new app. */
  reset() {
    this.stop();
    this.frameCb = null;
    if(this.wasm.disposed) this.wasm=createWasmUiSync(this._wasmModule);
    else this.wasm.init();
    globalThis.frame = undefined;
    this.lastDrawHash = null;
    this.afterTick = [];

  }

  /** Run a callback after the guest has consumed its next fixed-timestep turn.
   * Returns a cancellation function for blur/offscreen/error cleanup. */
  afterNextTick(callback) {
    const task = { target: this.tickCount + 1, callback, active: true };
    this.afterTick.push(task);
    this.wake();
    return () => {
      task.active = false;
    };
  }

  _flushAfterTick() {
    const ready = [];
    const pending = [];
    for (const task of this.afterTick) {
      if (!task.active) continue;
      if (this.tickCount >= task.target) ready.push(task);
      else pending.push(task);
    }
    this.afterTick = pending;
    for (const task of ready) task.callback();
  }

  /** After the caller has mounted an app (globalThis.frame installed), start the
   *  loop with one immediate frame so the canvas is never blank. */
  begin() {
    if (typeof globalThis.frame !== "function") {
      throw new Error(
        "app did not install globalThis.frame — the entry must call mount()/render()",
      );
    }
    this.frameCb = globalThis.frame;
    this._hudMem = wasmMemoryBytes(this.wasm); // so MEM shows before the first 1s sample
    if (this._safeFrame()) this._blit();
    this.wake();
  }

  /** Run a prebuilt IIFE bundle (dist/<app>.js + <app>.pak). */
  runIIFE(jsText, pakBuffer) {
    this.reset();
    this.wasm.boot(jsText, {pak:pakBuffer, sourceName:"pocketjs-demo.js", providers:this._switchProviders(), beforeEvaluate:()=>this._prepareSwitchShot()});
    this.begin();
  }

  /** Async module evaluation keeps the Runtime alive behind a promise gate.
   * No input or pixels are exposed until imports and initial layout finish. */
  async runModule(evaluate, pakBuffer) {
    this.reset();
    await this.wasm.bootAsync("", {pak:pakBuffer, evaluate, providers:this._switchProviders(), beforeEvaluate:()=>this._prepareSwitchShot()});
    this.begin();
  }

  dispose() {
    this.stop();
    this.frameCb = null;
    this.afterTick = [];
    this._removeListeners?.();
    this._removeListeners = undefined;
    this.wasm?.dispose();
    this.wasm = null;
  }

  _safeFrame() {
    if (!this.frameCb) return false;
    try {
      // The summon chord (docs/LAUNCHER.md): non-launcher guests never see
      // SELECT; a host-tracked press-edge schedules the summon.
      let mask = this.held;
      const sw = this.switching;
      if (sw && !sw.busy && sw.current !== sw.launcher) {
        const select = (mask & BTN.SELECT) !== 0;
        if (select && !sw.prevSelect && !sw.pending) {
          sw.pending = { to: sw.launcher, summon: true };
        }
        sw.prevSelect = select;
        mask &= ~BTN.SELECT;
      }
      this.wasm.advance({buttons:mask});
      this.tickCount++;
      if (sw && sw.pending && !sw.busy) {
        // Switch at the frame's bottom, like every other host.
        this._performSwitch();
      }
      if (this.wasm.drawHash) {
        const hash = this.wasm.drawHash();
        const changed = hash !== this.lastDrawHash;
        this.lastDrawHash = hash;
        this._flushAfterTick();
        return changed;
      }
      this._flushAfterTick();
      return true;
    } catch (e) {
      this.onError(e);
      this.onLog("FRAME ERROR: " + (e && e.stack ? e.stack : e));
      this.frameCb = null; // stop repeating the throw 60x/s
      return false;
    }
  }

  _blit() {
    if (!this.wasm || !this.ctx) return;
    this.imageData.data.set(this.wasm.renderIncremental());
    this.ctx.putImageData(this.imageData, 0, 0);
    if (this.showHud) {
      drawHud(this.ctx, FB_W, FB_H, this._hudFps, this._hudMem); // built-in on-canvas overlay
    }
    this.blitCount++;
    this.onBlit(this.canvas);
  }

  _tick = (now) => {
    this.rafId = requestAnimationFrame(this._tick);
    let dt = now - this.last;
    this.last = now;
    if (dt > 250) dt = 250;
    this.acc += dt;
    const STEP = 1000 / 60;
    let steps = 0;
    let changed = false;
    while (this.acc >= STEP && steps < 4) {
      changed = this._safeFrame() || changed;
      this.acc -= STEP;
      steps++;
      this._statsFrames++;
    }
    // A finite ambient host settles only after its DrawList has stayed stable
    // for the configured window. Real animation therefore keeps itself alive,
    // while an old wasm without the dirty ABI retains the hard wake deadline.
    if (changed && this.wasm.drawHash && Number.isFinite(this.idleAfterMs)) {
      this.activeUntil = now + this.idleAfterMs;
    }
    this._statsT += dt;
    if (this._statsT >= 1000) {
      // Sample FPS + memory once per second for the on-canvas HUD.
      this._hudFps = Math.round((this._statsFrames * 1000) / this._statsT);
      this._hudMem = wasmMemoryBytes(this.wasm);
      this.onFps(this._hudFps);
      this._statsFrames = 0;
      this._statsT = 0;
      // Even a static playground should refresh its once-per-second HUD.
      changed = changed || this.showHud;
    }
    if (changed) this._blit();
    if (Number.isFinite(this.idleAfterMs) && now >= this.activeUntil && this.held === 0) {
      this.stop();
    }
  };

  /** Resume fixed ticks for an interaction-sized burst. Infinite is the
   * playground default; ambient embeds can settle to zero RAF work. */
  wake() {
    const now = performance.now();
    this.activeUntil = Number.isFinite(this.idleAfterMs) ? now + this.idleAfterMs : Infinity;
    this._start();
  }

  _start() {
    if (this.rafId) return;
    this.last = performance.now();
    this.acc = 0;
    this.rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.onFps(0);
  }
}
