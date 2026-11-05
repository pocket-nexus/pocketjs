// tools/devtools.ts — Pocket DevTools, one command (docs/DEVTOOLS.md).
//
//   bun run devtools                # panel + hub + mailbox bridge
//   bun run devtools cards          # + build, link and launch cards on a real PSP
//   bun run devtools cards -r       # release profile
//   bun run devtools --port 9000
//
// One process owns the whole loop:
//   · the dev server (browser host at /, panel at /devtools, WS hub at /ws)
//   · the PSPLINK USB mailbox bridge (device ⇄ panel)
//   · optionally the PSP session itself: build the EBOOT, serve host0: over
//     usbhostfs, ldstart the PRX — and if a `bun psplink` / `bun run hw`
//     session is ALREADY running, it is detected and bridged instead of
//     fighting it for the cable.
//
// Shortcuts while running:  o open panel · r rebuild + relaunch · q quit

import { $ } from "bun";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { startDevServer, demoManifest } from "../tools/dev/web/server.ts";
import { startBridge, type Bridge } from "./devtools-bridge.ts";
import { pspDemoPackage } from "./psp.ts";

const ROOT = new URL("..", import.meta.url).pathname;

// ---- args -------------------------------------------------------------------

const argv = Bun.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const positional = argv.filter((a) => !a.startsWith("-") && a !== argValue("--port") && a !== argValue("--dir") && a !== argValue("--pocket"));
function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const release = flags.has("-r") || flags.has("--release");
const noBuild = flags.has("--no-build");
const wantedPort = Number(argValue("--port") ?? process.env.PORT ?? 8130);
const app = positional[0];
const packageArg = argValue("--pocket");
if (flags.has("--pocket") && (!packageArg || packageArg.startsWith("--")))
  throw new Error("--pocket requires the compiled package path used for the EBOOT");
if (app && packageArg) throw new Error("choose a demo name or --pocket, not both");
const packagePath = packageArg ? resolve(packageArg) : undefined;

if (flags.has("-h") || flags.has("--help")) {
  console.log(`Usage: bun run devtools [app | --pocket application.pocket] [-r|--release] [--no-build] [--port n] [--dir path]

Starts the Pocket DevTools panel + WS hub + PSPLINK mailbox bridge in one
process. With [app] it also builds and launches that demo on a real PSP
(unless a tools/psplink/hw session is already running — then it just bridges in).
Use --pocket for a compiled single-app package, or its captured build input.
The bridge verifies that exact package; it does not search nearby .pocket files.

Demos: ${demoNames().join(", ")}`);
  process.exit(0);
}

function demoNames(): string[] {
  const names = new Set<string>();
  for (const d of demoManifest()) names.add(d.name.replace(/-main$/, ""));
  return [...names].sort();
}

// ---- pretty output ------------------------------------------------------------

const tty = process.stdout.isTTY === true;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const cyan = (s: string) => (tty ? `\x1b[36m${s}\x1b[0m` : s);
const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
const arrow = green("  ➜  ");
const status = (line: string) => console.log(dim("  [psp] ") + line);

// ---- external PSPLINK session detection ---------------------------------------

interface ExternalSession {
  pid: number;
  dir: string;
  port: number;
}

async function detectUsbhostfs(): Promise<ExternalSession | null> {
  const pids = (await $`pgrep -x usbhostfs_pc`.nothrow().text()).trim();
  if (!pids) return null;
  const pid = Number(pids.split("\n")[0]);
  const args = (await $`ps -o args= -p ${pid}`.nothrow().text()).trim();
  // usbhostfs_pc [-b <port>] <dir>
  const portMatch = args.match(/-b\s+(\d+)/);
  const parts = args.split(/\s+/);
  const dir = parts[parts.length - 1];
  if (!dir || !existsSync(dir)) return null;
  return { pid, dir, port: portMatch ? Number(portMatch[1]) : 10000 };
}

