// Run a freshly compiled PocketJS demo on a REAL PSP over USB.
//
//   bun run hw              # build + run hero on the PSP
//   bun run hw cards        # build + run a specific demo
//   bun run hw stats -r     # release profile
//   bun run hw hero --trace # bake host0:/PocketJS-trace.txt logging
//   bun run hw --once       # build + load once, then exit
//   bun run hw --no-build   # skip the build, just load what's built
//
// It serves programs/psp/target/... as host0: through usbhostfs_pc, then ldstart's
// the raw PRX through PSPLINK. Each reload is reset + ldstart.
import { $ } from "bun";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";

const pspUiDir = new URL("..", import.meta.url).pathname;
const PRX = "host0:/pocketjs-psp.prx";
const MAIN_SUFFIX = "-main.tsx";

const argv = Bun.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const positional = argv.filter((a) => !a.startsWith("-"));
const release = flags.has("-r") || flags.has("--release");
const once = flags.has("--once");
const noBuild = flags.has("--no-build");
const trace = flags.has("--trace");
const profile = release ? "release" : "debug";

function listDemos(): string[] {
  const names = new Set<string>();
  for (const f of readdirSync(pspUiDir + "apps")) {
    const path = pspUiDir + "apps/" + f;
    if (statSync(path).isDirectory() && existsSync(path + "/main.tsx")) names.add(f);
    else if (f.endsWith(MAIN_SUFFIX)) names.add(f.slice(0, -MAIN_SUFFIX.length));
  }
  return [...names]
    .sort();
}

function resolveDemo(name?: string): string | null {
  if (!name) return null;
  const n = name.replace(/\.(tsx|ts|js)$/, "").replace(/-main$/, "");
  return listDemos().includes(n) ? n : null;
}

function usage(): void {
  console.log("Usage: bun run hw [demo] [-r|--release] [--trace] [--once] [--no-build]\n");
  console.log("Runs a PocketJS demo on a real PSP over USB (PSPLINK + usbhostfs).");
  console.log("Launch PSPLINK on the PSP from the XMB Game menu when prompted.\n");
  console.log("Demos: " + listDemos().join(", "));
}

if (flags.has("-h") || flags.has("--help")) {
  usage();
  process.exit(0);
}

const demo = resolveDemo(positional[0]) ?? "hero";
if (positional[0] && !resolveDemo(positional[0])) {
  console.error("unknown demo: " + positional[0]);
  usage();
  process.exit(1);
}

const usbhostfs = Bun.which("usbhostfs_pc");
const pspsh = Bun.which("pspsh");
if (!usbhostfs || !pspsh) {
  console.error("PSPLINK host tools not found on PATH (need usbhostfs_pc and pspsh).");
  process.exit(1);
}

const targetDir = pspUiDir + `programs/psp/target/mipsel-sony-psp/${profile}`;
const prxPath = targetDir + "/pocketjs-psp.prx";
const tracePath = targetDir + "/PocketJS-trace.txt";

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
  throw new Error("no free TCP port block found for the PSPLINK link");
}

async function build(): Promise<boolean> {
  if (noBuild) return existsSync(prxPath);
  const cargoArgs = release ? ["--release"] : [];
  console.log(`building ${demo} (${profile}${trace ? ", trace" : ""})...`);
  const res = await $`bun ${pspUiDir}tools/psp.ts ${demo} ${cargoArgs}`
    .env({ ...process.env, POCKETJS_TRACE: trace ? "1" : "" })
    .nothrow();
  if (res.exitCode !== 0 || !existsSync(prxPath)) {
    console.error("build failed - not reloading");
    return false;
  }
  return true;
}

let connectCount = 0;
async function pump(stream: ReadableStream<Uint8Array>): Promise<void> {
  const dec = new TextDecoder();
  for await (const chunk of stream) {
    const text = dec.decode(chunk);
    for (const _ of text.matchAll(/Connected to device/g)) connectCount++;
  }
}

async function waitForConnect(prev: number, timeoutMs = 20000): Promise<boolean> {
  const t0 = Date.now();
  while (connectCount <= prev) {
    if (Date.now() - t0 > timeoutMs) return false;
    await Bun.sleep(200);
  }
  return true;
}

