// tools/tape.ts — headless time-travel CLI (docs/DEVTOOLS.md "the agent story").
// Replays an input tape deterministically against a demo bundle and answers
// debugging questions from the terminal: per-frame framebuffer hashes,
// first-divergent-frame regression checks, PNG renders of any frame, and
// the component tree as JSON at any frame — no screen, no hands needed.
//
//   bun tools/tape.ts record <app> --frames N [--input "f:mask,..."] --out t.json
//   bun tools/tape.ts replay <app> <tape.json> [--hashes out.json]
//   bun tools/tape.ts replay <app> <tape.json> --assert hashes.json
//   bun tools/tape.ts replay <app> <tape.json> --png 10,120 [--outdir dist/tape]
//   bun tools/tape.ts tree   <app> <tape.json> --at N
//
// A tape asserted against stored hashes is a SESSION GOLDEN: a real
// interaction sequence replayed byte-for-byte against every future build
// (same determinism contract as tests/golden.ts — fixed dt, no RNG/wall
// clock). `--assert` validates the golden schema before booting and exits 1
// on the first divergent frame; a missing, malformed, sparse, or partial
// golden exits 1 before booting as well — a broken assert never degrades
// into a partial or disabled check. A present but valueless `--assert`
// (no following path, an empty string, `--assert=`, or a flag where the
// path should be) is a command-line error and exits 1 before the tape is
// even read; omitting `--assert` entirely stays a plain, unchecked replay.
// `--assert` may appear at most once: every occurrence is scanned, so a
// valueless or second occurrence later in a composed command line is
// rejected too — the first valid value never wins by default.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import {
  expandTape,
  expandTapeAnalog,
  expandTapeRightAnalog,
  expandTapeTouch,
  expandTapeTouchSurfaces,
  expandTapeAxes,
  type Tape,
} from "../framework/src/devtools.ts";
import { EMPTY_AXIS_DELTAS, type AxisDelta } from "../framework/src/relative-axis.ts";
import { __packTouch } from "../framework/src/touch.ts";
import { encodePNG } from "./png.ts";
import { SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Tape replays must not consume the shared dist/ directory: target builds and
// other demos may leave a valid-looking but incompatible JS/pak pair there.
// Each invocation rebuilds serially into this dedicated runtime directory.
const RUNTIME_DIST = join(ROOT, "dist/tape-runtime/");
const CAPTURE_DIST = join(ROOT, "dist/tape");
const WASM_PATH = join(ROOT, "hosts/web/pocketjs.wasm");

function ensureBuilt(path: string, cmd: string[]): void {
  if (existsSync(path)) return;
  console.log(`tape: ${path.slice(ROOT.length)} missing — running: ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(path)) {
    console.error(`tape: failed to produce ${path}`);
    process.exit(1);
  }
}

function buildApp(app: string): void {
  rmSync(RUNTIME_DIST, { recursive: true, force: true });
  mkdirSync(RUNTIME_DIST, { recursive: true });
  const output = RUNTIME_DIST + app + ".js";
  const cmd = [process.execPath, "tools/build.ts", app, `--outdir=${RUNTIME_DIST}`];
  console.log(`tape: rebuilding ${app}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(output)) {
    console.error(`tape: failed to produce ${output}`);
    process.exit(1);
  }
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---------------------------------------------------------------------------
// --assert option parsing (absent vs. present-but-valueless are distinct,
// and the flag may appear at most once)
// ---------------------------------------------------------------------------

export type AssertArg =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "duplicate"; readonly reason: string };

/**
 * Resolve every `--assert` occurrence in argv, accepting both
 * `--assert PATH` and `--assert=PATH`.
 *
 * - "absent" — the flag is not there: a plain replay, the historical
 *   no-golden behaviour.
 * - "value" — exactly one occurrence carrying a non-empty path that is not
 *   itself a flag.
 * - "missing" — an occurrence is present but its value is absent: it is the
 *   last token, it is an empty string (`--assert ""`, the classic empty-env-
 *   var expansion), it is `--assert=`, or the next token starts with `--`.
 *   That is a command-line mistake, never a disabled assertion.
 * - "duplicate" — two or more occurrences carry values: which golden wins
 *   must not be an accident of argv order, so the command is rejected.
 *
 * The whole argv is scanned. A malformed occurrence short-circuits immediately
 * (it is the first such occurrence in argv order, and nothing later can
 * outrank it); valid occurrences are collected, so a valueless or second
 * occurrence after a valid one is rejected instead of being ignored.
 * Callers exit non-zero before reading the tape, building, or booting.
 *
 * A lone "-" or any other value is treated as a literal path; a path that
 * starts with "--" can be passed with the attached form `--assert=--path`.
 */
export function parseAssertArg(argv: readonly string[]): AssertArg {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--assert") {
      const next = argv[i + 1];
      if (next === undefined) {
        return {
          kind: "missing",
          reason:
            "--assert requires a golden hashes file path, but no value follows it " +
            "(--assert is the last argument)",
        };
      }
      if (next === "") {
        return {
          kind: "missing",
          reason:
            "--assert requires a golden hashes file path, but got an empty string " +
            "(did an empty variable expand into --assert \"\"?)",
        };
      }
      if (next.startsWith("--")) {
        return {
          kind: "missing",
          reason:
            `--assert requires a golden hashes file path, but the next argument is the flag "${next}" ` +
            "(use --assert=<path> if the path itself starts with --)",
        };
      }
      values.push(next);
      i++; // the value token is consumed, not rescanned as an option
      continue;
    }
    if (token.startsWith("--assert=")) {
      const value = token.slice("--assert=".length);
      if (value === "") {
        return {
          kind: "missing",
          reason: "--assert requires a golden hashes file path, but got an empty value (--assert=)",
        };
      }
      values.push(value);
    }
  }
  if (values.length === 0) return { kind: "absent" };
  if (values.length === 1) return { kind: "value", value: values[0] };
  return {
    kind: "duplicate",
    reason:
      `--assert may be given at most once, but it appeared ${values.length} times with paths ` +
      values.map((v) => JSON.stringify(v)).join(", "),
  };
}

