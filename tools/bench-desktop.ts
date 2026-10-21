// bun tools/bench-desktop.ts — the desktop markdown-editor benchmark:
// the pocket note on the gpui host (programs/desktop, docs/BACKENDS.md) against
// byte-identical web editors shelled by Tauri v2 (WKWebView) and Electron
// (tools/bench-desktop/). Protocol follows the pocket-character measurement
// (site/content/blog/pocket-character.md): same machine, hands off, process
// TREE medians from `ps` samples, `footprint` for physical memory, CPU as
// percent of one core.
//
//   bun tools/bench-desktop.ts                 # full run (~2.5 min/app)
//   bun tools/bench-desktop.ts --quick         # 15 s idle, 10 s storm
//   bun tools/bench-desktop.ts --apps=pocket,tauri
//
// Prereqs (the runner builds what's missing):
//   bun run macos note (once) — dist assets + the release host
//   cd tools/bench-desktop/electron && bun install
//   cd tools/bench-desktop/tauri/src-tauri && cargo build --release
//
// Phases per app, timed from the app's own first-painted-frame READY line:
//   cold start   spawn -> READY, 3 extra runs, median
//   idle         no input for IDLE s, sampled every 5 s
//   storm        CPS chars/s typed for DUR s through each app's real edit
//                path (svc lines / execCommand), sampled every 1 s
//
// Results: docs/bench/gpui-vs-tauri-electron-<date>.{json,md}. Fairness
// caveats live in the md — read them before quoting numbers.
import { existsSync, mkdirSync } from "node:fs";
import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (name: string, def: number) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : def;
};
const quick = argv.includes("--quick");
const IDLE_S = flag("idle", quick ? 15 : 60);
const STORM_S = flag("storm-dur", quick ? 10 : 30);
const CPS = flag("cps", 120);
const COLD_RUNS = quick ? 1 : 3;
const APPS = (argv.find((a) => a.startsWith("--apps="))?.split("=")[1] ?? "pocket,tauri,electron")
  .split(",");

const PORT = 45077;
// Settle after READY before idle sampling: `ps pcpu` is a decaying average
// (over up to a minute), so sampling right after boot carries launch work
// into the idle medians for every app. 20 s lets the decay flush.
const PRE_S = 20;
const STORM_START_S = PRE_S + IDLE_S + 3;
const END_S = STORM_START_S + STORM_S + 3;

interface Sample {
  t: number;
  rssKb: number;
  cpuPct: number;
  procs: number;
}

interface AppResult {
  name: string;
  coldStartMs: number[];
  idle: Sample[];
  storm: Sample[];
  footprintMb: number | null;
  diskMb: number;
  procs: number;
  stormDone?: string;
}

// ---------------------------------------------------------------------------
// process-tree sampling
// ---------------------------------------------------------------------------

async function psSnapshot(): Promise<Map<number, { ppid: number; rss: number; cpu: number }>> {
  const out = await $`ps -axo pid=,ppid=,rss=,pcpu=`.quiet().text();
  const map = new Map<number, { ppid: number; rss: number; cpu: number }>();
  for (const line of out.split("\n")) {
    const [pid, ppid, rss, cpu] = line.trim().split(/\s+/).map(Number);
    if (pid) map.set(pid, { ppid, rss, cpu });
  }
  return map;
}

function treePids(snapshot: Map<number, { ppid: number }>, rootPid: number): number[] {
  const pids = [rootPid];
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, { ppid }] of snapshot) {
      if (pids.includes(ppid) && !pids.includes(pid)) {
        pids.push(pid);
        grew = true;
      }
    }
  }
  return pids;
}

/// WKWebView work lives in com.apple.WebKit.* XPC processes whose parent is
/// launchd, not the app — attribute any that appeared after the app spawned
/// (one app is measured at a time).
async function webkitPids(): Promise<number[]> {
  const out = await $`pgrep -f com.apple.WebKit`.quiet().nothrow().text();
  return out.split("\n").map(Number).filter(Boolean);
}

async function sampleTree(rootPid: number, aux: number[] = []): Promise<Sample> {
  const snap = await psSnapshot();
  const pids = [...new Set([...treePids(snap, rootPid), ...aux])];
  let rssKb = 0;
  let cpuPct = 0;
  for (const pid of pids) {
    const p = snap.get(pid);
    if (p) {
      rssKb += (p as any).rss;
      cpuPct += (p as any).cpu;
    }
  }
  return { t: Date.now(), rssKb, cpuPct, procs: pids.length };
}

