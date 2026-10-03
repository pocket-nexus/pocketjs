#!/usr/bin/env bun

// Interactive real-PSP switcher over PSPLINK. The Mac terminal owns the game
// picker; the PSP only runs the selected PRX.

import { $ } from "bun";
import { guardDeviceCommand } from "./device-lease.ts";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createServer } from "node:net";

type Demo = {
  name: string;
  title: string;
  folder: string;
  prx: string;
};

type Options = {
  release: boolean;
  noBuild: boolean;
  buildAll: boolean;
  rebuild: boolean;
  dryRun: boolean;
  trace: boolean;
  basePort?: number;
};

const ROOT = new URL("..", import.meta.url).pathname;
const DEMOS_DIR = join(ROOT, "apps");
const OUT_ROOT = join(ROOT, "dist/psplink");
const MAIN_SUFFIX = "-main.tsx";
const DEFAULT_PORT = 10000;
const VSH_MAIN = "flash0:/vsh/module/vshmain.prx";

const BTN_UP = "\x1b[A";
const BTN_DOWN = "\x1b[B";

function usageText(): string {
  return [
    "usage:",
    "  bun psplink [options]",
    "",
    "options:",
    "  --debug                 Build debug PRXs (default: release)",
    "  --release               Build release PRXs",
    "  --build-all             Build every demo before connecting to the PSP",
    "  --no-build              Never build; require existing dist/psplink/*.prx",
    "  --rebuild               Delete dist/psplink before building or launching",
    "  --trace                 Bake PocketJS trace logging into built PRXs",
    "  --port <port>           Base PSPLINK TCP port (default: first free block from 10000)",
    "  --dry-run               List demos and planned PRX paths, then exit",
    "  -h, --help              Show this help",
    "",
    "controls:",
    "  Up/Down                 Move selection",
    "  Enter                   Reset PSPLINK and start the selected game",
    "  r                       Rebuild selected game PRX",
    "  q                       Return PSP to XMB and quit",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): Options {
  let release = true;
  let noBuild = false;
  let buildAll = false;
  let rebuild = false;
  let dryRun = false;
  let trace = false;
  let basePort: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usageText());
      process.exit(0);
    } else if (arg === "--debug") {
      release = false;
    } else if (arg === "--release") {
      release = true;
    } else if (arg === "--no-build") {
      noBuild = true;
    } else if (arg === "--build-all") {
      buildAll = true;
    } else if (arg === "--rebuild") {
      rebuild = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--trace") {
      trace = true;
    } else if (arg === "--port") {
      basePort = parsePort(argv[++index], arg);
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${usageText()}`);
    }
  }
  if (noBuild && buildAll) throw new Error("--no-build cannot be combined with --build-all");
  if (noBuild && rebuild) throw new Error("--no-build cannot be combined with --rebuild");
  return { release, noBuild, buildAll, rebuild, dryRun, trace, basePort };
}

function parsePort(value: string | undefined, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${flag} must be an integer TCP port between 1024 and 65535`);
  }
  return port;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

async function titleFor(name: string): Promise<string> {
  const main = existsSync(join(DEMOS_DIR, name, "main.tsx"))
    ? join(DEMOS_DIR, name, "main.tsx")
    : join(DEMOS_DIR, `${name}${MAIN_SUFFIX}`);
  const src = await Bun.file(main).text();
  return src.match(/^\/\/\s*@title\s+(.+)$/m)?.[1].trim() ?? name;
}

async function listDemos(): Promise<Demo[]> {
  const names = new Set<string>();
  for (const file of readdirSync(DEMOS_DIR)) {
    const path = join(DEMOS_DIR, file);
    if (statSync(path).isDirectory() && existsSync(join(path, "main.tsx"))) names.add(file);
    else if (file.endsWith(MAIN_SUFFIX)) names.add(file.slice(0, -MAIN_SUFFIX.length));
  }

  const demos: Demo[] = [];
  for (const name of [...names].sort()) {
    const title = await titleFor(name);
    const folder = `PocketJS-${safeName(name)}`;
    demos.push({
      name,
      title,
      folder,
      prx: join(OUT_ROOT, `${folder}.prx`),
    });
  }
  return demos;
}

async function buildDemo(demo: Demo, opts: Options): Promise<void> {
  const profile = opts.release ? "release" : "debug";
  const source = join(ROOT, "hosts/psp/target/mipsel-sony-psp", profile, "pocketjs-psp.prx");
  await $`bun tools/psp.ts ${demo.name} ${opts.release ? "--release" : ""}`
    .cwd(ROOT)
    .env({ ...process.env, POCKETJS_TRACE: opts.trace ? "1" : "" });
  if (!existsSync(source)) throw new Error(`expected PSP PRX was not created: ${source}`);
  mkdirSync(OUT_ROOT, { recursive: true });
  await Bun.write(demo.prx, await Bun.file(source).arrayBuffer());
}

/** Newest mtime (ms) under `dir`, skipping build outputs and caches. */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path));
    } else if (/\.(tsx?|rs|json|svg|toml)$/.test(entry.name) && !entry.name.endsWith(".generated.ts")) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