/** FNV-1a 32-bit over the RGBA framebuffer — cheap, deterministic, hex. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface BootResult {
  frame: (
    buttons: number,
    analog?: number,
    touches?: readonly number[],
    hits?: readonly number[],
    touchSurfaces?: readonly number[],
    rightAnalog?: number,
    axisDeltas?: readonly AxisDelta[],
  ) => void;
  tick: () => void;
  render: () => Uint8Array;
  outbox: string[];
  pushCommand: (line: string) => void;
}

/** Boot a fresh core + bundle exactly like tests/golden.ts, plus an
 *  in-process DevTools transport — this CLI is just a DevTools client. */
async function boot(app: string): Promise<BootResult> {
  ensureBuilt(WASM_PATH, [process.execPath, "tools/wasm.ts"]);
  buildApp(app);
  const wasm = await createWasmUi(await Bun.file(WASM_PATH).arrayBuffer());
  const g = globalThis as Record<string, unknown>;
  const inbox: string[] = [];
  const outbox: string[] = [];
  g.ui = wasm.ops;
  g.__pak = existsSync(RUNTIME_DIST + app + ".pak")
    ? await Bun.file(RUNTIME_DIST + app + ".pak").arrayBuffer()
    : undefined;
  g.frame = undefined;
  g.__pocketApp = app;
  g.__pocketDevtoolsTransport = {
    send: (line: string) => outbox.push(line),
    recv: () => (inbox.length ? inbox.shift() : null),
  };
  const src = await Bun.file(RUNTIME_DIST + app + ".js").text();
  (0, eval)(src);
  const frame = g.frame as BootResult["frame"] | undefined;
  if (typeof frame !== "function") {
    throw new Error("bundle did not install globalThis.frame (does the entry call render()?)");
  }
  return {
    frame,
    tick: wasm.tick,
    render: () => wasm.render(),
    outbox,
    pushCommand: (line: string) => inbox.push(line),
  };
}

