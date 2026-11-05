// Pocket Retro browser host (main-thread side): schedules frames, draws the palettized screen to a canvas,
// collects keyboard and touch input, and feeds sound records to an AudioWorklet. Game code runs in a Worker,
// so a hung game can be terminated without affecting the page.
import { RETRO_MIXER_URL, RETRO_WORKER_URL } from "microts:build";
import { BUTTON, type AssetPayload, type ButtonName, type SourceError, type WorkerReply } from "./protocol";

export interface RetroHostEvents {
  onLog?: (level: string, text: string) => void;
  onError?: (error: SourceError) => void;
  onStatus?: (status: RetroStatus) => void;
}

export interface RetroStatus {
  state: "idle" | "loading" | "running" | "paused" | "error";
  width: number;
  height: number;
  fps: number;
  frameMs: number;
}

/** Keyboard layout from the pocket-retro README (arrows/WASD, Z/Space=A, X=B, Enter=Start, Tab/Shift=Select), plus Backspace=B and Q/E=L/R */
const KEYMAP: Record<string, ButtonName> = {
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  KeyW: "UP",
  KeyS: "DOWN",
  KeyA: "LEFT",
  KeyD: "RIGHT",
  KeyZ: "A",
  Space: "A",
  KeyX: "B",
  Backspace: "B",
  Enter: "START",
  Tab: "SELECT",
  ShiftLeft: "SELECT",
  ShiftRight: "SELECT",
  KeyQ: "L",
  KeyE: "R",
};

const TARGET_TICKS = 16;
const TICKS_PER_SECOND = 18157 / 76;
const FRAME_TIMEOUT_MS = 4000;

const assetCache = new Map<string, Promise<AssetPayload>>();

/** New retro projects have no baked assets: image bank and tilemaps are empty, sounds are defined in code with sound.set() */
export const EMPTY_ASSETS: AssetPayload = {
  images: new Uint8Array(0),
  tilemaps: new Uint8Array(0),
  tilemapImages: [],
  colors: [],
  sounds: [],
  soundStarts: [],
  musics: [],
  musicStarts: [],
};

export function loadRetroAssets(id: string | null): Promise<AssetPayload> {
  if (!id) return Promise.resolve(EMPTY_ASSETS);
  let p = assetCache.get(id);
  if (!p) {
    const base = `/retro/${id}/`;
    const bin = async (file: string | null) =>
      file ? new Uint8Array(await (await fetch(base + file)).arrayBuffer()) : new Uint8Array(0);
    p = fetch(base + "assets.json")
      .then((r) => {
        if (!r.ok) throw new Error(`assets for ${id}: HTTP ${r.status}`);
        return r.json();
      })
      .then(async (a) => ({ ...a, images: await bin(a.images), tilemaps: await bin(a.tilemaps) }));
    p.catch(() => assetCache.delete(id));
    assetCache.set(id, p);
  }
  return p;
}

