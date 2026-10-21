// tools/devtools-bridge.ts — the PSPLINK USB mailbox bridge as a module
// (docs/DEVTOOLS.md §3). Owns pocketjs-dbg/{enable,in,out}.jsonl inside a
// usbhostfs-served dir, tails the device's out.jsonl into the WS hub and
// appends panel commands to in.jsonl. Consumers: tools/devtools-psp.ts
// (thin CLI) and tools/devtools.ts (the one-command orchestrator).
//
// Screenshot path: the device dumps raw VRAM to pocketjs-dbg/shot.raw and
// emits {t:"screenshotRaw"} on the mailbox; we intercept it here (never
// forwarded), crop the 512-px GE stride to 480 and encode the PNG the
// panel expects — the ~550 KB of pixels ride usbhostfs, not the JSON
// channel.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bundleHash, launcherBundleHash } from "./bundle-hash.ts";
import { encodePNG } from "../tests/png.ts";

export interface BridgeEvent {
  type:
    | "hub-connected"
    | "hub-lost"
    | "device-talking"
    | "hello"
    | "screenshot"
    | "bundle-ok"
    | "bundle-mismatch"
    | "bundle-silent";
  detail?: string;
}

export interface BridgeOptions {
  /** usbhostfs root the PSP mounts as host0: */
  dir: string;
  /** dev-server (WS hub) port */
  port: number;
  /** dist dir holding <app>.js/.pak for the bundle-hash check (default:
   *  the repo's dist/ next to this script). */
  dist?: string;
  onEvent?: (e: BridgeEvent) => void;
}

export interface Bridge {
  boxDir: string;
  stop(): void;
}