async function waitForTraceComplete(timeoutMs = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 <= timeoutMs) {
    if (existsSync(tracePath)) {
      const text = readFileSync(tracePath, "utf8");
      if (text.includes("frame 0: complete")) return true;
      if (text.includes("[PocketJS halt]") || text.includes("[PocketJS js error]")) return false;
    }
    await Bun.sleep(100);
  }
  return false;
}

async function runPspsh(command: string, timeoutMs = 8000): Promise<{ text: string; timedOut: boolean }> {
  const child = Bun.spawn([pspsh, "-p", String(basePort), "-e", command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { text: (stdout + stderr).trim(), timedOut };
}

async function loadDemo(): Promise<boolean> {
  if (trace && existsSync(tracePath)) unlinkSync(tracePath);
  const prev = connectCount;
  process.stdout.write("resetting PSPLINK, waiting for USB reconnect... ");
  const reset = await runPspsh("reset");
  if (reset.timedOut) {
    const reconnected = await waitForConnect(prev, 2000);
    console.log(reconnected ? "connected." : "timeout; continuing with current PSPLINK session.");
  } else if (await waitForConnect(prev)) {
    console.log("connected.");
  } else {
    console.log("timeout; continuing with current PSPLINK session.");
  }
  const { text: out, timedOut } = await runPspsh("ldstart " + PRX);
  if (timedOut) {
    console.log("  ldstart timed out");
    return false;
  }
  console.log("  " + (out || "(no output)"));
  if (/Failed|Error/i.test(out)) {
    console.log("  load failed - check that PSPLINK is still running and host0: is mounted.");
    return false;
  }
  if (trace) {
    console.log("  trace: " + tracePath);
    const ok = await waitForTraceComplete();
    console.log(ok ? "  trace reached frame 0: complete" : "  trace did not reach frame 0: complete");
    return ok;
  }
  return true;
}

async function resetBackToPsplink(): Promise<void> {
  const prev = connectCount;
  process.stdout.write("resetting back to PSPLINK... ");
  const reset = await runPspsh("reset");
  if (reset.timedOut) {
    console.log("timeout.");
    return;
  }
  console.log((await waitForConnect(prev, 8000)) ? "connected." : "reset sent.");
}

const proc = { kill() {} } as { kill: () => void };
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  try {
    proc.kill();
  } catch {
    // already gone
  }
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

if (!(await build())) process.exit(1);

const basePort = await findBasePort(Number(process.env.PSP_HW_PORT ?? 10000));

const existing = (await $`pgrep -x usbhostfs_pc`.nothrow().text()).trim();
if (existing) {
  console.log(`note: another usbhostfs_pc is running (pid ${existing.split("\n").join(", ")}).`);
  console.log("      Only one can own the PSP's USB - kill it if this link does not connect.");
}

console.log(`serving ${targetDir.replace(pspUiDir, "")} as host0: on port ${basePort}`);
const child = Bun.spawn([usbhostfs, "-b", String(basePort), targetDir], { stdout: "pipe", stderr: "pipe" });
proc.kill = () => {
  child.kill();
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // already gone
  }
};
void pump(child.stdout);
void pump(child.stderr);

console.log("waiting for the PSP... launch PSPLINK on it (XMB -> Game -> PSPLINK).");
if (!(await waitForConnect(0, 120000))) {
  console.error("PSP never connected. Check the USB DATA cable and that PSPLINK is running.");
  cleanup();
  process.exit(1);
}
console.log("PSP connected.");

const loaded = await loadDemo();

if (once) {
  await resetBackToPsplink();
  cleanup();
  process.exit(loaded ? 0 : 1);
}

console.log("\n[PocketJS:hw] press Enter to rebuild + reload  |  q + Enter to quit\n");
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const cmd = line.trim().toLowerCase();
  if (cmd === "q" || cmd === "quit" || cmd === "exit") break;
  if (await build()) await loadDemo();
  console.log("\n[PocketJS:hw] press Enter to rebuild + reload  |  q + Enter to quit\n");
}
rl.close();
cleanup();
process.exit(0);