export class RetroHost {
  private worker: Worker | null = null;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  private palette = new Uint32Array(256);
  private keys = 0;
  private touchKeys = 0;
  /** Keys pressed and released between two frames, held for the next frame */
  private latched = 0;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private inFlight = false;
  private sentAt = 0;
  private frameId = 0;
  private fps = 30;
  private width = 0;
  private height = 0;
  private frameMs = 0;
  private paused = false;
  private state: RetroStatus["state"] = "idle";
  private audio: AudioContext | null = null;
  private mixer: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private audioReady: Promise<void> | null = null;
  private queued = 0;
  private tickAcc = 0;
  private muted = false;
  private disposed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private events: RetroHostEvents = {},
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas is not available");
    this.ctx = ctx;
  }

  // ---------- Lifecycle ----------

  async start(files: Record<string, string>, entry: string, assets: AssetPayload): Promise<void> {
    this.stopWorker();
    this.setState("loading");
    this.paused = false;
    this.keys = 0;
    this.frameId = 0;
    this.queued = 0;
    this.tickAcc = 0;
    this.mixer?.port.postMessage({ type: "reset" });
    const worker = new Worker(RETRO_WORKER_URL, { type: "module" });
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      if (this.worker === worker) this.onMessage(e.data);
    };
    worker.onerror = (e) => {
      if (this.worker !== worker) return;
      e.preventDefault();
      this.fail({ phase: "compile", message: e.message || "The game worker failed to start" });
    };
    this.sentAt = performance.now();
    this.inFlight = true;
    worker.postMessage({ type: "start", files, entry, assets });
    this.loop();
  }

  stop(): void {
    this.stopWorker();
    this.setState("idle");
  }

  dispose(): void {
    this.disposed = true;
    this.stopWorker();
    void this.audio?.close();
    this.audio = null;
  }

  setPaused(paused: boolean): void {
    if (this.state !== "running" && this.state !== "paused") return;
    this.paused = paused;
    this.acc = 0;
    this.setState(paused ? "paused" : "running");
    if (paused) void this.audio?.suspend();
    else if (!this.muted) void this.audio?.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 0.6;
    if (!muted) void this.enableAudio();
  }

  /** Browsers only allow creating or resuming an AudioContext inside a user gesture */
  enableAudio(): Promise<void> {
    if (this.muted) return Promise.resolve();
    if (this.audio) {
      if (this.audio.state === "suspended" && !this.paused) return this.audio.resume();
      return this.audioReady ?? Promise.resolve();
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.audio = ctx;
    this.audioReady = ctx.audioWorklet
      .addModule(RETRO_MIXER_URL)
      .then(() => {
        if (this.disposed) return;
        const node = new AudioWorkletNode(ctx, "retro-mixer", { numberOfInputs: 0, outputChannelCount: [2] });
        node.port.onmessage = (e) => {
          if (e.data.type === "queued") this.queued = e.data.queued;
        };
        const gain = ctx.createGain();
        gain.gain.value = this.muted ? 0 : 0.6;
        node.connect(gain).connect(ctx.destination);
        this.mixer = node;
        this.gain = gain;
      })
      .catch((e) => this.events.onLog?.("warn", `Audio unavailable: ${e}`));
    return this.audioReady;
  }

  // ---------- Input ----------

  keyDown(e: KeyboardEvent): boolean {
    const b = KEYMAP[e.code];
    if (!b) return false;
    this.keys |= BUTTON[b];
    this.latched |= BUTTON[b];
    void this.enableAudio();
    return true;
  }

  keyUp(e: KeyboardEvent): boolean {
    const b = KEYMAP[e.code];
    if (!b) return false;
    this.keys &= ~BUTTON[b];
    return true;
  }

  press(button: ButtonName, down: boolean): void {
    if (down) {
      this.touchKeys |= BUTTON[button];
      this.latched |= BUTTON[button];
    }
    else this.touchKeys &= ~BUTTON[button];
    if (down) void this.enableAudio();
  }

  /** Canvas blur: release keyboard-held keys only; device buttons manage their own press and release */
  releaseKeys(): void {
    this.keys = 0;
  }

  releaseAll(): void {
    this.keys = 0;
    this.touchKeys = 0;
    this.latched = 0;
  }

  // ---------- Internals ----------

  private stopWorker() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.worker?.terminate();
    this.worker = null;
    this.inFlight = false;
    this.mixer?.port.postMessage({ type: "reset" });
  }

  private setState(state: RetroStatus["state"]) {
    this.state = state;
    this.emitStatus();
  }

  private emitStatus() {
    this.events.onStatus?.({ state: this.state, width: this.width, height: this.height, fps: this.fps, frameMs: this.frameMs });
  }

  private fail(error: SourceError) {
    this.stopWorker();
    this.setState("error");
    this.events.onError?.(error);
  }

  private onMessage(msg: WorkerReply) {
    switch (msg.type) {
      case "log":
        this.events.onLog?.(msg.level, msg.text);
        break;
      case "error":
        this.fail(msg.error);
        break;
      case "ready":
        this.fps = msg.fps;
        this.resize(msg.width, msg.height);
        this.setState(this.paused ? "paused" : "running");
        break;
      case "frame": {
        const took = performance.now() - this.sentAt;
        this.frameMs = this.frameMs ? this.frameMs * 0.9 + took * 0.1 : took;
        this.inFlight = false;
        if (msg.fps !== this.fps) {
          this.fps = msg.fps;
          this.emitStatus();
        }
        if (msg.colors) this.setColors(msg.colors);
        if (msg.width !== this.width || msg.height !== this.height) this.resize(msg.width, msg.height);
        this.blit(msg.screen);
        if (msg.voices.length && this.mixer && this.audio?.state === "running") {
          this.queued += msg.voices.length / 12;
          this.mixer.port.postMessage({ type: "voices", voices: msg.voices }, [msg.voices.buffer]);
        }
        if (msg.id % 30 === 0) this.emitStatus();
        break;
      }
    }
  }

  private setColors(colors: number[]) {
    // ImageData is in RGBA byte order; on little-endian machines that is 0xAABBGGRR as a Uint32
    for (let i = 0; i < 256; i++) {
      const c = colors[i] ?? 0;
      this.palette[i] = 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);
    }
  }

  private resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.image = this.ctx.createImageData(w, h);
    this.emitStatus();
  }

  private blit(screen: Uint8Array) {
    if (!this.image) return;
    const px = new Uint32Array(this.image.data.buffer);
    const n = Math.min(px.length, screen.length);
    const pal = this.palette;
    for (let i = 0; i < n; i++) px[i] = pal[screen[i]!]!;
    this.ctx.putImageData(this.image, 0, 0);
  }

  private audioTicks(): number {
    const nominal = TICKS_PER_SECOND / this.fps;
    if (this.mixer && this.audio?.state === "running") {
      // Same as the GBA host: top the queue up to about TARGET_TICKS ticks
      return Math.max(0, Math.min(Math.round(nominal * 3), Math.round(TARGET_TICKS - this.queued)));
    }
    this.tickAcc += nominal;
    const whole = Math.floor(this.tickAcc);
    this.tickAcc -= whole;
    return whole;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = this.last ? Math.min(250, now - this.last) : 0;
    this.last = now;
    if (!this.worker) return;
    if (this.inFlight) {
      if (now - this.sentAt > FRAME_TIMEOUT_MS)
        this.fail({
          phase: "timeout",
          message: `The game did not finish a frame within ${FRAME_TIMEOUT_MS / 1000} s. Look for a loop that never exits.`,
        });
      return;
    }
    if (this.paused || this.state !== "running") return;
    const interval = 1000 / this.fps;
    this.acc += dt;
    if (this.acc < interval) return;
    this.acc = Math.min(this.acc - interval, interval * 2);
    this.inFlight = true;
    this.sentAt = now;
    this.worker.postMessage({ type: "frame", id: ++this.frameId, keys: this.keys | this.touchKeys | this.latched, ticks: this.audioTicks() });
    this.latched = 0;
  };
}
