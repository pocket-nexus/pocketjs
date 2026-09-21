/** Run an existing capture/bench EBOOT through official PPSSPP with no companion.
 * All mutable emulator files and reports remain in ignored validation output. */
import { accessSync, appendFileSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { encodePNG } from "../tests/png.ts";
import { bundleHash } from "./bundle-hash.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  headless: { type: "string" }, eboot: { type: "string" }, out: { type: "string" },
  timeout: { type: "string", default: "120" }, frames: { type: "string", default: "32" },
  cpu: { type: "string", default: "jit" },
  font: { type: "string" },
  family: { type: "string", default: "Inter" },
  log: { type: "boolean", default: false },
  js: { type: "string" }, pak: { type: "string" },
} });
if (!values.eboot) throw Error("Usage: bun tools/runtime-text-psp-smoke.ts --eboot EBOOT.PBP --headless PPSSPPHeadless [--js APP.js --pak APP.pak]");
const headless = resolve(values.headless ?? process.env.PPSSPP_HEADLESS ?? join(homedir(), "ppsspp-src/build/PPSSPPHeadless"));
accessSync(headless, constants.X_OK);
const output = resolve(values.out ?? `.pocket-build/validation/psp-runtime-fonts/run-${Date.now()}`);
const seconds = Number(values.timeout), expectedFrames = Number(values.frames);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600 || !Number.isInteger(expectedFrames) || expectedFrames < 1 || expectedFrames > 1000)
  throw Error("Invalid smoke capture limits");
if (!["jit", "interpreter", "ir"].includes(values.cpu!)) throw Error("Invalid emulator CPU mode");
if (existsSync(output)) throw Error(`Output already exists: ${output}`);
mkdirSync(output, { recursive: true });
const eboot = join(output, "EBOOT.PBP"); copyFileSync(resolve(values.eboot), eboot);
const box = join(output, "pocketjs-dbg"), input = join(box, "in.jsonl"), reply = join(box, "out.jsonl");
mkdirSync(box); writeFileSync(join(box, "enable"), "offline runtime font validation\n");
writeFileSync(input, ""); writeFileSync(reply, "");
const captures = join(homedir(), ".ppsspp/dc_cap"), original = join(output, "previous-captures");
mkdirSync(dirname(captures), { recursive: true });
if (existsSync(captures)) renameSync(captures, original);
const memstickFiles = ["PocketJS-bench.jsonl", "PocketJS-trace.txt"].map(name => ({
  path: join(homedir(), ".ppsspp", name), previous: join(output, `previous-${name}`), captured: join(output, `ms0-${name}`),
}));
for (const file of memstickFiles) if (existsSync(file.path)) renameSync(file.path, file.previous);
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fontSource = values.font ? resolve(values.font) : undefined;
const fontPath = fontSource ? `fonts/validation-${Date.now()}-${sha(fontSource).slice(0, 12)}.ttf` : undefined;
const diskFont = fontPath ? join(homedir(), ".ppsspp/PSP/COMMON/pocketjs", fontPath) : undefined;
if (diskFont) {
  if (existsSync(diskFont)) throw Error("Validation font already exists");
  mkdirSync(dirname(diskFont), { recursive: true }); copyFileSync(fontSource!, diskFont);
}
const events: any[] = [];
let prepared = false, completed = false, sentStats = false, cursor = 0;
// Observe reserved diagnostic requests without consuming framework replies.
// This code runs through the existing DevTools eval protocol between UI frames.
const inspect = `(() => {
  const channel = globalThis.offload && globalThis.offload.local;
  if (!channel) throw Error("PSP local worker is absent");
  const take = channel.take, pending = {};
  let id = 536870911;
  globalThis.__runtimeFontProbe = function (method, payload, label) {
    const ticket = ++id; pending[ticket] = label;
    if (!channel.submit(JSON.stringify({v:1,id:ticket,method,payload:JSON.stringify(payload)}))) {
      delete pending[ticket]; throw Error("Local diagnostic queue rejected request");
    }
  };
  globalThis.__runtimeFontProbe.dispose = function () { channel.take = take; delete globalThis.__runtimeFontProbe; };
  channel.take = function () {
    const raw = take();
    if (!raw) return raw;
    const value = JSON.parse(raw);
    const label = pending[value.id]; if (!label) return raw;
    delete pending[value.id];
    globalThis.ui.__dbgSend(JSON.stringify({ t: "runtimeFontProbe", label, session: channel.session(),
      data: value.payload ? JSON.parse(value.payload) : null, error: value.error,
      frame: globalThis.__pocketDevtools.frame, resources: JSON.parse(globalThis.ui.fontStreamStats()) }));
    return undefined;
  };
  globalThis.__runtimeFontProbe("runtime.stats", {}, "package-stats");
  return "local runtime diagnostic requested";
})()`;
const command = (message: unknown) => appendFileSync(input, JSON.stringify(message) + "\n");
const probe = (method: string, data: unknown, label: string) => command({ t: "eval", id: label,
  code: `globalThis.__runtimeFontProbe(${JSON.stringify(method)},${JSON.stringify(data)},${JSON.stringify(label)})` });
