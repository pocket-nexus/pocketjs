// The agent's own screen: a Pocket app running headless on the computer, in
// the deterministic sim host with the 3DS geometry (hosts/sim/console-3ds.ts),
// that only the agent operates. The user sees it on the mascot's monitor.
//
// The sim swaps process globals (Date.now inside a frame, globalThis.ui/net
// and the frame handler), so it runs in a child process: `OwnScreen` is the
// companion's side, `runOwnScreenChild` the child's. They speak JSON lines
// over stdio; pixels travel as base64 RGB565 (320x240, little-endian).
//
// The child steps the app at 60 frames a second of wall time while it is
// booted, so network replies (served by the companion's own fetch, the same
// policy as the link's `net`) and animations land as they would on a console.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_SETTLE_FRAMES,
  AGENT_SHOT_HEIGHT,
  AGENT_SHOT_WIDTH,
  type AgentButton,
  type AgentText,
} from "../../contracts/spec/agent.ts";
import { NET_ERROR, NET_MAX_INFLIGHT } from "../../contracts/spec/net.ts";

export const OWN_SCREEN_SCRIPT = join(import.meta.dir, "own-screen.ts");

/** contracts/spec/spec.ts BTN, by the console's button names (A sits where
 *  CIRCLE does, as hosts/3ds/src/input.c maps them). */
const BUTTONS: Record<AgentButton, number> = {
  SELECT: 0x0001,
  START: 0x0008,
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
  L: 0x0100,
  R: 0x0200,
  X: 0x1000,
  A: 0x2000,
  B: 0x4000,
  Y: 0x8000,
};

export interface OwnScreenAnswer {
  ok: boolean;
  error?: string;
  texts: AgentText[];
  /** RGB565 little-endian, AGENT_SHOT_WIDTH x AGENT_SHOT_HEIGHT. */
  rgb565: Uint8Array;
}

export interface OwnScreenBundle {
  js: string;
  pak?: string;
  output: string;
}

// ---------------------------------------------------------------------------
// The companion's side
// ---------------------------------------------------------------------------

export class OwnScreen {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private buffer = "";
  /** The app booted now, by output name. */
  app = "";

  constructor(
    private readonly command: string[],
    private readonly log?: (line: string) => void,
  ) {}