function loadTape(path: string): Tape {
  if (!existsSync(path)) {
    console.error(`tape: ${path} not found`);
    process.exit(1);
  }
  const tape = JSON.parse(readFileSync(path, "utf8")) as Tape;
  if (!Array.isArray(tape.masks)) {
    console.error(`tape: ${path} is not a tape (expected {v:1, masks:[[mask,count],…]})`);
    process.exit(1);
  }
  if ((tape.startFrame ?? 0) > 0) {
    console.warn(
      `tape: WARNING — startFrame=${tape.startFrame}: the recorder ring wrapped, ` +
        "so this tape does not start at boot; replay is an approximation",
    );
  }
  return tape;
}

// ---------------------------------------------------------------------------
// --assert golden schema (fail closed)
// ---------------------------------------------------------------------------

/** fnv1a frame hashes are 8 lowercase hex chars. */
const FRAME_HASH_RE = /^[0-9a-f]{8}$/;

/**
 * Validate an `--assert` golden document and return its dense hash list.
 *
 * A golden written by `replay --hashes` is `{app, frames, hashes}`. Every
 * structural defect throws an Error whose message names `path`; the CLI maps
 * that to exit 1 before booting. Checks: plain-object root, `app` equal to
 * the replayed app, integer `frames` equal to the array length, `hashes` a
 * real (Array.isArray) dense array whose length equals the frames the tape
 * expands to, every entry an 8-char lowercase hex string.
 */
export function parseAssertHashes(
  doc: unknown,
  path: string,
  app: string,
  frameCount: number,
): string[] {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    const kind = doc === null ? "null" : Array.isArray(doc) ? "array" : typeof doc;
    throw new Error(`${path}: assert root must be an object {app, frames, hashes} (got ${kind})`);
  }
  // A real plain JSON object: JSON.parse only produces Object.prototype roots.
  // A class instance (Date, Map, …) carrying lookalike fields is not a golden.
  const proto = Object.getPrototypeOf(doc);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `${path}: assert root must be an object {app, frames, hashes} ` +
        "(got an object with a non-standard prototype)",
    );
  }
  const root = doc as Record<string, unknown>;
  if (typeof root.app !== "string") {
    throw new Error(`${path}: assert golden must set string field "app"`);
  }
  if (root.app !== app) {
    throw new Error(`${path}: golden app "${root.app}" does not match replayed app "${app}"`);
  }
  if (typeof root.frames !== "number" || !Number.isSafeInteger(root.frames) || root.frames < 0) {
    throw new Error(`${path}: assert golden must set non-negative integer field "frames"`);
  }
  if (!Object.hasOwn(root, "hashes")) {
    throw new Error(`${path}: assert golden is missing field "hashes"`);
  }
  const rawHashes = root.hashes;
  if (!Array.isArray(rawHashes)) {
    const kind = rawHashes === null ? "null" : typeof rawHashes;
    throw new Error(`${path}: "hashes" must be an array of 8-char hex frame hashes (got ${kind})`);
  }
  if (rawHashes.length !== frameCount) {
    throw new Error(
      `${path}: hashes length ${rawHashes.length} does not match the ${frameCount} frames this tape replays`,
    );
  }
  if (root.frames !== rawHashes.length) {
    throw new Error(`${path}: field "frames" is ${root.frames} but hashes.length is ${rawHashes.length}`);
  }
  const hashes: string[] = [];
  for (let i = 0; i < rawHashes.length; i++) {
    if (!Object.hasOwn(rawHashes, i)) {
      throw new Error(`${path}: "hashes" is sparse: no hash at index ${i}`);
    }
    const entry = rawHashes[i];
    if (typeof entry !== "string" || !FRAME_HASH_RE.test(entry)) {
      throw new Error(
        `${path}: hashes[${i}] is not an 8-char lowercase hex string (got ${JSON.stringify(entry)})`,
      );
    }
    hashes.push(entry);
  }
  return hashes;
}