export function startBridge(opts: BridgeOptions): Bridge {
  const emit = opts.onEvent ?? (() => {});
  const boxDir = join(opts.dir, "pocketjs-dbg");
  const enablePath = join(boxDir, "enable");
  const inPath = join(boxDir, "in.jsonl");
  const outPath = join(boxDir, "out.jsonl");

  mkdirSync(boxDir, { recursive: true });
  writeFileSync(enablePath, "pocket devtools mailbox\n");
  writeFileSync(inPath, "");
  writeFileSync(outPath, "");

  let stopped = false;
  let ws: WebSocket | null = null;
  let backoff = 500;

  function connect(): void {
    if (stopped) return;
    const sock = new WebSocket(`ws://127.0.0.1:${opts.port}/ws?role=device`);
    sock.onopen = () => {
      backoff = 500;
      emit({ type: "hub-connected" });
    };
    sock.onmessage = (e) => {
      // Panel command -> mailbox. One JSON object per WS message; the PSP
      // splits batched lines itself.
      if (typeof e.data === "string" && e.data.trim()) {
        try {
          appendFileSync(inPath, e.data.trim() + "\n");
        } catch {
          // usbhostfs restart mid-write — the panel can just resend
        }
      }
    };
    sock.onclose = () => {
      ws = null;
      if (stopped) return;
      emit({ type: "hub-lost" });
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
    sock.onerror = () => {
      // close fires next; stay quiet (the hub may not be up yet)
    };
    ws = sock;
  }
  connect();

  /** shot.raw -> data URL PNG (crop the 512-px stride to w x h). The GE
   *  writes the framebuffer with alpha 0 (the PSP display ignores it), so
   *  force it opaque — same reason e2e converts with `-alpha off`. */
  function convertShot(file: string, w: number, h: number, stride: number): string | null {
    const raw = readFileSync(join(boxDir, file));
    if (raw.length < stride * h * 4) return null;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      raw.copy(rgba, y * w * 4, y * stride * 4, y * stride * 4 + w * 4);
    }
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    return "data:image/png;base64," + encodePNG(rgba, w, h).toString("base64");
  }

  const distDir = opts.dist ?? new URL("../dist", import.meta.url).pathname;

  /** Stale-embed tripwire: the device's stats reply carries the FNV-1a64 of
   *  the js+pak baked into the PRX (programs/psp/build.rs); compare it with the
   *  hash of what dist/ holds NOW. A mismatch means the running EBOOT does
   *  not contain the code being edited — every on-device observation would
   *  be evidence about the wrong build. */
  function checkBundle(data: Record<string, unknown>): void {
    const app = String(data.app ?? "");
    const device = String(data.bundle ?? "");
    if (!app || !device || device === "none") return;
    let local: string;
    try {
      local = bundleHash(join(distDir, `${app}.js`), join(distDir, `${app}.pak`));
    } catch {
      return; // no local build of this app — nothing to compare against
    }
    // Multi-app EBOOT (docs/LAUNCHER.md): the device hash covers app 0 PLUS every
    // registry bundle in table order. When the single-bundle hash misses and
    // a registry is present, compare against that flavor before crying stale.
    let launcher: string | null = null;
    if (local !== device) {
      try {
        const tsv = readFileSync(join(distDir, "launcher-registry.tsv"), "utf8");
        const outputs = [
          app,
          ...tsv
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => l.split("\t")[0]),
        ];
        launcher = launcherBundleHash(distDir, outputs);
      } catch {
        launcher = null; // no registry — plain single-app comparison stands
      }
    }
    if (local === device) {
      emit({ type: "bundle-ok", detail: `${app} @ ${device}` });
    } else if (launcher === device) {
      emit({ type: "bundle-ok", detail: `${app} (multi-app) @ ${device}` });
    } else {
      emit({
        type: "bundle-mismatch",
        detail: `${app}: device ${device} != dist ${local}${launcher ? ` (multi-app ${launcher})` : ""}`,
      });
    }
  }

  function handleDeviceLine(line: string): void {
    let msg: Record<string, unknown> | null = null;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = null;
    }
    if (msg?.t === "hello") {
      emit({ type: "hello", detail: String(msg.app ?? "?") });
      // Fresh boot: ask for device stats — the reply carries the bundle
      // hash. A build too old to know devStats never replies, which would
      // fail SILENT — the one thing this tripwire must not do — so a
      // watchdog turns silence into a verdict too (first caught live: an
      // EBOOT embedding the pre-rename shim during this feature's own
      // hardware pass).
      try {
        appendFileSync(inPath, JSON.stringify({ t: "devStats" }) + "\n");
        if (statsWatchdog) clearTimeout(statsWatchdog);
        statsWatchdog = setTimeout(() => {
          emit({
            type: "bundle-silent",
            detail: "no devStats reply in 3 s — the embedded bundle predates the handshake (stale or pre-#118)",
          });
        }, 3000);
      } catch {
        // usbhostfs hiccup — the next hello retries
      }
    }
    if (msg?.t === "devStats" && msg.data && typeof msg.data === "object") {
      if (statsWatchdog) {
        clearTimeout(statsWatchdog);
        statsWatchdog = null;
      }
      checkBundle(msg.data as Record<string, unknown>);
      // fall through: panels get the stats reply too
    }
    if (msg?.t === "screenshotRaw") {
      try {
        const data = convertShot(
          String(msg.file ?? "shot.raw"),
          Number(msg.w ?? 480),
          Number(msg.h ?? 272),
          Number(msg.stride ?? 512),
        );
        if (data && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ t: "screenshot", frame: msg.frame ?? 0, data }));
          emit({ type: "screenshot", detail: `frame ${msg.frame}` });
        }
      } catch {
        // partial write — the user can click again
      }
      return; // never forward the raw notice itself
    }
    if (ws && ws.readyState === 1) ws.send(line);
  }

  let statsWatchdog: ReturnType<typeof setTimeout> | null = null;
  let offset = 0;
  let sawDevice = false;
  const tail = setInterval(() => {
    let size: number;
    try {
      size = statSync(outPath).size;
    } catch {
      return; // file vanished (usbhostfs restart) — recreated on next write
    }
    if (size < offset) offset = 0; // truncated/recreated: start over
    if (size === offset) return;
    const buf = readFileSync(outPath);
    const text = buf.subarray(offset, size).toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return; // partial line: wait for the device to finish it
    offset += Buffer.byteLength(text.slice(0, lastNl + 1), "utf8");
    for (const line of text.slice(0, lastNl).split("\n")) {
      if (!line.trim()) continue;
      handleDeviceLine(line);
    }
    if (!sawDevice) {
      sawDevice = true;
      emit({ type: "device-talking" });
    }
  }, 100);

  return {
    boxDir,
    stop() {
      stopped = true;
      clearInterval(tail);
      if (statsWatchdog) clearTimeout(statsWatchdog);
      ws?.close();
      try {
        if (existsSync(enablePath)) rmSync(enablePath);
      } catch {
        // usbhostfs may already be gone
      }
    },
  };
}