  /** Start (or restart) the child with `bundle`. */
  async boot(bundle: OwnScreenBundle): Promise<OwnScreenAnswer> {
    this.close();
    const child = spawn(this.command[0], this.command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) this.log?.(`own-screen: ${line.trim().slice(0, 300)}`);
    });
    child.stdin.on("error", () => {});
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.app = "";
      for (const pending of this.pending.values()) pending.reject(new Error(`own screen exited (${code})`));
      this.pending.clear();
    });
    const answer = await this.call({ cmd: "boot", js: bundle.js, pak: bundle.pak, output: bundle.output });
    this.app = bundle.output;
    return answer;
  }

  get booted(): boolean {
    return this.child !== undefined && this.app !== "";
  }

  /** observe / tap / drag / press / type / wait. */
  act(name: string, args: Record<string, unknown>): Promise<OwnScreenAnswer> {
    return this.call({ cmd: "act", name, args });
  }

  /** The screen now, without acting. */
  frame(): Promise<OwnScreenAnswer> {
    return this.call({ cmd: "frame" });
  }

  private async call(message: Record<string, unknown>): Promise<OwnScreenAnswer> {
    const child = this.child;
    if (!child) throw new Error("own screen is not running");
    const id = this.nextId++;
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, ...message })}\n`);
    });
    return {
      ok: reply.ok === true,
      error: typeof reply.error === "string" ? reply.error : undefined,
      texts: Array.isArray(reply.texts) ? (reply.texts as AgentText[]) : [],
      rgb565: typeof reply.rgb565 === "string" ? new Uint8Array(Buffer.from(reply.rgb565, "base64")) : new Uint8Array(0),
    };
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.log?.(`own-screen: ${line.slice(0, 200)}`);
        continue;
      }
      const id = message.id as number;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      pending.resolve(message);
    }
  }

  close() {
    const child = this.child;
    this.child = undefined;
    this.app = "";
    for (const pending of this.pending.values()) pending.reject(new Error("own screen closed"));
    this.pending.clear();
    child?.kill();
  }
}

// ---------------------------------------------------------------------------
// Pixels and texts
// ---------------------------------------------------------------------------

/** RGBA8888 -> RGB565 little-endian. */
export function rgbaToRgb565(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 2);
  for (let i = 0, o = 0; i < width * height * 4; i += 4, o += 2) {
    const value = ((rgba[i] >> 3) << 11) | ((rgba[i + 1] >> 2) << 5) | (rgba[i + 2] >> 3);
    out[o] = value & 0xff;
    out[o + 1] = value >> 8;
  }
  return out;
}

/** RGB565 little-endian -> RGBA8888 (opaque). */
export function rgb565ToRgba(rgb565: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; i < width * height * 2; i += 2, o += 4) {
    const value = rgb565[i] | (rgb565[i + 1] << 8);
    const r = (value >> 11) & 31;
    const g = (value >> 5) & 63;
    const b = value & 31;
    out[o] = (r << 3) | (r >> 2);
    out[o + 1] = (g << 2) | (g >> 4);
    out[o + 2] = (b << 3) | (b >> 2);
    out[o + 3] = 255;
  }
  return out;
}

interface TreeNode {
  rect: [number, number, number, number] | null;
  text?: string;
  hidden?: boolean;
  children: TreeNode[];
}

/** Every visible text with its box, in tree order (the sim's flatTexts with
 *  boxes kept): a multi-line text is one entry per line, an embossed label
 *  (the same text twice in a row) one entry. */
export function screenTexts(root: TreeNode | null, width = AGENT_SHOT_WIDTH, height = AGENT_SHOT_HEIGHT): AgentText[] {
  const out: AgentText[] = [];
  const walk = (node: TreeNode | null, box: TreeNode["rect"]) => {
    if (!node || node.hidden) return;
    const rect = node.rect ?? box;
    if (node.text && rect) {
      const [x, y, w, h] = rect;
      if (x < width && y < height && x + w > 0 && y + h > 0 && node.text.trim()) {
        const lines = node.text.split("\n");
        const lineH = h / lines.length;
        lines.forEach((line, index) => {
          const previous = out[out.length - 1];
          if (!line.trim() || (previous && previous.text === line && Math.abs(previous.y - (y + index * lineH)) <= 2)) return;
          out.push({ text: line, x: Math.round(x), y: Math.round(y + index * lineH), w: Math.round(w), h: Math.round(lineH) });
        });
      }
    }
    for (const child of node.children) walk(child, rect);
  };
  walk(root, null);
  // Reading order: rows top to bottom (4 px of slack for baselines), then
  // left to right. Tree order paints a navigation bar after the page.
  return out.sort((a, b) => Math.floor(a.y / 4) - Math.floor(b.y / 4) || a.x - b.x);
}

// ---------------------------------------------------------------------------
// The child
// ---------------------------------------------------------------------------

/** A NET module whose transport is the companion's own fetch: completions
 *  become visible at the first poll after they land. */
async function liveNet() {
  const { performNet, normalizeNetRequest, NetFailure } = await import("./fetch.ts");
  const bodies = new Map<number, Uint8Array>();
  const aborts = new Map<number, AbortController>();
  const visible: object[] = [];
  let nextHandle = 1;
  let lastError = "";
  const ns = {
    start(metaJson: string, body: ArrayBuffer): number {
      let meta;
      try {
        meta = normalizeNetRequest({ ...(JSON.parse(metaJson) as Record<string, unknown>), bytes: body.byteLength });
      } catch (error) {
        lastError = `${(error as { code?: string }).code ?? NET_ERROR.invalidRequest}: ${(error as Error).message}`;
        return -1;
      }
      if (aborts.size >= NET_MAX_INFLIGHT) {
        lastError = `${NET_ERROR.busy}: at most ${NET_MAX_INFLIGHT} requests may be in flight`;
        return -1;
      }
      const handle = nextHandle++;
      const abort = new AbortController();
      aborts.set(handle, abort);
      const { bytes: _bytes, ...request } = meta;
      performNet({ ...request, body: new Uint8Array(body).slice() }, { signal: abort.signal }).then(
        (response) => {
          if (!aborts.delete(handle)) return;
          bodies.set(handle, response.body);
          visible.push({ t: "done", h: handle, status: response.status, url: response.url, headers: response.headers, bytes: response.body.byteLength });
        },
        (error: unknown) => {
          if (!aborts.delete(handle)) return;
          const failure = error instanceof NetFailure ? error : { code: NET_ERROR.other, message: String(error) };
          visible.push({ t: "error", h: handle, code: failure.code, message: failure.message });
        },
      );
      return handle;
    },
    take(handle: number, into: ArrayBuffer): number {
      const body = bodies.get(handle);
      if (!body || into.byteLength !== body.byteLength) return -1;
      bodies.delete(handle);
      new Uint8Array(into).set(body);
      return body.byteLength;
    },
    cancel(handle: number) {
      aborts.get(handle)?.abort();
      aborts.delete(handle);
      bodies.delete(handle);
    },
    poll(): string | undefined {
      return visible.length ? JSON.stringify(visible.splice(0)) : undefined;
    },
    lastError: () => lastError,
  };
  return { ns, inflight: () => aborts.size };
}

export async function runOwnScreenChild(): Promise<void> {
  const { bootConsole3ds } = await import("../../hosts/sim/console-3ds.ts");
  type Console = Awaited<ReturnType<typeof bootConsole3ds>>;
  type StepInput = Parameters<Console["step"]>[0];
  const net = await liveNet();
  let world: Console | undefined;
  let frame = 0;
  const queue: StepInput[] = [];
  const waiters: { at: number; wake: () => void }[] = [];
  let failure = "";
  const FRAME_MS = 1000 / 60;

  const out = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const waitFrames = (count: number) => new Promise<void>((wake) => waiters.push({ at: frame + count, wake }));

  const loop = async () => {
    let next = performance.now();
    while (world && !failure) {
      const input = queue.shift();
      try {
        await world.step(input);
      } catch (error) {
        failure = (error as Error).message.split("\n")[0] ?? "the app failed";
      }
      frame += 1;
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].at <= frame) waiters.splice(i, 1)[0].wake();
      }
      next += FRAME_MS;
      const delay = next - performance.now();
      if (delay > 0) await new Promise((wake) => setTimeout(wake, delay));
      else if (delay < -100) next = performance.now(); // fell behind: do not sprint
    }
    for (const waiter of waiters.splice(0)) waiter.wake();
  };

  /** Let the app settle: AGENT_SETTLE_FRAMES frames, then while requests are
   *  in flight, at most 4 s more. */
  const settle = async () => {
    await waitFrames(queue.length + AGENT_SETTLE_FRAMES);
    for (let waited = 0; net.inflight() > 0 && waited < 240 && !failure; waited += 6) await waitFrames(6);
    if (net.inflight() === 0) await waitFrames(4);
  };

  const report = (ok = true, error?: string) => {
    if (!world) return { ok: false, error: "no app is running on the own screen", texts: [], rgb565: "" };
    const pixels = world.world.pixels("auxiliary");
    return {
      ok: ok && !failure,
      error: failure || error,
      texts: screenTexts(world.world.tree("auxiliary") as TreeNode | null),
      rgb565: Buffer.from(rgbaToRgb565(pixels.rgba, pixels.width, pixels.height)).toString("base64"),
    };
  };

  const touch = (x: number, y: number) => ({ touches: [{ x, y }], surface: "auxiliary" as const });
  const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

  const act = async (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case "observe":
        return report();
      case "tap": {
        const x = num(args.x);
        const y = num(args.y);
        for (let i = 0; i < 3; i++) queue.push(touch(x, y));
        queue.push({}, {});
        await settle();
        return report();
      }
      case "drag": {
        const [x0, y0, x1, y1] = [num(args.x0), num(args.y0), num(args.x1), num(args.y1)];
        const steps = 14;
        for (let i = 0; i <= steps; i++) queue.push(touch(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps));
        queue.push({}, {});
        await settle();
        return report();
      }
      case "press": {
        const button = BUTTONS[String(args.button).toUpperCase() as AgentButton];
        if (!button) return report(false, `unknown button ${String(args.button)}`);
        const times = Math.max(1, Math.min(20, Math.floor(num(args.times, 1))));
        for (let i = 0; i < times; i++) queue.push({ buttons: button }, {}, {}, {}, {}, {});
        await settle();
        return report();
      }
      case "wait": {
        const ms = Math.max(100, Math.min(5000, num(args.ms, 1000)));
        await waitFrames(Math.round(ms / FRAME_MS));
        return report();
      }
      case "type":
        return report(false, "the own screen has no keyboard input yet");
      default:
        return report(false, `unknown action ${name}`);
    }
  };

  let lineBuffer = "";
  let chain = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    lineBuffer += chunk;
    let newline: number;
    while ((newline = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      // One command at a time: an action's frames never interleave another's.
      chain = chain.then(async () => {
        const id = message.id;
        try {
          if (message.cmd === "boot") {
            const js = String(message.js);
            if (!existsSync(js)) throw new Error(`bundle missing: ${js}`);
            const booting = bootConsole3ds({
              js,
              pak: typeof message.pak === "string" ? message.pak : undefined,
              current: String(message.output),
              link: null,
              wifi: null,
              camera: false,
              epochMs: Date.now(),
            });
            // The bundle evaluates after the boot's first await: the live NET
            // module is in place before the app's first request.
            (globalThis as Record<string, unknown>).net = net.ns;
            world = await booting;
            void loop();
            await waitFrames(30);
            await settle();
            out({ id, ...report() });
          } else if (message.cmd === "act") {
            out({ id, ...(await act(String(message.name), (message.args ?? {}) as Record<string, unknown>)) });
          } else if (message.cmd === "frame") {
            out({ id, ...report() });
          } else out({ id, ok: false, error: `unknown command ${String(message.cmd)}` });
        } catch (error) {
          out({ id, ok: false, error: (error as Error).message.split("\n")[0], texts: [], rgb565: "" });
        }
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (import.meta.main) void runOwnScreenChild();