// ---- managed PSP session (build + usbhostfs + ldstart, hw.ts patterns) ---------

const PRX = "host0:/pocketjs-psp.prx";
const profile = release ? "release" : "debug";
const targetDir = join(ROOT, "programs", "psp", "target", "mipsel-sony-psp", profile);

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
    for (let i = 0; i <= 8; i++) {
      if (!(await portFree(base + i))) {
        ok = false;
        break;
      }
    }
    if (ok) return base;
  }
  throw new Error("no free TCP port block for the PSPLINK link");
}

interface ManagedSession {
  basePort: number;
  child: ReturnType<typeof Bun.spawn>;
  connectCount: () => number;
  kill(): void;
}

let managed: ManagedSession | null = null;

async function buildApp(): Promise<boolean> {
  if (noBuild) return existsSync(join(targetDir, "pocketjs-psp.prx"));
  status(`building ${bold(packagePath ?? app!)} (${profile})…`);
  const input = packagePath ? ["--pocket", packagePath] : [app!];
  const res = await $`bun ${join(ROOT, "tools", "psp.ts")} ${input} ${release ? ["--release"] : []}`
    .nothrow()
    .quiet();
  if (res.exitCode !== 0) {
    status(yellow("build failed:"));
    console.log(res.stderr.toString().split("\n").slice(-15).join("\n"));
    return false;
  }
  return true;
}

async function startUsbhostfs(): Promise<ManagedSession> {
  const usbhostfs = Bun.which("usbhostfs_pc");
  const pspsh = Bun.which("pspsh");
  if (!usbhostfs || !pspsh) {
    throw new Error("PSPLINK host tools not found on PATH (need usbhostfs_pc and pspsh)");
  }
  const basePort = await findBasePort(Number(process.env.PSP_HW_PORT ?? 10000));
  const child = Bun.spawn([usbhostfs, "-b", String(basePort), targetDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let connects = 0;
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      for (const _ of dec.decode(chunk).matchAll(/Connected to device/g)) connects++;
    }
  };
  void pump(child.stdout);
  void pump(child.stderr);
  return {
    basePort,
    child,
    connectCount: () => connects,
    kill() {
      child.kill();
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    },
  };
}