/** A cached PRX is stale when any input that bakes into it is newer: the
 *  demo's sources, the TS runtime/compiler/spec, the Rust core or the PSP
 *  host. (The old exists-only check kept serving builds from hours ago.) */
function prxStale(demo: Demo): boolean {
  if (!existsSync(demo.prx)) return true;
  const built = statSync(demo.prx).mtimeMs;
  const inputs = [
    join(DEMOS_DIR, demo.name),
    join(DEMOS_DIR, `${demo.name}${MAIN_SUFFIX}`),
    join(ROOT, "framework", "src"),
    join(ROOT, "framework", "compiler"),
    join(ROOT, "contracts", "spec"),
    join(ROOT, "engine/core/src"),
    join(ROOT, "hosts/psp/src"),
    join(ROOT, "hosts/psp/build.rs"),
    join(ROOT, "pocket.config.ts"),
  ];
  for (const input of inputs) {
    const newest = existsSync(input) && statSync(input).isFile()
      ? statSync(input).mtimeMs
      : newestMtime(input);
    if (newest > built) return true;
  }
  return false;
}

async function prepareCache(demos: Demo[], opts: Options, render?: (status: string) => void): Promise<void> {
  if (opts.rebuild) rmSync(OUT_ROOT, { recursive: true, force: true });
  mkdirSync(OUT_ROOT, { recursive: true });
  if (opts.noBuild) {
    const missing = demos.filter((demo) => !existsSync(demo.prx)).map((demo) => basename(demo.prx));
    if (missing.length > 0) {
      throw new Error(`--no-build requested, but missing PRX files: ${missing.join(", ")}`);
    }
    return;
  }

  if (!opts.buildAll) return;

  for (const [index, demo] of demos.entries()) {
    if (!opts.rebuild && !prxStale(demo)) continue;
    render?.(`building ${demo.name} (${index + 1}/${demos.length})`);
    await buildDemo(demo, opts);
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function findBasePort(start: number): Promise<number> {
  for (let base = start; base <= start + 3000; base += 100) {
    let ok = true;
    for (let offset = 0; offset <= 8; offset += 1) {
      if (!(await portFree(base + offset))) {
        ok = false;
        break;
      }
    }
    if (ok) return base;
  }
  throw new Error("no free TCP port block found for PSPLINK");
}

class PsplinkSession {
  private connectCount = 0;
  private child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  private stopped = false;

  constructor(
    private readonly usbhostfs: string,
    private readonly pspsh: string,
    private readonly basePort: number,
    private readonly hostDir: string,
  ) {}

  async start(render: (status: string) => void): Promise<void> {
    const existing = (await $`pgrep -x usbhostfs_pc`.nothrow().text()).trim();
    if (existing) render(`another usbhostfs_pc is running: ${existing.split("\n").join(", ")}`);

    this.child = Bun.spawn([this.usbhostfs, "-b", String(this.basePort), this.hostDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.pump(this.child.stdout);
    void this.pump(this.child.stderr);

    render("waiting for PSP; launch PSPLINK on the PSP");
    if (!(await this.waitForConnect(0, 120_000))) {
      throw new Error("PSP never connected. Check the USB data cable and launch PSPLINK on the PSP.");
    }
  }

  async load(demo: Demo, render: (status: string) => void): Promise<boolean> {
    const prev = this.connectCount;
    render(`resetting PSPLINK for ${demo.title}`);
    const reset = await this.runPspsh("reset");
    if (reset.timedOut) {
      await this.waitForConnect(prev, 2000);
    } else {
      await this.waitForConnect(prev, 20_000);
    }

    render(`starting ${demo.title}`);
    const out = await this.runPspsh(`ldstart host0:/${basename(demo.prx)}`, 10_000);
    if (out.timedOut) {
      render(`ldstart timed out for ${demo.title}`);
      return false;
    }
    if (/Failed|Error/i.test(out.text)) {
      render(out.text || `load failed for ${demo.title}`);
      return false;
    }
    render(`running ${demo.title}`);
    return true;
  }

  async exitToXmb(render: (status: string) => void): Promise<void> {
    render("loading XMB through PSPLINK");
    const out = await this.runPspshScript(["reset vsh", VSH_MAIN], 15_000);
    if (/Failed|Error|Unknown command|connect:/i.test(out.text)) {
      render(out.text || "XMB load failed");
      return;
    }
    render("XMB load requested");
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.child?.kill();
    } catch {
      // already gone
    }
    if (this.child) {
      try {
        process.kill(this.child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const _ of text.matchAll(/Connected to device/g)) this.connectCount += 1;
    }
    reader.releaseLock();
  }

  private async waitForConnect(prev: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (this.connectCount <= prev) {
      if (Date.now() - start > timeoutMs) return false;
      await Bun.sleep(200);
    }
    return true;
  }

  private async runPspsh(command: string, timeoutMs = 8000): Promise<{ text: string; timedOut: boolean }> {
    const child = Bun.spawn([this.pspsh, "-p", String(this.basePort), "-e", command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text().catch((error) => String(error)),
      new Response(child.stderr).text().catch((error) => String(error)),
      child.exited,
    ]);
    clearTimeout(timer);
    return { text: (stdout + stderr).trim(), timedOut };
  }

  private async runPspshScript(commands: string[], timeoutMs = 15_000): Promise<{ text: string; timedOut: boolean }> {
    const child = Bun.spawn([this.pspsh, "-p", String(this.basePort), "-n", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(`${commands.join("\n")}\n`);
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text().catch((error) => String(error)),
      new Response(child.stderr).text().catch((error) => String(error)),
      child.exited,
    ]);
    clearTimeout(timer);
    return { text: (stdout + stderr).trim(), timedOut };
  }
}

class Picker {
  private cursor = 0;
  private active = -1;
  private busy = false;
  private status = "";

  constructor(
    private readonly demos: Demo[],
    private readonly onPick: (demo: Demo, index: number, render: (status: string) => void) => Promise<boolean>,
    private readonly onRebuild: (demo: Demo, render: (status: string) => void) => Promise<void>,
    private readonly onQuit: (render: (status: string) => void) => Promise<void>,
  ) {}

  async run(initialStatus: string): Promise<void> {
    this.status = initialStatus;
    this.render();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    for await (const key of process.stdin) {
      if (key === "\u0003") {
        await this.quit();
        break;
      }
      if (this.busy) continue;
      if (key === "q") {
        await this.quit();
        break;
      }
      if (key === BTN_UP || key === "k") this.move(-1);
      else if (key === BTN_DOWN || key === "j") this.move(1);
      else if (key === "\r" || key === "\n") await this.pick();
      else if (key === "r") await this.rebuild();
      this.render();
    }
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }

  private move(delta: number): void {
    this.cursor = (this.cursor + this.demos.length + delta) % this.demos.length;
  }

  private async pick(): Promise<void> {
    const index = this.cursor;
    await this.withBusy(async (render) => {
      const loaded = await this.onPick(this.demos[index], index, render);
      if (loaded) this.active = index;
    });
  }

  private async rebuild(): Promise<void> {
    const index = this.cursor;
    await this.withBusy(async (render) => {
      await this.onRebuild(this.demos[index], render);
    });
  }

  private async quit(): Promise<void> {
    await this.withBusy(async (render) => {
      await this.onQuit(render);
    });
  }

  private async withBusy(fn: (render: (status: string) => void) => Promise<void>): Promise<void> {
    this.busy = true;
    const render = (status: string) => {
      this.status = status;
      this.render();
    };
    try {
      await fn(render);
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  private render(): void {
    process.stdout.write("\x1b[2J\x1b[H");
    console.log("PocketJS PSPLINK Switcher");
    console.log("");
    console.log("Use Up/Down, Enter to launch, r to rebuild selected, q to return to XMB and quit.");
    console.log("");
    for (const [index, demo] of this.demos.entries()) {
      const cursor = index === this.cursor ? ">" : " ";
      const active = index === this.active ? "*" : " ";
      console.log(`${cursor} ${active} ${demo.title}  (${demo.name})`);
    }
    console.log("");
    console.log(this.busy ? `Status: ${this.status}...` : `Status: ${this.status}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  if (!opts.dryRun) {
    await guardDeviceCommand("psp:usb:transport");
    await guardDeviceCommand("psp:usb");
  }
  const demos = await listDemos();
  if (demos.length === 0) throw new Error(`no demos found under ${DEMOS_DIR}`);

  if (opts.dryRun) {
    console.log(`PocketJS demos (${demos.length}):`);
    for (const demo of demos) console.log(`- ${demo.name}: ${demo.title} -> ${demo.prx}`);
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error("bun psplink requires an interactive TTY; use --dry-run for non-interactive checks.");
  }

  const usbhostfs = Bun.which("usbhostfs_pc");
  const pspsh = Bun.which("pspsh");
  if (!usbhostfs || !pspsh) {
    throw new Error("PSPLINK host tools not found on PATH (need usbhostfs_pc and pspsh).");
  }

  await prepareCache(demos, opts, (status) => console.log(status));

  const basePort = opts.basePort ?? (await findBasePort(Number(process.env.PSP_HW_PORT ?? DEFAULT_PORT)));
  const session = new PsplinkSession(usbhostfs, pspsh, basePort, OUT_ROOT);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    session.stop();
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);

  await session.start((status) => console.log(status));
  const picker = new Picker(
    demos,
    async (demo, _index, render) => {
      if (opts.noBuild) {
        if (!existsSync(demo.prx)) throw new Error(`missing ${basename(demo.prx)} and --no-build was set`);
      } else if (prxStale(demo)) {
        render(`building ${demo.name}`);
        await buildDemo(demo, opts);
      }
      return await session.load(demo, render);
    },
    async (demo, render) => {
      render(`rebuilding ${demo.name}`);
      await buildDemo(demo, opts);
      render(`rebuilt ${demo.name}`);
    },
    async (render) => {
      await session.exitToXmb(render);
    },
  );
  await picker.run(`PSP connected on port ${basePort}; host0: ${OUT_ROOT}`);
  cleanup();
}

try {
  await main();
} catch (error) {
  process.stdin.setRawMode?.(false);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