const rejectBudget = () => probe("runtime.budget", { bitmap: 128 * 1024 + 1 }, "over-budget");
const started = performance.now();
const child = Bun.spawn([headless, values.cpu === "ir" ? "--ir" : values.cpu === "interpreter" ? "-i" : "-j",
  ...(values.log ? ["--log"] : []),
  "--graphics=software", `--timeout=${seconds}`, "--root", output, eboot], {
  cwd: output, stdout: Bun.file(join(output, "ppsspp.stdout.log")), stderr: Bun.file(join(output, "ppsspp.stderr.log")),
});
const exited = child.exited.then(code => { completed = true; return code; });
const watchdog = setTimeout(() => child.kill(), (seconds + 10) * 1000);
let exitCode: number | undefined;
try {
  while (!completed) {
    const lines = readFileSync(reply, "utf8").split("\n");
    for (; cursor < lines.length - 1; cursor++) {
      const event = JSON.parse(lines[cursor]); events.push(event);
      if (event.t === "hello" && !prepared) {
        prepared = true; command({ t: "devStats" });
        command({ t: "eval", id: "runtime-core", code: "JSON.parse(ui.fontStreamStats()).runtime" });
      }
      if (event.t === "evalResult" && event.id === "runtime-core" && event.ok) {
        // Ask for worker statistics only once native glyph uploads exist.
        const resident = /resident:\s*(\d+)/.exec(event.value);
        if (resident && Number(resident[1]) > 0 && !sentStats) {
          sentStats = true; command({ t: "eval", id: "runtime-worker", code: inspect });
        } else if (!sentStats) command({ t: "eval", id: "runtime-core", code: "JSON.parse(ui.fontStreamStats()).runtime" });
      }
      if (event.t === "runtimeFontProbe") {
        if (event.label === "package-stats") probe("runtime.memory", {}, "package-memory");
        else if (event.label === "package-memory") {
          if (fontPath) probe("runtime.load", { path: fontPath }, "disk-load"); else rejectBudget();
        } else if (event.label === "disk-load" && !event.error) probe("runtime.font", { family: values.family, size: 20, fallback: [] }, "disk-font");
        else if (event.label === "disk-font" && !event.error) probe("runtime.prepare", { font: event.data.font, text: "AV ffi é", leaseKey: "psp-validation-disk" }, "disk-layout");
        else if (event.label === "disk-layout" && !event.error) {
          const glyph = event.data.inline?.glyphs?.[0]?.[0];
          if (glyph) probe("runtime.glyph", { glyph }, "disk-glyph"); else rejectBudget();
        } else if (event.label === "disk-glyph") probe("runtime.release", { key: "psp-validation-disk" }, "disk-release");
        else if (event.label === "disk-release" || event.label.startsWith("disk-") && event.error) rejectBudget();
        else if (event.label === "over-budget") probe("runtime.memory", {}, "after-refusal");
        else if (event.label === "after-refusal") {
          command({ t: "screenshot" }); command({ t: "eval", id: "probe-cleanup", code: "globalThis.__runtimeFontProbe.dispose()" });
        }
      }
    }
    await Bun.sleep(5);
  }
  exitCode = await exited;
} finally {
  clearTimeout(watchdog);
  if (!completed) { child.kill(); await exited; }
  if (existsSync(captures)) renameSync(captures, join(output, "frames"));
  if (existsSync(original)) renameSync(original, captures);
  for (const file of memstickFiles) {
    if (existsSync(file.path)) renameSync(file.path, file.captured);
    if (existsSync(file.previous)) renameSync(file.previous, file.path);
  }
  if (diskFont && existsSync(diskFont)) unlinkSync(diskFont);
}
// Include any last complete message appended before the PSP exited.
const finalLines = readFileSync(reply, "utf8").split("\n");
for (; cursor < finalLines.length - 1; cursor++) if (finalLines[cursor]) events.push(JSON.parse(finalLines[cursor]));
const rawFrames = existsSync(join(output, "frames")) ? readdirSync(join(output, "frames")).filter(name => /^f\d{4}\.raw$/.test(name)).sort() : [];
const convert = (rawPath: string, pngPath: string) => {
  const raw = readFileSync(rawPath);
  if (raw.length !== 512 * 272 * 4) throw Error(`Invalid PSP framebuffer: ${rawPath}`);
  const pixels = Buffer.alloc(480 * 272 * 4);
  for (let y = 0; y < 272; y++) raw.copy(pixels, y * 480 * 4, y * 512 * 4, y * 512 * 4 + 480 * 4);
  for (let at = 3; at < pixels.length; at += 4) pixels[at] = 255;
  writeFileSync(pngPath, encodePNG(pixels, 480, 272));
};
if (rawFrames.length) convert(join(output, "frames", rawFrames.at(-1)!), join(output, "last-frame.png"));
if (existsSync(join(box, "shot.raw"))) convert(join(box, "shot.raw"), join(output, "ready-frame.png"));
const resultOf = (label: string) => events.find(event => event.t === "runtimeFontProbe" && event.label === label);
const initial = resultOf("package-stats"), firstMemory = resultOf("package-memory"), finalMemory = resultOf("after-refusal");
const stats = initial ? { stats: initial.data, memory: finalMemory?.data ?? firstMemory?.data, resources: initial.resources } : undefined;
const device = events.find(event => event.t === "devStats")?.data;
const expectedBundle = values.js && values.pak ? bundleHash(resolve(values.js), resolve(values.pak)) : undefined;
const failures: string[] = [];
if (!prepared) failures.push("PSP app did not announce a DevTools session");
if (rawFrames.length !== expectedFrames) failures.push(`Captured ${rawFrames.length}/${expectedFrames} frames`);
if (!stats?.stats?.local || stats.stats.loadedPackageFonts < 1 || stats.stats.rasterizations < 1 || stats.resources?.runtime?.resident < 1)
  failures.push("No package-loaded local runtime font was rasterized and uploaded");