/** Read and validate the `--assert` golden; any defect exits 1, never throws. */
function loadAssertHashes(path: string, app: string, frameCount: number): string[] {
  const fail = (message: string): never => {
    console.error(`tape: ${message}`);
    process.exit(1);
  };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return fail(`cannot read --assert file ${path}: ${(err as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return fail(`${path}: invalid JSON: ${(err as Error).message}`);
  }
  try {
    return parseAssertHashes(doc, path, app, frameCount);
  } catch (err) {
    return fail((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdReplay(app: string, tapePathArg: string): Promise<void> {
  // Parse --assert before touching the tape, the build, or the replay: a
  // present-but-valueless flag (typo, empty env expansion) or a repeated flag
  // is a command-line error, and the assertion request must never degrade
  // into no assertions or a first-wins guess.
  const assertArg = parseAssertArg(process.argv);
  if (assertArg.kind === "missing" || assertArg.kind === "duplicate") {
    console.error(`tape: ${assertArg.reason}`);
    console.error("usage: bun tools/tape.ts replay <app> <tape.json> --assert <hashes.json>");
    process.exit(1);
  }
  const assertPath = assertArg.kind === "value" ? assertArg.value : undefined;
  const tape = loadTape(tapePathArg);
  const masks = expandTape(tape);
  const analogs = expandTapeAnalog(tape);
  const rightAnalogs = expandTapeRightAnalog(tape);
  const touches = expandTapeTouch(tape);
  const touchSurfaces = expandTapeTouchSurfaces(tape);
  const axes = expandTapeAxes(tape);
  const hashesOut = argValue("--hashes");
  const pngFrames = new Set(
    (argValue("--png") ?? "").split(",").filter(Boolean).map((s) => Number(s)),
  );
  const outdir = argValue("--outdir") ?? CAPTURE_DIST;
  // Validate before booting: a malformed golden must fail without spending a
  // build, and the schema guarantees a dense string[] of the right length.
  const expected: string[] | null = assertPath
    ? loadAssertHashes(assertPath, app, masks.length)
    : null;

  const b = await boot(app);
  if (pngFrames.size) mkdirSync(outdir, { recursive: true });
  const hashes: string[] = [];
  for (let f = 0; f < masks.length; f++) {
    b.frame(masks[f], analogs[f], touches[f], undefined, touchSurfaces[f], rightAnalogs[f], axes[f] ?? EMPTY_AXIS_DELTAS);
    b.tick();
    const fb = b.render();
    const h = fnv1a(fb);
    hashes.push(h);
    if (expected && expected[f] !== h) {
      console.error(`tape: FIRST DIVERGENT FRAME ${f} — expected ${expected[f]}, got ${h}`);
      mkdirSync(outdir, { recursive: true });
      writeFileSync(`${outdir}/divergent.${f}.png`, encodePNG(fb.slice(), SCREEN_W, SCREEN_H));
      console.error(`tape: wrote ${outdir}/divergent.${f}.png`);
      process.exit(1);
    }
    if (pngFrames.has(f)) {
      writeFileSync(`${outdir}/${app}.${f}.png`, encodePNG(fb.slice(), SCREEN_W, SCREEN_H));
      console.log(`tape: wrote ${outdir}/${app}.${f}.png`);
    }
  }
  if (expected) {
    // Length equality was validated against masks.length before the loop.
    console.log(`tape: OK — ${hashes.length} frames match ${assertPath}`);
    return;
  }
  if (hashesOut) {
    writeFileSync(hashesOut, JSON.stringify({ app, frames: hashes.length, hashes }, null, 0) + "\n");
    console.log(`tape: wrote ${hashes.length} frame hashes to ${hashesOut}`);
  } else {
    console.log(`tape: replayed ${hashes.length} frames — final frame hash ${hashes[hashes.length - 1]}`);
  }
}

async function cmdTree(app: string, tapePathArg: string): Promise<void> {
  const tape = loadTape(tapePathArg);
  const masks = expandTape(tape);
  const analogs = expandTapeAnalog(tape);
  const rightAnalogs = expandTapeRightAnalog(tape);
  const touches = expandTapeTouch(tape);
  const touchSurfaces = expandTapeTouchSurfaces(tape);
  const axes = expandTapeAxes(tape);
  const at = Number(argValue("--at") ?? masks.length);
  const upTo = Math.min(at, masks.length);
  const b = await boot(app);
  for (let f = 0; f < upTo; f++) {
    b.frame(masks[f], analogs[f], touches[f], undefined, touchSurfaces[f], rightAnalogs[f], axes[f] ?? EMPTY_AXIS_DELTAS);
    b.tick();
  }
  b.outbox.length = 0;
  b.pushCommand(JSON.stringify({ t: "getTree" }));
  b.frame(0, undefined, undefined, undefined, undefined, undefined, EMPTY_AXIS_DELTAS); // poll runs at wrapper start: tree reflects state after frame `at`
  for (const line of b.outbox) {
    const msg = JSON.parse(line);
    if (msg.t === "tree") {
      console.log(JSON.stringify(msg.root, null, 2));
      return;
    }
  }
  console.error("tape: no tree response (bundle built before DevTools?)");
  process.exit(1);
}

async function cmdRecord(app: string): Promise<void> {
  const frames = Number(argValue("--frames") ?? 300);
  const out = argValue("--out") ?? `${app}.tape.json`;
  // e2e-style input script: "frame:mask,frame:mask" — mask holds until the
  // next scripted frame releases/changes it? No: a pulse model matches
  // tests/golden.ts input closures better; each entry sets THAT frame's mask.
  const script = new Map<number, number>();
  for (const pair of (argValue("--input") ?? "").split(",").filter(Boolean)) {
    const [f, m] = pair.split(":");
    script.set(Number(f), Number(m));
  }
  const masks: [number, number][] = [];
  for (let f = 0; f < frames; f++) {
    const m = script.get(f) ?? 0;
    const last = masks[masks.length - 1];
    if (last && last[0] === m) last[1]++;
    else masks.push([m, 1]);
  }
  const tape: Tape = { v: 1, app, frames, masks, startFrame: 0 };
  // Touch script (level-triggered): "frame:id,x,y[+id,x,y…]" entries joined
  // by ';', "frame:-" releases. e.g. --touch "12:0,240,136;20:-"
  const touchArg = argValue("--touch");
  if (touchArg) {
    const events: { f: number; contacts: number[] }[] = [];
    for (const entry of touchArg.split(";").filter(Boolean)) {
      const [fStr, spec] = entry.split(":");
      const contacts =
        spec === "-"
          ? []
          : spec.split("+").map((triple) => {
              const [id, x, y] = triple.split(",").map(Number);
              return __packTouch(id, x, y);
            });
      events.push({ f: Number(fStr), contacts });
    }
    events.sort((a, b) => a.f - b.f);
    const touch: [number, number[]][] = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i].contacts.length === 0) continue;
      const end = Math.min(i + 1 < events.length ? events[i + 1].f : frames, frames);
      for (let f = events[i].f; f < end; f++) touch.push([f, events[i].contacts]);
    }
    if (touch.length > 0) {
      tape.v = 2;
      tape.touch = touch;
    }
  }
  writeFileSync(out, JSON.stringify(tape) + "\n");
  console.log(`tape: wrote ${out} (${frames} frames)`);
}

// ---------------------------------------------------------------------------
// CLI entry (guarded so tests can import the validator without replaying)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , cmd, app, tapePathArg] = process.argv;
  if (cmd === "replay" && app && tapePathArg) await cmdReplay(app, tapePathArg);
  else if (cmd === "tree" && app && tapePathArg) await cmdTree(app, tapePathArg);
  else if (cmd === "record" && app) await cmdRecord(app);
  else {
    console.log(
      "usage:\n" +
        '  bun tools/tape.ts record <app> --frames N [--input "f:mask,..."] [--touch "f:id,x,y;f:-"] --out t.json\n' +
        "  bun tools/tape.ts replay <app> <tape.json> [--hashes out.json | --assert hashes.json | --png f1,f2 [--outdir d]]\n" +
        "  bun tools/tape.ts tree   <app> <tape.json> --at N",
    );
    process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.main) await main();