async function runPspsh(basePort: number, command: string, timeoutMs = 8000): Promise<string> {
  const pspsh = Bun.which("pspsh")!;
  const child = Bun.spawn([pspsh, "-p", String(basePort), "-e", command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return (stdout + stderr).trim();
}

async function waitForConnect(s: ManagedSession, prev: number, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (s.connectCount() <= prev) {
    if (Date.now() - t0 > timeoutMs) return false;
    await Bun.sleep(200);
  }
  return true;
}

async function launchApp(): Promise<void> {
  if (!managed) return;
  const prev = managed.connectCount();
  status("resetting PSPLINK…");
  await runPspsh(managed.basePort, "reset");
  await waitForConnect(managed, prev, 8000);
  const out = await runPspsh(managed.basePort, "ldstart " + PRX);
  if (/Failed|Error/i.test(out)) {
    status(yellow(`ldstart failed: ${out}`));
  } else {
    status(green(`launched ${packagePath ?? app} on the PSP`));
  }
}

// ---- boot ---------------------------------------------------------------------

const t0 = performance.now();
const server = startDevServer({ port: wantedPort, portRetries: 10 });

let bridge: Bridge;
let pspLine: string;

const dirFlag = argValue("--dir");
const external = dirFlag ? null : await detectUsbhostfs();
if (dirFlag) {
  // An explicit --dir always wins: it targets a desktop-host mailbox
  // (pocket-ui-wgpu) and must not be hijacked by a running PSP session.
  bridge = startBridge({ dir: dirFlag, port: server.port, packagePath, onEvent });
  const rel = dirFlag.startsWith(ROOT) ? dirFlag.slice(ROOT.length) : dirFlag;
  pspLine = `mailbox armed at ${rel} — launch the desktop host with this cwd (or POCKETJS_DBG_DIR) to attach`;
} else if (external) {
  bridge = startBridge({ dir: external.dir, port: server.port, packagePath, onEvent });
  const rel = external.dir.startsWith(ROOT) ? external.dir.slice(ROOT.length) : external.dir;
  pspLine = `external PSPLINK session (pid ${external.pid}, ${rel}) — relaunch the app there to attach`;
  if (app) status(yellow(`"${app}" ignored — your existing tools/psplink/hw session controls the device`));
} else if (app || packagePath) {
  if (app && !demoNames().includes(app.replace(/-main$/, ""))) {
    console.error(`unknown demo "${app}" — known: ${demoNames().join(", ")} (build one first: bun tools/build.ts <app>)`);
  }
  if (!(await buildApp())) process.exit(1);
  managed = await startUsbhostfs();
  // tools/psp.ts embeds the demo's compiled package; verify exactly that one.
  bridge = startBridge({ dir: targetDir, port: server.port, packagePath: packagePath ?? pspDemoPackage(app!), onEvent });
  pspLine = `waiting for the PSP on USB… launch PSPLINK on it (XMB → Game)`;
} else {
  const dir = join(ROOT, "dist", "psplink");
  bridge = startBridge({ dir, port: server.port, onEvent });
  const rel = dir.startsWith(ROOT) ? dir.slice(ROOT.length) : dir;
  pspLine = `no device — mailbox armed at ${rel} (bun psplink / bun run devtools <app> to launch)`;
}

const ready = Math.round(performance.now() - t0);
console.log();
console.log(`  ${bold("⚡ Pocket DevTools")} ${dim(`ready in ${ready} ms`)}`);
console.log();
console.log(arrow + bold("Panel:  ") + cyan(server.panelUrl));
console.log(arrow + bold("Demos:  ") + cyan(server.url));
console.log(arrow + bold("PSP:    ") + pspLine);
console.log();
console.log(dim(`  press ${bold("o")} open panel · ${bold("r")} rebuild + relaunch · ${bold("q")} quit`));
console.log();

function onEvent(e: { type: string; detail?: string }): void {
  if (e.type === "device-talking") status(green("device is talking — open the panel"));
  if (e.type === "hello") status(green(`app "${e.detail}" attached`));
  if (e.type === "screenshot") status(`screenshot served (${e.detail})`);
  if (e.type === "bundle-ok") status(green(`bundle verified — ${e.detail}`));
  if (e.type === "bundle-silent") status(yellow(`bundle unverified — ${e.detail}`));
  if (e.type === "bundle-mismatch")
    status(
      yellow(
        `*** STALE EMBED *** ${e.detail} — the device differs from the selected local build; rebuild + reload before trusting observations`,
      ),
    );
}

if (managed) {
  void (async () => {
    if (await waitForConnect(managed!, 0, 120000)) {
      status(green("PSP connected over USB"));
      await launchApp();
    } else {
      status(yellow("PSP never connected — check the USB DATA cable and PSPLINK on the device"));
    }
  })();
}

// ---- shortcuts + shutdown ------------------------------------------------------

let cleaned = false;
function cleanup(code = 0): void {
  if (cleaned) return;
  cleaned = true;
  bridge.stop();
  managed?.kill();
  server.stop();
  process.exit(code);
}
process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

if (tty && process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (key: Buffer) => {
    const k = key.toString();
    if (k === "q" || k === "\x03") cleanup(0);
    if (k === "o") void $`open ${server.panelUrl}`.nothrow().quiet();
    if (k === "r") {
      if (managed) {
        void (async () => {
          if (await buildApp()) await launchApp();
        })();
      } else {
        status(dim("relaunch is only managed with `bun run devtools <app>` — use your psplink session"));
      }
    }
    if (k === "h") {
      console.log(dim(`  o open panel · r rebuild + relaunch (managed sessions) · q quit`));
    }
  });
}
