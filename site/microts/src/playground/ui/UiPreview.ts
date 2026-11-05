// MicroTS app preview (main-thread side): compilation runs in /pocket/compiler-worker.js,
// execution in a same-origin iframe (/pocket/preview.html); each run reloads the iframe so globals start clean.
const BASE = "/pocket/";

export interface CompileStats {
  files: number;
  classes: number;
  fontSlots: number;
  images: number;
  pakBytes: number;
  ms: number;
}

export interface UiDiagnostic {
  phase: "compile" | "mount" | "frame" | "runtime";
  file?: string;
  message: string;
  line?: number;
  column?: number;
  stack?: string;
}

export interface UiPreviewEvents {
  onLog?: (level: string, text: string) => void;
  onError?: (error: UiDiagnostic) => void;
  onStatus?: (status: UiStatus) => void;
}

export interface UiStatus {
  state: "idle" | "compiling" | "loading" | "running" | "error";
  fps: number;
  memory: number;
  compile?: CompileStats;
}

/** PSP button bits, matching contracts/spec/spec.ts BTN */
export const PSP_BTN = {
  SELECT: 0x0001,
  START: 0x0008,
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
  L: 0x0100,
  R: 0x0200,
  TRIANGLE: 0x1000,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
  SQUARE: 0x8000,
} as const;
export type PspButton = keyof typeof PSP_BTN;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void }>();

function compiler(): Worker {
  if (!worker) {
    worker = new Worker(BASE + "compiler-worker.js", { type: "module" });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (p) {
        pending.delete(e.data.id);
        p.resolve(e.data);
      }
    };
    worker.postMessage({ id: ++seq, type: "configure", fontBaseUrl: new URL(BASE + "fonts/", location.href).href });
  }
  return worker;
}

/** Preload the compiler (about 2.9 MB); called when the playground opens */
export function warmCompiler(): void {
  compiler();
}

export class UiPreview {
  private iframe: HTMLIFrameElement | null = null;
  private runId = 0;
  private buttons = 0;
  private status: UiStatus = { state: "idle", fps: 0, memory: 0 };
  private onMessage = (e: MessageEvent) => this.handle(e);

  constructor(
    private host: HTMLElement,
    private events: UiPreviewEvents = {},
  ) {
    addEventListener("message", this.onMessage);
  }

  /** touch: the device has a touch screen; pointer events on the canvas become touch input */
  async run(
    files: Record<string, string>,
    entry: string,
    framework: "vue-vapor" | "solid",
    viewport: { width: number; height: number },
    touch = false,
  ) {
    const id = ++this.runId;
    this.setStatus({ state: "compiling", fps: 0, memory: 0 });
    const reqId = ++seq;
    const reply = await new Promise<any>((resolve) => {
      pending.set(reqId, { resolve });
      compiler().postMessage({ id: reqId, type: "compile", input: { files, entry, framework } });
    });
    if (id !== this.runId) return;
    if (!reply.ok) {
      this.setStatus({ state: "error", fps: 0, memory: 0 });
      this.events.onError?.({ phase: "compile", ...reply.diagnostic });
      return;
    }
    const output = reply.output;
    this.setStatus({ state: "loading", fps: 0, memory: 0, compile: output.stats });
    const iframe = this.freshIframe();
    await new Promise<void>((resolve) => {
      const ready = (e: MessageEvent) => {
        if (e.source === iframe.contentWindow && e.data?.source === "microts-preview" && e.data.type === "ready") {
          removeEventListener("message", ready);
          resolve();
        }
      };
      addEventListener("message", ready);
    });
    if (id !== this.runId) return;
    iframe.contentWindow!.postMessage(
      { type: "run", modules: output.modules, entry: output.entry, styles: output.styles, pak: output.pak, viewport, touch },
      "*",
      [output.pak],
    );
  }

  stop(): void {
    this.runId++;
    this.iframe?.remove();
    this.iframe = null;
    this.setStatus({ state: "idle", fps: 0, memory: 0 });
  }

  focus(): void {
    this.iframe?.contentWindow?.postMessage({ type: "focus" }, "*");
    this.iframe?.focus();
  }

  press(button: PspButton, down: boolean): void {
    if (down) this.buttons |= PSP_BTN[button];
    else this.buttons &= ~PSP_BTN[button];
    this.iframe?.contentWindow?.postMessage({ type: "buttons", mask: this.buttons }, "*");
  }

  dispose(): void {
    removeEventListener("message", this.onMessage);
    this.stop();
  }

  private freshIframe(): HTMLIFrameElement {
    this.iframe?.remove();
    const iframe = document.createElement("iframe");
    iframe.src = BASE + "preview.html";
    iframe.title = "MicroTS app preview";
    iframe.className = "block h-full w-full border-0";
    this.host.appendChild(iframe);
    this.iframe = iframe;
    this.buttons = 0;
    return iframe;
  }

  private setStatus(s: UiStatus) {
    this.status = { ...s, compile: s.compile ?? (s.state === "compiling" ? undefined : this.status.compile) };
    this.events.onStatus?.(this.status);
  }

  private handle(e: MessageEvent) {
    if (!this.iframe || e.source !== this.iframe.contentWindow) return;
    const msg = e.data;
    if (msg?.source !== "microts-preview") return;
    switch (msg.type) {
      case "log":
        this.events.onLog?.(msg.level, msg.text);
        break;
      case "error": {
        this.setStatus({ ...this.status, state: "error" });
        const where = String(msg.stack ?? "").match(/\/project\/([^:\s)]+):(\d+):(\d+)/);
        this.events.onError?.({
          phase: msg.phase,
          message: msg.message,
          stack: msg.stack,
          file: where?.[1],
          line: where ? Number(where[2]) : undefined,
          column: where ? Number(where[3]) : undefined,
        });
        break;
      }
      case "running":
        this.setStatus({ ...this.status, state: "running" });
        break;
      case "stats":
        this.setStatus({ ...this.status, fps: msg.fps, memory: msg.memory });
        break;
      case "focus":
        this.iframe.focus();
        break;
    }
  }
}