async function footprintMb(rootPid: number, aux: number[] = []): Promise<number | null> {
  try {
    const snap = await psSnapshot();
    const pids = [...new Set([...treePids(snap, rootPid), ...aux])];
    const out = await $`footprint ${pids.map(String)}`.quiet().nothrow().text();
    // Sum every "N KB/MB/GB" phys-footprint total line, one per process.
    let totalMb = 0;
    for (const m of out.matchAll(/phys_footprint:\s+([\d.]+)\s*(KB|MB|GB)/gi)) {
      const v = Number(m[1]);
      totalMb += m[2].toUpperCase() === "GB" ? v * 1024 : m[2].toUpperCase() === "KB" ? v / 1024 : v;
    }
    return totalMb > 0 ? Math.round(totalMb) : null;
  } catch {
    return null;
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// app launchers
// ---------------------------------------------------------------------------

interface Launcher {
  name: string;
  cmd: string[];
  env?: Record<string, string>;
  disk: () => Promise<number>;
}

const pocketBin = `${root}target/release/pocket-desktop-host`;
const electronDir = `${root}tools/bench-desktop/electron`;
const electronBin = `${electronDir}/node_modules/.bin/electron`;
const tauriBin = `${root}tools/bench-desktop/tauri/src-tauri/target/release/bench-tauri`;

async function duMb(path: string): Promise<number> {
  const out = await $`du -sk ${path}`.quiet().nothrow().text();
  return Math.round(Number(out.split(/\s+/)[0] || 0) / 1024);
}

function launchers(storm: boolean): Launcher[] {
  const stormTicks = STORM_S * 60;
  const stormStartTick = STORM_START_S * 60;
  const webQuery = `port=${PORT}` + (storm
    ? `&storm=${CPS}&start=${STORM_START_S * 1000}&dur=${STORM_S * 1000}`
    : "");
  const all: Launcher[] = [
    {
      name: "pocket",
      cmd: [
        pocketBin,
        "--app", "note-main",
        "--viewport", "420x560",
        "--density", "2",
        "--native-text",
        "--editor",
        "--title", "Pocket Note",
        // The pencil toggle puts the note into edit mode, like the web
        // editors' contenteditable surface. READY is opt-in on the host.
        "--announce-ready",
        "--click", "350,15@10",
        ...(storm ? ["--storm", `${CPS}@${stormStartTick}+${stormTicks}`] : []),
      ],
      env: { POCKETJS_DIST: `${root}dist`, RUST_LOG: "warn" },
      disk: async () =>
        (await duMb(pocketBin)) +
        (await duMb(`${root}dist/note-main.js`)) +
        (await duMb(`${root}dist/note-main.pak`)),
    },
    {
      name: "tauri",
      cmd: [tauriBin],
      env: { BENCH_QUERY: webQuery },
      disk: async () =>
        (await duMb(tauriBin)) + (await duMb(`${root}tools/bench-desktop/shared/editor.html`)),
    },
    {
      name: "electron",
      cmd: [electronBin, electronDir, `--query=${webQuery}`],
      disk: async () =>
        (await duMb(`${electronDir}/node_modules/electron/dist`)) +
        (await duMb(`${root}tools/bench-desktop/shared/editor.html`)),
    },
  ];
  return all.filter((l) => APPS.includes(l.name));
}

function spawnApp(l: Launcher) {
  const proc = Bun.spawn(l.cmd, {
    env: { ...process.env, ...l.env },
    stdout: "pipe",
    stderr: "ignore",
  });
  return proc;
}

// The report listener: the web shells POST READY/STORM-DONE lines here
// (see shared/editor.html report()); the pocket host prints them on stdout.
const reported: string[] = [];
Bun.serve({
  port: PORT,
  async fetch(req) {
    reported.push(await req.text());
    return new Response("ok");
  },
});

/** Wait for the app's READY line (stdout for pocket, HTTP for the shells). */
async function awaitReady(proc: Bun.Subprocess, viaHttp: boolean, timeoutMs = 60000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  if (viaHttp) {
    reported.length = 0;
    while (Date.now() < deadline) {
      const hit = reported.find((l) => l.startsWith("READY"));
      if (hit) return Number(hit.split(" ")[1]);
      await sleep(50);
    }
    throw new Error("timed out waiting for READY (http)");
  }
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const m = buf.match(/READY (\d+)/);
    if (m) {
      reader.releaseLock();
      // Keep draining in the background so the pipe never blocks the app.
      (async () => {
        for await (const _ of proc.stdout as ReadableStream<Uint8Array>) {
          // discard
        }
      })().catch(() => {});
      return Number(m[1]);
    }
  }
  throw new Error("timed out waiting for READY (stdout)");
}

async function killTree(rootPid: number) {
  const snap = await psSnapshot();
  for (const pid of treePids(snap, rootPid).reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function benchApp(l: Launcher): Promise<AppResult> {
  console.log(`\n=== ${l.name} ===`);
  const viaHttp = l.name !== "pocket";
  // Warmup spawn (not recorded): first launch of a fresh binary pays the
  // one-time Gatekeeper/XProtect scan, which is not cold-start cost.
  {
    const cold = launchers(false).find((x) => x.name === l.name)!;
    const proc = spawnApp(cold);
    await awaitReady(proc, viaHttp);
    await killTree(proc.pid);
    await sleep(1000);
  }
  // Cold starts (no storm, killed right after READY).
  const coldStartMs: number[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const t0 = Date.now();
    const cold = launchers(false).find((x) => x.name === l.name)!;
    const proc = spawnApp(cold);
    const ready = await awaitReady(proc, viaHttp);
    coldStartMs.push(ready - t0);
    await killTree(proc.pid);
    await sleep(1000);
  }
  console.log(`cold start: ${coldStartMs.join(", ")} ms`);

  // The measured run: idle then storm. WebKit XPC processes that appear
  // after the spawn belong to this app (Tauri's WKWebView helpers).
  const webkitBaseline = new Set(await webkitPids());
  const t0 = Date.now();
  const proc = spawnApp(l);
  await awaitReady(proc, viaHttp);
  const aux = async () => (await webkitPids()).filter((p) => !webkitBaseline.has(p));
  const idle: Sample[] = [];
  const storm: Sample[] = [];
  let fp: number | null = null;
  await sleep(PRE_S * 1000);
  const idleEnd = t0 + (PRE_S + IDLE_S) * 1000;
  while (Date.now() < idleEnd) {
    idle.push(await sampleTree(proc.pid, await aux()));
    if (idle.length === Math.floor(IDLE_S / 10)) fp = await footprintMb(proc.pid, await aux());
    await sleep(5000);
  }
  if (fp === null) fp = await footprintMb(proc.pid, await aux());
  const stormStart = t0 + STORM_START_S * 1000;
  await sleep(Math.max(0, stormStart - Date.now()));
  const stormEnd = stormStart + STORM_S * 1000;
  while (Date.now() < stormEnd) {
    storm.push(await sampleTree(proc.pid, await aux()));
    await sleep(1000);
  }
  await sleep((END_S * 1000 + t0) - Date.now() > 0 ? (END_S * 1000 + t0) - Date.now() : 0);
  const procs = Math.max(...idle.map((s) => s.procs), 0);
  // The web page reports STORM-DONE <inserted>; the pocket host's storm is
  // tick-driven (exact by construction), so absence there is fine.
  const stormDone = reported.find((r) => r.startsWith("STORM-DONE"));
  if (viaHttp && !stormDone) console.warn(`${l.name}: no STORM-DONE report`);
  await killTree(proc.pid);
  return {
    name: l.name,
    coldStartMs,
    idle,
    storm,
    footprintMb: fp,
    diskMb: await l.disk(),
    procs,
    stormDone,
  };
}

// Preflight: everything must exist (the runner builds nothing implicitly —
// keep the measured binaries the ones you built on purpose).
const missing: string[] = [];
if (APPS.includes("pocket") && !existsSync(pocketBin)) missing.push("bun run macos note (builds the host)");
if (APPS.includes("pocket") && !existsSync(`${root}dist/note-main.js`)) missing.push("bun run macos note (builds dist)");
if (APPS.includes("electron") && !existsSync(electronBin))
  missing.push("cd tools/bench-desktop/electron && bun install");
if (APPS.includes("tauri") && !existsSync(tauriBin))
  missing.push("cd tools/bench-desktop/tauri/src-tauri && cargo build --release");
if (missing.length) {
  console.error("bench-desktop: missing prerequisites:\n  " + missing.join("\n  "));
  process.exit(1);
}

// A locked session suspends WKWebView and throttles everything else —
// numbers taken there are fiction. Refuse to measure one.
const lockProbe = await $`swift -e ${
  'import CoreGraphics\nlet d = CGSessionCopyCurrentDictionary() as? [String: Any]\nprint(d?["CGSSessionScreenIsLocked"] ?? "unlocked")'
}`.quiet().nothrow().text();
if (lockProbe.includes("1")) {
  console.error("bench-desktop: the session is locked — unlock the Mac and rerun.");
  process.exit(1);
}
// Keep the display (and thus the session) awake for the whole run.
const caffeinate = Bun.spawn(["caffeinate", "-dimsu"], { stdout: "ignore", stderr: "ignore" });

const results: AppResult[] = [];
for (const l of launchers(true)) {
  results.push(await benchApp(l));
}
caffeinate.kill();

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const machine = (await $`sysctl -n machdep.cpu.brand_string`.quiet().nothrow().text()).trim();
const os = (await $`sw_vers -productVersion`.quiet().nothrow().text()).trim();

const summary = results.map((r) => ({
  name: r.name,
  coldStartMsMedian: median(r.coldStartMs),
  idleRssMb: Math.round(median(r.idle.map((s) => s.rssKb)) / 1024),
  idleCpuPct: Number(median(r.idle.map((s) => s.cpuPct)).toFixed(2)),
  stormCpuPct: Number(median(r.storm.map((s) => s.cpuPct)).toFixed(2)),
  stormRssMb: Math.round(median(r.storm.map((s) => s.rssKb)) / 1024),
  footprintMb: r.footprintMb,
  processes: r.procs,
  diskMb: r.diskMb,
}));

const json = {
  date,
  machine,
  os,
  protocol: {
    idleSeconds: IDLE_S,
    stormSeconds: STORM_S,
    charsPerSecond: CPS,
    coldRuns: COLD_RUNS,
    sampling: "ps -axo rss,pcpu over the process tree; idle every 5 s, storm every 1 s; medians",
  },
  summary,
  raw: results,
};

mkdirSync(`${root}docs/bench`, { recursive: true });
const base = `${root}docs/bench/gpui-vs-tauri-electron-${date}`;
await Bun.write(`${base}.json`, JSON.stringify(json, null, 2) + "\n");

const row = (r: (typeof summary)[number]) =>
  `| ${r.name} | ${r.processes} | ${r.coldStartMsMedian} | ${r.idleRssMb} | ${r.idleCpuPct} | ${r.stormCpuPct} | ${r.stormRssMb} | ${r.diskMb} |`;

const md = `# Desktop markdown editor: gpui backend vs Tauri vs Electron (${date})

The same editing workload on three stacks: the pocket note (an unmodified
PocketJS app) on the gpui \`macos-app\` host with native text layout, and one
byte-identical plain-text markdown editor page shelled by Tauri v2
(WKWebView) and Electron. **${machine}, macOS ${os}.** Protocol: cold start =
spawn to each app's own first-painted-frame READY report, median of
${COLD_RUNS}; idle = ${IDLE_S} s hands-off after a ${PRE_S} s
settle (pcpu is a decaying average — the settle flushes launch work), \`ps\`
process-tree samples every 5 s, medians; storm = ${CPS} chars/s typed for ${STORM_S} s through each
app's real edit path (svc lines / \`execCommand\`), sampled every 1 s. Reproduce:
\`bun tools/bench-desktop.ts\`.

| app | procs | cold start (ms) | idle RSS (MB) | idle CPU (%) | storm CPU (%) | storm RSS (MB) | disk (MB) |
|---|---|---|---|---|---|---|---|
${summary.map(row).join("\n")}

Fairness notes:

- The pocket note is a **richer** editor than the web page (markdown block
  styling, selection model, undo/redo, autosave debounce) — the web side
  edits a flat \`contenteditable\` with no markdown rendering. The gap
  measured here is stack floor, not app complexity.
- The web editors' storm inserts through \`document.execCommand\` on a
  contenteditable; the pocket storm crosses the svc channel and re-wraps the
  document through \`measureText\`. Both are the path real typing takes in
  that stack.
- Electron disk counts the whole framework under \`node_modules/electron/
  dist\`; Tauri reuses the system WKWebView, so its disk is just the binary —
  same convention for pocket (host binary + bundle + pak).
- CPU is \`ps pcpu\` (percent of one core, decaying average) summed over the
  process tree, WebKit XPC helpers attributed to Tauri by spawn-delta.
  \`footprint\` physical memory is collected into the json but omitted here:
  Electron's hardened helper processes refuse task inspection without
  elevated privileges, so tree totals are not comparable — RSS is the
  uniform metric.
- The pocket storm CPU RAMPS with document length (samples in the json):
  the note re-parses and re-wraps the whole growing document through the
  QuickJS interpreter on every keystroke — an app-level O(n) the web
  editors' native contenteditable machinery does not pay. The caret is a
  square wave demand rendering skips between edges (apps/note/
  pocket.json app.theme), so idle repaints are ~2/s, not 60.
`;

await Bun.write(`${base}.md`, md);
console.log(`\nwrote ${base}.{json,md}\n`);
console.log(md);
process.exit(0); // Bun.serve would keep the loop alive