if (!stats?.memory || stats.memory.workerThreadId <= 0 || stats.memory.uiThreadId <= 0 || stats.memory.workerThreadId === stats.memory.uiThreadId)
  failures.push("No distinct worker/UI thread identities were verified");
if (!stats?.memory || stats.memory.used <= 0 || stats.memory.peak < stats.memory.used || stats.memory.peak > stats.memory.capacity)
  failures.push("No bounded worker heap residency was verified");
if (!resultOf("over-budget")?.error || !finalMemory?.data || finalMemory.data.frames <= resultOf("over-budget")?.frame)
  failures.push("Budget refusal did not return an error while UI frames continued");
if (fontSource && (!resultOf("disk-load")?.data?.loaded || resultOf("disk-glyph")?.data?.total < 1 || !resultOf("disk-glyph")?.data?.coverage))
  failures.push("Device filesystem TTF load, shaping and rasterization were not verified");
if (fontSource && resultOf("disk-glyph")?.data?.coverage && !Buffer.from(resultOf("disk-glyph").data.coverage, "base64").some(value => value > 0 && value < 255))
  failures.push("Rasterized TTF coverage did not contain grayscale edge values");
if (expectedBundle && device?.bundle !== expectedBundle) failures.push("PSP embedded bundle does not match the supplied JS/PAK");
const result = { ok: failures.length === 0, failures, exitCode, elapsedMs: performance.now() - started, frames: rawFrames.length,
  emulator: { path: headless, sha256: sha(headless), softwareRenderer: true, cpu: values.cpu },
  build: { ebootSha256: sha(eboot), expectedBundle, device },
  localRuntime: stats, probes: events.filter(event => event.t === "runtimeFontProbe"),
  filesystemFont: fontSource ? { source: fontSource, family: values.family, sha256: sha(fontSource), requestPath: fontPath, cleaned: !existsSync(diskFont!) } : undefined,
  companionStarted: false,
  note: "PPSSPP software-renderer validation; emulator timing is not device frame performance." };
writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
