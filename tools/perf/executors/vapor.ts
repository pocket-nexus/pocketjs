import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScenarioV1 } from "../core/types.ts";
import { scenarioPhaseId } from "../receipts/hash.ts";
import {
  GUEST_OUTPUT_PREFIX,
  parseGuestOutput,
  parseQemuOutput,
  QEMU_OUTPUT_PREFIX,
} from "../receipts/protocol.ts";
import type {
  GuestProtocolResult,
  QemuProtocolResult,
} from "../receipts/protocol.ts";
import type { NativeOkResult, NativeRunResult } from "../runner/native.ts";

type VaporExecutor = "native" | "qemu-armv7-thumb2" | "qemu-aarch64";
type VaporTargetName = "gba" | "playdate";

interface VaporGrid {
  readonly chars: readonly string[];
  readonly pals: readonly (readonly number[])[];
}

interface VaporNodeLike {
  readonly tag?: string;
  readonly text?: string;
  readonly attrs?: ReadonlyMap<string, string>;
  readonly children?: readonly VaporNodeLike[];
  readonly nodeType?: number;
}

interface CompiledVaporAppLike {
  readonly c: string;
  readonly styles: unknown;
  readonly debugSlots: readonly VaporDebugSlot[];
  readonly relativeAxesUsed: readonly number[];
  readonly buttonsUsed: readonly number[];
}

interface VaporDebugSlot {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly kind: "num" | "bool" | "str" | "listLen";
}

interface VaporOracleLike {
  readonly root: VaporNodeLike;
  press(button: number): Promise<void>;
  axisDelta(axis: number, delta: number): Promise<void>;
  grid(): VaporGrid;
  unmount(): void;
}

type VaporDebugValue = number | boolean | string;

interface VaporEvent {
  readonly frame: number;
  readonly kind: "button" | "relative-axis";
  readonly control: number;
  readonly value: number;
}

interface TargetProfile {
  readonly target: VaporTargetName;
  readonly width: number;
  readonly height: number;
  readonly poolCap: number;
  readonly strCap: number;
  readonly benchmarkEntry: string;
}

export interface RunVaporScenarioOptions {
  readonly scenario: ScenarioV1;
  readonly executor: VaporExecutor;
  readonly sourceRoot: string;
  readonly harnessRoot: string;
  readonly outDir?: string;
  readonly image?: string;
}

export interface RunNativeVaporScenarioOptions {
  readonly sourceRoot: string;
  readonly harnessRoot: string;
  readonly outDir?: string;
}

export interface VaporInvalidResult {
  readonly status: "invalid";
  readonly executor: VaporExecutor;
  readonly reasons: readonly string[];
  readonly combinedOutput?: string;
}

export interface VaporNativeResult {
  readonly status: "ok";
  readonly executor: "native";
  /** SHA-256 over every canonical oracle grid in frame order. */
  readonly framebufferHash: string;
  /** SHA-256 of the final canonical oracle grid. */
  readonly finalFramebufferHash: string;
  /** FNV-1a-64 over final grid chars followed by palette bytes. */
  readonly finalDrawListHash: string;
  /** SHA-256 over the final real Vue Vapor micro-DOM. */
  readonly stateHash: string;
  /** SHA-256 over the hardware-neutral events actually delivered. */
  readonly effectHash: string;
  /** Guest-compatible state digest; the C lane uses app_debug_state instead. */
  readonly finalStateDigest: string;
  /** Guest-compatible app_debug_state digests at declared state checkpoints. */
  readonly checkpointStateDigests: Readonly<Record<string, string>>;
  /** Guest-compatible digest of delivered input/effect events. */
  readonly finalEffectDigest: string;
  readonly phaseDrawListHashes: Readonly<Record<string, string>>;
  readonly axisEventsDelivered: number;
  readonly axisEventsObserved: number;
  readonly compiledRelativeAxesUsed: readonly number[];
  readonly compiledButtonsUsed: readonly number[];
  readonly target: VaporTargetName;
  readonly width: number;
  readonly height: number;
}

export interface VaporQemuResult {
  readonly status: "ok";
  readonly executor: Exclude<VaporExecutor, "native">;
  /** Interleaved-protocol-compatible text consumed by createQemuReceipts. */
  readonly combinedOutput: string;
  /** Generated-C correctness presentation-buffer trace, after Vue oracle parity. */
  readonly framebufferHash: string;
  /** Native DOM hash retained for receipts only after generated-C debug-state parity succeeds. */
  readonly stateHash: string;
  readonly effectHash: string;
  readonly finalDrawListHash: string;
  readonly elfPath: string;
  readonly artifactMetrics: Readonly<{
    "artifact.elf_text_rodata_bytes": number;
  }>;
  readonly build: VaporQemuBuildSpec;
}

export type VaporScenarioResult = VaporInvalidResult | VaporNativeResult | VaporQemuResult;

export interface VaporQemuBuildSpec {
  readonly compiler: string;
  readonly emulator: string;
  readonly cpuArgs: readonly string[];
  readonly emulatorArgs: readonly string[];
  readonly qemuTarget: "arm" | "aarch64";
  readonly cFlags: readonly string[];
  readonly linkerFlags: readonly string[];
}

export const VAPOR_QEMU_BUILD_SPECS: Readonly<
  Record<Exclude<VaporExecutor, "native">, VaporQemuBuildSpec>
> = Object.freeze({
  "qemu-armv7-thumb2": Object.freeze({
    compiler: "arm-linux-gnueabihf-gcc",
    emulator: "/opt/qemu/bin/qemu-arm",
    cpuArgs: Object.freeze(["-cpu", "cortex-a9,neon=off,vfp-d32=off"]),
    emulatorArgs: Object.freeze(["-seed", "1"]),
    qemuTarget: "arm",
    cFlags: Object.freeze([
      "-std=c11",
      "-O2",
      "-g0",
      "-march=armv7-a",
      "-mthumb",
      "-mfpu=vfpv3-d16",
      "-mfloat-abi=hard",
      "-ffreestanding",
      "-fno-builtin",
      "-fno-ident",
      "-fno-stack-protector",
      "-fno-asynchronous-unwind-tables",
      "-fno-unwind-tables",
      "-Wall",
      "-Wextra",
      "-Werror",
    ]),
    linkerFlags: Object.freeze(["-nostdlib", "-static", "-Wl,-e,_start", "-Wl,--build-id=none", "-lgcc"]),
  }),
  "qemu-aarch64": Object.freeze({
    compiler: "aarch64-linux-gnu-gcc",
    emulator: "/opt/qemu/bin/qemu-aarch64",
    cpuArgs: Object.freeze(["-cpu", "cortex-a53"]),
    emulatorArgs: Object.freeze(["-seed", "1"]),
    qemuTarget: "aarch64",
    cFlags: Object.freeze([
      "-std=c11",
      "-O2",
      "-g0",
      "-march=armv8-a",
      "-ffreestanding",
      "-fno-builtin",
      "-fno-ident",
      "-fno-stack-protector",
      "-fno-asynchronous-unwind-tables",
      "-fno-unwind-tables",
      "-Wall",
      "-Wextra",
      "-Werror",
    ]),
    linkerFlags: Object.freeze(["-nostdlib", "-static", "-Wl,-e,_start", "-Wl,--build-id=none", "-lgcc"]),
  }),
});

const BUTTONS: Readonly<Record<string, number>> = Object.freeze({
  primary: 0,
  secondary: 1,
  select: 2,
  start: 3,
  right: 4,
  left: 5,
  up: 6,
  down: 7,
  "shoulder-right": 8,
  "shoulder-left": 9,
});

const RELATIVE_AXES: Readonly<Record<string, number>> = Object.freeze({
  primary: 0,
  secondary: 1,
});

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function invalid(
  executor: VaporExecutor,
  reasons: readonly string[],
  combinedOutput?: string,
): VaporInvalidResult {
  return { status: "invalid", executor, reasons: unique(reasons), ...(combinedOutput ? { combinedOutput } : {}) };
}

function validateScenario(scenario: ScenarioV1): string[] {
  const reasons: string[] = [];
  if (scenario.subject.family !== "vapor") {
    reasons.push(`Vapor adapter requires subject.family=vapor, got ${JSON.stringify(scenario.subject.family)}`);
  }
  if (scenario.subject.framework !== "core") {
    reasons.push(`Vapor generated-C receipts require subject.framework=core`);
  }
  if (scenario.frames !== scenario.tape.frames) {
    reasons.push(`scenario frames ${scenario.frames} do not match tape frames ${scenario.tape.frames}`);
  }
  if (!scenario.phases.some((phase) => phase.collect)) reasons.push("scenario has no collected phase");
  for (const track of scenario.tape.tracks) {
    if (track.kind !== "button" && track.kind !== "relative-axis") {
      reasons.push(`Vapor adapter does not support ${track.kind} track ${JSON.stringify("control" in track ? track.control : track.effect)}`);
    }
  }
  return reasons;
}

function profileForEntry(sourceRoot: string, entry: string): TargetProfile | null {
  const normalized = entry.replaceAll("\\", "/");
  if (normalized.endsWith("vapor/examples/todo/todo.tsx") ||
      normalized.endsWith("vapor/examples/todo/todo.playdate.tsx")) {
    return {
      target: "playdate",
      width: 50,
      height: 30,
      poolCap: 32,
      strCap: 24,
      benchmarkEntry: join(sourceRoot, "vapor/examples/todo/todo.playdate.tsx"),
    };
  }
  return null;
}

/**
 * The performance fixture stays derived from the real crank-driven Todo, but
 * adds one monotonic reactive row. The scenario's +44999,+1,-45000 tape ends
 * with zero net motion, so the normal cursor would return to its initial row;
 * this counter makes every RelativeAxis delivery observable at phase end.
 */
function benchmarkFixtureSource(profile: TargetProfile): string {
  let source = readFileSync(profile.benchmarkEntry, "utf8");
  const edits: readonly [string, string][] = [
    [
      "  const crankRemainder = ref(0);",
      "  const crankRemainder = ref(0);\n  const axisEvents = ref(0);",
    ],
    [
      "  onAxisDelta(RelativeAxis.Primary, (delta) => {\n",
      "  onAxisDelta(RelativeAxis.Primary, (delta) => {\n    axisEvents.value += 1;\n",
    ],
    [
      "      <HelpBar\n",
      "      <row y={SCREEN.height - 2} x={1} class=\"text-slate-500\">\n" +
        "        {\" AXIS EVENTS \"}\n" +
        "        {axisEvents.value}\n" +
        "      </row>\n" +
        "      <HelpBar\n",
    ],
  ];
  for (const [before, after] of edits) {
    if (!source.includes(before)) {
      throw new Error(`Vapor benchmark fixture anchor changed in ${profile.benchmarkEntry}: ${JSON.stringify(before)}`);
    }
    source = source.replace(before, after);
  }
  return source;
}

interface RawEvent {
  readonly frame: number;
  readonly track: number;
  readonly sample: number;
  readonly kind: "button-sample" | "relative-axis";
  readonly control: string;
  readonly value: number;
}

function buildEvents(scenario: ScenarioV1): { events: VaporEvent[]; reasons: string[] } {
  const raw: RawEvent[] = [];
  const reasons: string[] = [];
  scenario.tape.tracks.forEach((track, trackIndex) => {
    if (track.kind === "button") {
      if (BUTTONS[track.control] === undefined) {
        reasons.push(`Vapor has no button mapping for ${JSON.stringify(track.control)}`);
        return;
      }
      track.samples.forEach((sample, sampleIndex) => raw.push({
        frame: sample.frame,
        track: trackIndex,
        sample: sampleIndex,
        kind: "button-sample",
        control: track.control,
        value: sample.pressed ? 1 : 0,
      }));
    } else if (track.kind === "relative-axis") {
      const axis = RELATIVE_AXES[track.control];
      if (axis === undefined) {
        reasons.push(`Vapor has no relative-axis mapping for ${JSON.stringify(track.control)}`);
        return;
      }
      track.samples.forEach((sample, sampleIndex) => {
        if (!Number.isInteger(sample.delta) || sample.delta === 0 || sample.delta < -0x80000000 || sample.delta > 0x7fffffff) {
          reasons.push(
            `relative-axis ${JSON.stringify(track.control)} frame ${sample.frame} delta must be a non-zero signed 32-bit integer`,
          );
          return;
        }
        raw.push({
          frame: sample.frame,
          track: trackIndex,
          sample: sampleIndex,
          kind: "relative-axis",
          control: track.control,
          value: sample.delta,
        });
      });
    }
  });
  raw.sort((a, b) => a.frame - b.frame || a.track - b.track || a.sample - b.sample);
  const pressed = new Map<string, boolean>();
  const events: VaporEvent[] = [];
  for (const event of raw) {
    if (event.kind === "button-sample") {
      const wasPressed = pressed.get(event.control) ?? false;
      const isPressed = event.value === 1;
      pressed.set(event.control, isPressed);
      if (isPressed && !wasPressed) {
        events.push({ frame: event.frame, kind: "button", control: BUTTONS[event.control]!, value: 1 });
      }
    } else {
      events.push({
        frame: event.frame,
        kind: "relative-axis",
        control: RELATIVE_AXES[event.control]!,
        value: event.value,
      });
    }
  }
  return { events, reasons };
}

function fnvBytes(bytes: Iterable<number>, seed = FNV_OFFSET): bigint {
  let hash = seed;
  for (const byte of bytes) {
    hash ^= BigInt(byte & 0xff);
    hash = (hash * FNV_PRIME) & U64_MASK;
  }
  return hash;
}

function taggedFnv(hash: bigint): string {
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function gridBytes(grid: VaporGrid, width: number, height: number): Uint8Array<ArrayBuffer> {
  if (grid.chars.length !== height || grid.pals.length !== height) {
    throw new Error(`oracle grid geometry mismatch: expected ${width}x${height}`);
  }
  const bytes = new Uint8Array(width * height * 2);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const row = grid.chars[y]!;
    if (row.length !== width || grid.pals[y]!.length !== width) {
      throw new Error(`oracle grid row ${y} does not match width ${width}`);
    }
    for (let x = 0; x < width; x += 1) bytes[at++] = row.charCodeAt(x) & 0xff;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) bytes[at++] = grid.pals[y]![x]! & 0xff;
  }
  return bytes;
}

function observedAxisEvents(grid: VaporGrid, profile: TargetProfile): number {
  const line = grid.chars[profile.height - 2]?.trim() ?? "";
  const match = /^AXIS EVENTS (\d+)$/.exec(line);
  if (!match) throw new Error(`Vapor fixture axis row is missing or malformed: ${JSON.stringify(line)}`);
  return Number(match[1]);
}

function assertAxisEvents(
  grid: VaporGrid,
  profile: TargetProfile,
  events: readonly VaporEvent[],
): number {
  const expected = events.filter((event) => event.kind === "relative-axis").length;
  const observed = observedAxisEvents(grid, profile);
  if (observed !== expected) {
    throw new Error(`Vapor fixture observed ${observed} relative-axis events; expected ${expected}`);
  }
  return observed;
}

function eventBytes(events: readonly VaporEvent[]): Uint8Array {
  const bytes: number[] = [];
  const u32 = (value: number) => {
    const unsigned = value >>> 0;
    bytes.push(unsigned & 0xff, (unsigned >>> 8) & 0xff, (unsigned >>> 16) & 0xff, (unsigned >>> 24) & 0xff);
  };
  for (const event of events) {
    bytes.push(event.kind === "button" ? 1 : 2);
    u32(event.frame);
    bytes.push(event.control);
    if (event.kind === "relative-axis") u32(event.value);
  }
  return Uint8Array.from(bytes);
}

function canonicalNode(node: VaporNodeLike): unknown {
  if (node.nodeType === 3) return ["text", node.text ?? ""];
  if (node.nodeType === 8) return ["comment", node.text ?? ""];
  return [
    "element",
    node.tag ?? "",
    Object.fromEntries([...(node.attrs ?? new Map())].sort(([a], [b]) => a.localeCompare(b))),
    (node.children ?? []).map(canonicalNode),
  ];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function oracleStateFixtureSource(
  source: string,
  slots: readonly VaporDebugSlot[],
  hookName: string,
): string {
  const anchor = "\n  return (\n";
  const at = source.lastIndexOf(anchor);
  if (at < 0) throw new Error("Vapor benchmark fixture has no component return anchor");
  const values = slots.map((slot) => {
    const value = slot.kind === "listLen"
      ? `${slot.name}.value.length`
      : `${slot.name}.value`;
    return `    ${JSON.stringify(slot.name)}: ${value},`;
  }).join("\n");
  const hook = [
    "",
    `  (globalThis as Record<string, unknown>)[${JSON.stringify(hookName)}] = () => ({`,
    values,
    "  });",
  ].join("\n");
  return `${source.slice(0, at)}${hook}${source.slice(at)}`;
}

function debugStateBytes(
  slots: readonly VaporDebugSlot[],
  values: Readonly<Record<string, VaporDebugValue>>,
): Uint8Array {
  const bytes: number[] = [];
  const names = new Set(slots.map((slot) => slot.name));
  const unknown = Object.keys(values).filter((name) => !names.has(name));
  if (unknown.length > 0) {
    throw new Error(`Vapor oracle state hook returned unknown slots: ${unknown.join(", ")}`);
  }
  for (const slot of slots) {
    if (!Object.hasOwn(values, slot.name)) {
      throw new Error(`Vapor oracle state hook omitted ${slot.name}`);
    }
    const value = values[slot.name]!;
    if (slot.kind === "str") {
      if (typeof value !== "string") throw new Error(`Vapor state slot ${slot.name} is not a string`);
      if (value.length > slot.size - 1) {
        throw new Error(`Vapor state slot ${slot.name} exceeds its ${slot.size - 1}-byte capacity`);
      }
      bytes.push(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code > 0x7f) throw new Error(`Vapor state slot ${slot.name} is not ASCII`);
        bytes.push(code);
      }
      continue;
    }
    const normalized = slot.kind === "bool"
      ? value === true ? 1 : value === false ? 0 : value
      : value;
    if (typeof normalized !== "number" || !Number.isInteger(normalized) ||
        normalized < -0x80000000 || normalized > 0x7fffffff) {
      throw new Error(`Vapor state slot ${slot.name} is not a signed 32-bit integer`);
    }
    const unsigned = normalized >>> 0;
    bytes.push(
      unsigned & 0xff,
      (unsigned >>> 8) & 0xff,
      (unsigned >>> 16) & 0xff,
      (unsigned >>> 24) & 0xff,
    );
  }
  return Uint8Array.from(bytes);
}

async function withSourceDependencies<T>(
  sourceRoot: string,
  harnessRoot: string,
  body: () => Promise<T>,
): Promise<T> {
  const sourceModules = join(sourceRoot, "node_modules");
  const harnessModules = join(harnessRoot, "node_modules");
  let linked = false;
  if (!existsSync(sourceModules) && existsSync(harnessModules)) {
    symlinkSync(harnessModules, sourceModules, "dir");
    linked = true;
  }
  try {
    return await body();
  } finally {
    if (linked) unlinkSync(sourceModules);
  }
}

let oracleLeaseTail: Promise<void> = Promise.resolve();

async function acquireOracleLease(): Promise<() => void> {
  const previous = oracleLeaseTail;
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  oracleLeaseTail = previous.then(() => current);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
  };
}

interface OracleSession {
  readonly app: CompiledVaporAppLike;
  readonly oracle: VaporOracleLike;
  debugStateBytes(): Uint8Array;
  cleanup(): void;
}

function stageOracleModule(stageRoot: string, sourceRoot: string): string {
  const sourceUrl = pathToFileURL(join(sourceRoot, "vapor/oracle/boot.ts"));
  sourceUrl.searchParams.set("pocket-perf-stage", basename(stageRoot));
  const wrapperPath = join(stageRoot, "oracle-stage.ts");
  writeFileSync(
    wrapperPath,
    `export { bootOracle } from ${JSON.stringify(sourceUrl.href)};\n`,
  );
  return wrapperPath;
}

async function compileAndBoot(
  _scenario: ScenarioV1,
  sourceRoot: string,
  harnessRoot: string,
  profile: TargetProfile,
): Promise<OracleSession> {
  const releaseLease = await acquireOracleLease();
  const stageRoot = mkdtempSync(join(tmpdir(), "pocketjs-perf-vapor-oracle-"));
  const stateHookName = `__pocketPerfVaporState_${basename(stageRoot).replace(/[^a-zA-Z0-9_]/g, "_")}`;
  let handedOff = false;
  try {
    const session = await withSourceDependencies(sourceRoot, harnessRoot, async () => {
      const compilerUrl = pathToFileURL(join(sourceRoot, "vapor/compiler/compile.ts"));
      compilerUrl.searchParams.set("pocket-perf-source", basename(sourceRoot));
      const oracleUrl = pathToFileURL(stageOracleModule(stageRoot, sourceRoot));
      const compiler = await import(compilerUrl.href) as {
        compileVaporApp(
          fileName: string,
          source: string,
          title: string,
          target: VaporTargetName,
        ): CompiledVaporAppLike;
      };
      const oracleModule = await import(oracleUrl.href) as {
        bootOracle(options: {
          width: number;
          height: number;
          styles: unknown;
          entry: string;
        }): Promise<VaporOracleLike>;
      };
      const source = benchmarkFixtureSource(profile);
      const app = compiler.compileVaporApp(profile.benchmarkEntry, source, "PERF AXIS", profile.target);
      const modules = join(harnessRoot, "node_modules");
      if (existsSync(modules)) symlinkSync(modules, join(stageRoot, "node_modules"), "dir");
      const inputPath = join(sourceRoot, "vapor/host/input.ts");
      const screenPath = join(sourceRoot, "vapor/host/screen.ts");
      const oracleApp = oracleStateFixtureSource(source, app.debugSlots, stateHookName)
        .replace('from "../../host/input.ts"', `from ${JSON.stringify(inputPath)}`)
        .replace('from "../../host/screen.ts"', `from ${JSON.stringify(screenPath)}`);
      const appPath = join(stageRoot, "axis-app.tsx");
      const entryPath = join(stageRoot, "axis-entry.ts");
      writeFileSync(appPath, oracleApp);
      writeFileSync(entryPath, `
import { createVaporApp, nextTick } from "vue";
import AxisApp from "./axis-app.tsx";
import { __dispatchAxisDelta, __dispatchButton, __resetButtons } from ${JSON.stringify(inputPath)};
type AnyApp = { mount(container: unknown): void; unmount(): void };
const hooks = globalThis as Record<string, unknown>;
hooks.__vaporBoot = (container: unknown): AnyApp => {
  __resetButtons();
  const app = (createVaporApp as unknown as (comp: unknown) => AnyApp)({ setup: () => (AxisApp as () => unknown)() });
  app.mount(container);
  return app;
};
hooks.__vaporPress = (button: number): void => { __dispatchButton(button); };
hooks.__vaporAxisDelta = (axis: number, delta: number): void => { __dispatchAxisDelta(axis as 0 | 1, delta); };
hooks.__vaporTick = (): Promise<void> => nextTick();
`);
      const oracle = await oracleModule.bootOracle({
        width: profile.width,
        height: profile.height,
        styles: app.styles,
        entry: entryPath,
      });
      const stateHook = (globalThis as Record<string, unknown>)[stateHookName];
      if (typeof stateHook !== "function") {
        throw new Error("Vapor benchmark fixture did not install its state hook");
      }
      return {
        app,
        oracle,
        debugStateBytes: () => debugStateBytes(
          app.debugSlots,
          (stateHook as () => Readonly<Record<string, VaporDebugValue>>)(),
        ),
      };
    });
    handedOff = true;
    let cleaned = false;
    return {
      ...session,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        try {
          delete (globalThis as Record<string, unknown>)[stateHookName];
          rmSync(stageRoot, { recursive: true, force: true });
        } finally {
          releaseLease();
        }
      },
    };
  } finally {
    if (!handedOff) {
      try {
        delete (globalThis as Record<string, unknown>)[stateHookName];
        rmSync(stageRoot, { recursive: true, force: true });
      } finally {
        releaseLease();
      }
    }
  }
}

async function runNativeInProcess(
  options: RunVaporScenarioOptions,
  events: readonly VaporEvent[],
  profile: TargetProfile,
): Promise<VaporNativeResult | VaporInvalidResult> {
  let app: CompiledVaporAppLike;
  let oracle: VaporOracleLike;
  let captureDebugState: () => Uint8Array = () => new Uint8Array();
  let cleanup: () => void = () => {};
  try {
    ({ app, oracle, debugStateBytes: captureDebugState, cleanup } = await compileAndBoot(
      options.scenario,
      resolve(options.sourceRoot),
      resolve(options.harnessRoot),
      profile,
    ));
  } catch (error) {
    return invalid(options.executor, [error instanceof Error ? error.message : String(error)]);
  }

  try {
    const byFrame = new Map<number, VaporEvent[]>();
    for (const event of events) {
      const current = byFrame.get(event.frame);
      if (current) current.push(event);
      else byFrame.set(event.frame, [event]);
    }
    const trace = createHash("sha256");
    const phaseEnds = new Map<number, string[]>();
    for (const phase of options.scenario.phases) {
      if (!phase.collect) continue;
      const current = phaseEnds.get(phase.endFrame - 1);
      if (current) current.push(phase.name);
      else phaseEnds.set(phase.endFrame - 1, [phase.name]);
    }
    const phaseDrawListHashes: Record<string, string> = {};
    const stateCheckpointFrames = new Set(
      options.scenario.checkpoints
        .filter((checkpoint) => checkpoint.capture.includes("state"))
        .map((checkpoint) => checkpoint.frame),
    );
    const checkpointStateDigests: Record<string, string> = {};
    let finalBytes: Uint8Array<ArrayBuffer> = new Uint8Array();
    let finalGrid: VaporGrid | null = null;
    let finalDrawListHash = taggedFnv(FNV_OFFSET);
    let axisEventsDelivered = 0;
    for (let frame = 0; frame < options.scenario.frames; frame += 1) {
      for (const event of byFrame.get(frame) ?? []) {
        if (event.kind === "button") await oracle.press(event.control);
        else {
          await oracle.axisDelta(event.control, event.value);
          axisEventsDelivered += 1;
        }
      }
      finalGrid = oracle.grid();
      finalBytes = gridBytes(finalGrid, profile.width, profile.height);
      finalDrawListHash = taggedFnv(fnvBytes(finalBytes));
      trace.update(finalBytes);
      for (const name of phaseEnds.get(frame) ?? []) phaseDrawListHashes[name] = finalDrawListHash;
      if (stateCheckpointFrames.has(frame)) {
        checkpointStateDigests[String(frame)] = taggedFnv(fnvBytes(captureDebugState()));
      }
    }
    const nodeJson = canonicalJson(canonicalNode(oracle.root));
    const effects = eventBytes(events);
    if (!finalGrid) throw new Error(`${options.scenario.id}: Vapor fixture produced no grid`);
    const axisEventsObserved = assertAxisEvents(finalGrid, profile, events);
    return {
      status: "ok",
      executor: "native",
      framebufferHash: trace.digest("hex"),
      finalFramebufferHash: sha256(finalBytes),
      finalDrawListHash,
      stateHash: sha256(nodeJson),
      effectHash: sha256(effects),
      finalStateDigest: taggedFnv(fnvBytes(captureDebugState())),
      checkpointStateDigests,
      finalEffectDigest: taggedFnv(fnvBytes(effects)),
      phaseDrawListHashes,
      axisEventsDelivered,
      axisEventsObserved,
      compiledRelativeAxesUsed: [...app.relativeAxesUsed],
      compiledButtonsUsed: [...app.buttonsUsed],
      target: profile.target,
      width: profile.width,
      height: profile.height,
    };
  } catch (error) {
    return invalid(options.executor, [error instanceof Error ? error.message : String(error)]);
  } finally {
    try {
      oracle.unmount();
    } finally {
      cleanup();
    }
  }
}

function safeNanoseconds(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`native Vapor timing exceeds the safe integer range: ${value}`);
  }
  return result;
}

function nativeResultFile<T extends NativeRunResult>(
  result: T,
  outDir: string | undefined,
): T {
  if (!outDir) return result;
  mkdirSync(outDir, { recursive: true });
  const safeId = result.scenarioId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  writeFileSync(join(outDir, `${safeId}.native.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function nativeUnsupported(
  scenario: ScenarioV1,
  reasons: readonly string[],
  outDir: string | undefined,
): NativeRunResult {
  return nativeResultFile({
    schemaVersion: 1,
    kind: "pocketjs.perf.native-result",
    status: "unsupported",
    scenarioId: scenario.id,
    executor: "native",
    reasons: unique(reasons),
  }, outDir);
}

async function vaporCorrectnessReplayInProcess(
  scenario: ScenarioV1,
  options: RunNativeVaporScenarioOptions,
  events: readonly VaporEvent[],
  profile: TargetProfile,
): Promise<NativeOkResult["correctness"]> {
  const { oracle, cleanup } = await compileAndBoot(
    scenario,
    resolve(options.sourceRoot),
    resolve(options.harnessRoot),
    profile,
  );
  try {
    const byFrame = new Map<number, VaporEvent[]>();
    for (const event of events) {
      const current = byFrame.get(event.frame);
      if (current) current.push(event);
      else byFrame.set(event.frame, [event]);
    }
    const checkpoints = new Map(scenario.checkpoints.map((checkpoint) => [checkpoint.frame, checkpoint]));
    const captured: Record<string, Record<string, string>> = {};
    const trace = createHash("sha256");
    let finalBytes = new Uint8Array(0);
    let finalDrawListHash = taggedFnv(FNV_OFFSET);
    for (let frame = 0; frame < scenario.frames; frame += 1) {
      for (const event of byFrame.get(frame) ?? []) {
        if (event.kind === "button") await oracle.press(event.control);
        else await oracle.axisDelta(event.control, event.value);
      }
      finalBytes = gridBytes(oracle.grid(), profile.width, profile.height);
      finalDrawListHash = taggedFnv(fnvBytes(finalBytes));
      trace.update(finalBytes);
      const checkpoint = checkpoints.get(frame);
      if (!checkpoint) continue;
      const values: Record<string, string> = {};
      for (const capture of checkpoint.capture) {
        if (capture === "framebuffer") values.framebuffer = sha256(finalBytes);
        else if (capture === "drawList") values.drawList = finalDrawListHash;
        else if (capture === "state") {
          values.state = sha256(canonicalJson(canonicalNode(oracle.root)));
        } else {
          values.effects = sha256(eventBytes(events.filter((event) => event.frame <= frame)));
        }
      }
      captured[String(frame)] = values;
    }
    assertAxisEvents(oracle.grid(), profile, events);
    const finalState = canonicalJson(canonicalNode(oracle.root));
    return {
      framebufferTraceHash: trace.digest("hex"),
      finalFramebufferHash: sha256(finalBytes),
      drawListHash: finalDrawListHash,
      stateHash: sha256(finalState),
      effectHash: sha256(eventBytes(events)),
      checkpoints: captured,
    };
  } finally {
    try {
      oracle.unmount();
    } finally {
      cleanup();
    }
  }
}

async function vaporMeasurementReplayInProcess(
  scenario: ScenarioV1,
  options: RunNativeVaporScenarioOptions,
  events: readonly VaporEvent[],
  profile: TargetProfile,
): Promise<NativeOkResult["measurement"]> {
  const bootStarted = process.hrtime.bigint();
  const { oracle, cleanup } = await compileAndBoot(
    scenario,
    resolve(options.sourceRoot),
    resolve(options.harnessRoot),
    profile,
  );
  const bootWallTimeNs = safeNanoseconds(process.hrtime.bigint() - bootStarted);
  try {
    const byFrame = new Map<number, VaporEvent[]>();
    for (const event of events) {
      const current = byFrame.get(event.frame);
      if (current) current.push(event);
      else byFrame.set(event.frame, [event]);
    }
    const starts = new Map<number, ScenarioV1["phases"]>();
    const ends = new Map<number, ScenarioV1["phases"]>();
    for (const phase of scenario.phases) {
      if (!phase.collect) continue;
      const atStart = starts.get(phase.startFrame) ?? [];
      starts.set(phase.startFrame, [...atStart, phase]);
      const atEnd = ends.get(phase.endFrame - 1) ?? [];
      ends.set(phase.endFrame - 1, [...atEnd, phase]);
    }
    const started = new Map<string, bigint>();
    const timings: NativeOkResult["measurement"]["phases"][number][] = [];
    for (let frame = 0; frame < scenario.frames; frame += 1) {
      for (const phase of starts.get(frame) ?? []) started.set(phase.name, process.hrtime.bigint());
      for (const event of byFrame.get(frame) ?? []) {
        if (event.kind === "button") await oracle.press(event.control);
        else await oracle.axisDelta(event.control, event.value);
      }
      for (const phase of ends.get(frame) ?? []) {
        const start = started.get(phase.name);
        if (start === undefined) throw new Error(`Vapor phase ${phase.name} never started`);
        timings.push({
          name: phase.name,
          startFrame: phase.startFrame,
          endFrame: phase.endFrame,
          wallTimeNs: safeNanoseconds(process.hrtime.bigint() - start),
        });
      }
    }
    // Both fingerprints are correctness work and deliberately happen after
    // every measured phase has ended.
    const finalGrid = oracle.grid();
    assertAxisEvents(finalGrid, profile, events);
    const finalBytes = gridBytes(finalGrid, profile.width, profile.height);
    return {
      bootWallTimeNs,
      phases: timings,
      finalFramebufferHash: sha256(finalBytes),
      finalDrawListHash: taggedFnv(fnvBytes(finalBytes)),
    };
  } finally {
    try {
      oracle.unmount();
    } finally {
      cleanup();
    }
  }
}

type VaporOracleReplayKind = "native" | "correctness" | "measurement";

interface VaporOracleReplayRequest {
  readonly schemaVersion: 1;
  readonly kind: VaporOracleReplayKind;
  readonly scenario: ScenarioV1;
  readonly sourceRoot: string;
  readonly harnessRoot: string;
  readonly events: readonly VaporEvent[];
  readonly profile: TargetProfile;
}

type VaporOracleReplayResponse =
  | {
      readonly schemaVersion: 1;
      readonly kind: VaporOracleReplayKind;
      readonly status: "ok";
      readonly result: unknown;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: VaporOracleReplayKind;
      readonly status: "error";
      readonly reason: string;
    };

/** Internal entry used by the per-replay staged Bun module. */
export async function runVaporOracleReplayChild(
  requestPath: string,
  responsePath: string,
): Promise<void> {
  let kind: VaporOracleReplayKind = "native";
  let response: VaporOracleReplayResponse;
  try {
    const request = JSON.parse(readFileSync(requestPath, "utf8")) as VaporOracleReplayRequest;
    if (request.schemaVersion !== 1) throw new Error("unsupported Vapor oracle replay request schema");
    if (request.kind !== "native" && request.kind !== "correctness" && request.kind !== "measurement") {
      throw new Error(`unsupported Vapor oracle replay kind ${JSON.stringify(request.kind)}`);
    }
    kind = request.kind;
    const options: RunNativeVaporScenarioOptions = {
      sourceRoot: request.sourceRoot,
      harnessRoot: request.harnessRoot,
    };
    const result = request.kind === "native"
      ? await runNativeInProcess({
          scenario: request.scenario,
          executor: "native",
          sourceRoot: request.sourceRoot,
          harnessRoot: request.harnessRoot,
        }, request.events, request.profile)
      : request.kind === "correctness"
        ? await vaporCorrectnessReplayInProcess(request.scenario, options, request.events, request.profile)
        : await vaporMeasurementReplayInProcess(request.scenario, options, request.events, request.profile);
    response = { schemaVersion: 1, kind, status: "ok", result };
  } catch (error) {
    response = {
      schemaVersion: 1,
      kind,
      status: "error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  writeFileSync(responsePath, `${JSON.stringify(response)}\n`);
}

async function runIsolatedOracleReplay<T>(
  kind: VaporOracleReplayKind,
  scenario: ScenarioV1,
  options: RunNativeVaporScenarioOptions,
  events: readonly VaporEvent[],
  profile: TargetProfile,
): Promise<T> {
  const stageRoot = mkdtempSync(join(tmpdir(), "pocketjs-perf-vapor-replay-"));
  const requestPath = join(stageRoot, "request.json");
  const responsePath = join(stageRoot, "response.json");
  const runnerPath = join(stageRoot, "oracle-replay.ts");
  try {
    const request: VaporOracleReplayRequest = {
      schemaVersion: 1,
      kind,
      scenario,
      sourceRoot: resolve(options.sourceRoot),
      harnessRoot: resolve(options.harnessRoot),
      events,
      profile,
    };
    const adapterUrl = new URL(import.meta.url);
    adapterUrl.searchParams.set("pocket-perf-oracle-child", basename(stageRoot));
    writeFileSync(requestPath, `${JSON.stringify(request)}\n`);
    writeFileSync(runnerPath, `
import { runVaporOracleReplayChild } from ${JSON.stringify(adapterUrl.href)};
const requestPath = process.argv[2];
const responsePath = process.argv[3];
if (!requestPath || !responsePath) throw new Error("Vapor oracle child paths are required");
await runVaporOracleReplayChild(requestPath, responsePath);
`);

    const child = Bun.spawn([process.execPath, runnerPath, requestPath, responsePath], {
      cwd: resolve(options.harnessRoot),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const diagnostics = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    if (exitCode !== 0) {
      throw new Error(
        `Vapor ${kind} oracle child exited ${exitCode}${diagnostics ? `: ${diagnostics}` : ""}`,
      );
    }
    if (!existsSync(responsePath)) {
      throw new Error(
        `Vapor ${kind} oracle child produced no terminal response${diagnostics ? `: ${diagnostics}` : ""}`,
      );
    }
    let response: VaporOracleReplayResponse;
    try {
      response = JSON.parse(readFileSync(responsePath, "utf8")) as VaporOracleReplayResponse;
    } catch (error) {
      throw new Error(
        `Vapor ${kind} oracle child produced a malformed terminal response: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.schemaVersion !== 1 || response.kind !== kind) {
      throw new Error(`Vapor ${kind} oracle child produced an incompatible terminal response`);
    }
    if (response.status === "error") {
      if (typeof response.reason !== "string" || response.reason.length === 0) {
        throw new Error(`Vapor ${kind} oracle child produced an incompatible error response`);
      }
      throw new Error(response.reason);
    }
    if (response.status !== "ok" ||
        !Object.prototype.hasOwnProperty.call(response, "result") ||
        response.result === null || typeof response.result !== "object") {
      throw new Error(`Vapor ${kind} oracle child produced an incomplete terminal response`);
    }
    return response.result as T;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

async function runNative(
  options: RunVaporScenarioOptions,
  events: readonly VaporEvent[],
  profile: TargetProfile,
): Promise<VaporNativeResult | VaporInvalidResult> {
  try {
    return await runIsolatedOracleReplay<VaporNativeResult | VaporInvalidResult>(
      "native",
      options.scenario,
      options,
      events,
      profile,
    );
  } catch (error) {
    return invalid(options.executor, [error instanceof Error ? error.message : String(error)]);
  }
}

/**
 * Native-runner bridge for the Vapor family. It uses two independent real
 * Vue Vapor boots, matching the generic runner's correctness/measurement
 * split while keeping all grid and state hashing outside measured phases.
 */
export async function runNativeVaporScenario(
  scenario: ScenarioV1,
  options: RunNativeVaporScenarioOptions,
): Promise<NativeRunResult> {
  const reasons = validateScenario(scenario);
  const sourceRoot = resolve(options.sourceRoot);
  const profile = profileForEntry(sourceRoot, scenario.subject.entry);
  if (!profile) reasons.push(`Vapor oracle has no real Vue entry adapter for ${scenario.subject.entry}`);
  else if (!existsSync(profile.benchmarkEntry)) reasons.push(`missing Vapor benchmark source ${profile.benchmarkEntry}`);
  for (const path of [
    join(sourceRoot, scenario.subject.entry),
    join(sourceRoot, "vapor/compiler/compile.ts"),
    join(sourceRoot, "vapor/oracle/boot.ts"),
  ]) {
    if (!existsSync(path)) reasons.push(`missing Vapor source input ${path}`);
  }
  const built = buildEvents(scenario);
  reasons.push(...built.reasons);
  if (reasons.length > 0 || !profile) return nativeUnsupported(scenario, reasons, options.outDir);

  try {
    const correctness = await runIsolatedOracleReplay<NativeOkResult["correctness"]>(
      "correctness",
      scenario,
      options,
      built.events,
      profile,
    );
    const measurement = await runIsolatedOracleReplay<NativeOkResult["measurement"]>(
      "measurement",
      scenario,
      options,
      built.events,
      profile,
    );
    if (correctness.finalFramebufferHash !== measurement.finalFramebufferHash) {
      throw new Error(
        `${scenario.id}: Vapor correctness/measurement final grid diverged: ` +
          `${correctness.finalFramebufferHash} != ${measurement.finalFramebufferHash}`,
      );
    }
    if (correctness.drawListHash !== measurement.finalDrawListHash) {
      throw new Error(
        `${scenario.id}: Vapor correctness/measurement DrawList diverged: ` +
          `${correctness.drawListHash} != ${measurement.finalDrawListHash}`,
      );
    }
    const diagnosticMetrics: Record<string, { value: number; unit: "ns" | "count" }> = {
      "native.boot_wall_time_ns": { value: measurement.bootWallTimeNs, unit: "ns" },
      "native.measured_frames": {
        value: scenario.phases
          .filter((phase) => phase.collect)
          .reduce((sum, phase) => sum + phase.endFrame - phase.startFrame, 0),
        unit: "count",
      },
      "native.wall_time_ns": {
        value: measurement.phases.reduce((sum, phase) => sum + phase.wallTimeNs, 0),
        unit: "ns",
      },
    };
    for (const phase of measurement.phases) {
      diagnosticMetrics[`native.phase.${phase.name}.wall_time_ns`] = {
        value: phase.wallTimeNs,
        unit: "ns",
      };
    }
    const requestedGateMetrics = Array.isArray(scenario.params.gateMetrics)
      ? scenario.params.gateMetrics.filter((metric): metric is string => typeof metric === "string")
      : [];
    return nativeResultFile({
      schemaVersion: 1,
      kind: "pocketjs.perf.native-result",
      status: "ok",
      scenarioId: scenario.id,
      executor: "native",
      sourceRoot,
      correctness,
      measurement,
      diagnosticMetrics,
      exactMetrics: {},
      unsupportedMetrics: requestedGateMetrics,
    }, options.outDir);
  } catch (error) {
    return nativeUnsupported(
      scenario,
      [error instanceof Error ? error.message : String(error)],
      options.outDir,
    );
  }
}

function cString(value: string): string {
  return JSON.stringify(value).slice(1, -1).replace(/\\u([0-9a-fA-F]{4})/g, "\\u$1");
}

function patchedRuntimeHeader(sourceRoot: string): string {
  const original = readFileSync(join(sourceRoot, "vapor/runtime/vapor.h"), "utf8");
  const typedefs = [
    "typedef unsigned char u8;",
    "typedef unsigned short u16;",
    "typedef unsigned long u32;",
    "typedef signed char s8;",
    "typedef signed short s16;",
    "typedef signed long s32;",
  ].join("\n");
  if (!original.includes(typedefs)) {
    throw new Error("vapor/runtime/vapor.h integer contract changed; update the Linux perf header adaptation");
  }
  return original.replace(typedefs, [
    "#include <stdint.h>",
    "typedef uint8_t u8;",
    "typedef uint16_t u16;",
    "typedef uint32_t u32;",
    "typedef int8_t s8;",
    "typedef int16_t s16;",
    "typedef int32_t s32;",
  ].join("\n"));
}

function eventInitializers(events: readonly VaporEvent[]): string {
  if (events.length === 0) return "  { 0, 0, 0, 0 }";
  return events.map((event) =>
    `  { ${event.frame}u, ${event.kind === "button" ? "1u" : "2u"}, ${event.control}u, ${event.value} }`,
  ).join(",\n");
}

function phaseInitializers(scenario: ScenarioV1): string {
  const stateFrames = new Set(stateCheckpointFrames(scenario));
  return scenario.phases.filter((phase) => phase.collect).map((phase) =>
    `  { "${cString(phase.name)}", ${phase.startFrame}u, ${phase.endFrame}u, ${scenarioPhaseId(scenario.id, phase.name)}u, ${stateFrames.has(phase.endFrame - 1) ? "1u" : "0u"} }`,
  ).join(",\n");
}

function stateCheckpointFrames(scenario: ScenarioV1): number[] {
  return scenario.checkpoints
    .filter((checkpoint) => checkpoint.capture.includes("state"))
    .map((checkpoint) => checkpoint.frame);
}

function qemuStateCheckpointReasons(scenario: ScenarioV1): string[] {
  const phaseEndCounts = new Map<number, number>();
  for (const phase of scenario.phases.filter((phase) => phase.collect)) {
    const frame = phase.endFrame - 1;
    phaseEndCounts.set(frame, (phaseEndCounts.get(frame) ?? 0) + 1);
  }
  return stateCheckpointFrames(scenario).flatMap((frame) => {
    const count = phaseEndCounts.get(frame) ?? 0;
    return count === 1 ? [] : [
      `Vapor QEMU state checkpoint ${frame} must coincide with exactly one collected phase end so hashing stays outside markers`,
    ];
  });
}

function debugStateLayoutLength(slots: readonly VaporDebugSlot[]): number {
  let end = 0;
  let previousEnd = 0;
  for (const slot of slots) {
    if (!Number.isInteger(slot.offset) || !Number.isInteger(slot.size) ||
        slot.offset < previousEnd || slot.size <= 0) {
      throw new Error(`Vapor compiler returned an invalid debug slot ${slot.name}`);
    }
    if (slot.kind !== "str" && slot.size !== 4) {
      throw new Error(`Vapor compiler returned a non-32-bit ${slot.kind} slot ${slot.name}`);
    }
    end = Math.max(end, slot.offset + slot.size);
    previousEnd = slot.offset + slot.size;
  }
  const aligned = (end + 3) & ~3;
  if (aligned > 4096) throw new Error(`Vapor debug state requires ${aligned} bytes; guest limit is 4096`);
  return aligned;
}

function cDebugStateHashBody(slots: readonly VaporDebugSlot[]): string {
  const statements: string[] = [];
  slots.forEach((slot, slotIndex) => {
    if (slot.kind === "str") {
      const capacity = slot.size - 1;
      statements.push(
        `  { u8 n = state.bytes[${slot.offset}]; u8 j;`,
        `    if (n > ${capacity}u) { perf_state_valid = 0; n = ${capacity}u; }`,
        `    hash = fnv_byte(hash, n);`,
        `    for (j = 0; j < n; j++) hash = fnv_byte(hash, state.bytes[${slot.offset + 1}u + j]);`,
        "  }",
      );
    } else {
      statements.push(
        `  { u8 j; for (j = 0; j < 4u; j++) hash = fnv_byte(hash, state.bytes[${slot.offset}u + j]); }`,
      );
    }
    if (slotIndex === slots.length - 1) statements.push("");
  });
  return statements.join("\n").trimEnd();
}

function linuxHarnessSource(
  scenario: ScenarioV1,
  events: readonly VaporEvent[],
  debugSlots: readonly VaporDebugSlot[],
): string {
  const eventCount = events.length;
  const phases = scenario.phases.filter((phase) => phase.collect);
  const debugStateLength = debugStateLayoutLength(debugSlots);
  const debugStateHashBody = cDebugStateHashBody(debugSlots);
  return `/* Generated local performance fixture. */
#include "vapor.h"
#include "guest_marker.h"

typedef unsigned long long perf_u64;
typedef unsigned long perf_word;

u8 vp_grid_ch[VP_GRID_H][VP_GRID_W];
u8 vp_grid_pal[VP_GRID_H][VP_GRID_W];

typedef struct { u32 frame; u8 kind; u8 control; s32 value; } perf_event;
typedef struct { const char *name; u32 start_frame; u32 end_frame; u32 id; u8 capture_state; } perf_phase;

static const perf_event PERF_EVENTS[${Math.max(1, eventCount)}] = {
${eventInitializers(events)}
};
static const perf_phase PERF_PHASES[${phases.length}] = {
${phaseInitializers(scenario)}
};

static char out_buf[2048];
static u32 out_len;
static u8 perf_state_valid = 1;
static u8 perf_correctness;

static long raw_write(const char *buf, u32 len) {
#if defined(__aarch64__)
  register long x0 __asm__("x0") = 1;
  register const char *x1 __asm__("x1") = buf;
  register u32 x2 __asm__("x2") = len;
  register long x8 __asm__("x8") = 64;
  __asm__ volatile("svc #0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x8) : "memory", "cc");
  return x0;
#else
  register long r0 __asm__("r0") = 1;
  register const char *r1 __asm__("r1") = buf;
  register u32 r2 __asm__("r2") = len;
  register long r7 __asm__("r7") = 4;
  __asm__ volatile("svc #0" : "+r"(r0) : "r"(r1), "r"(r2), "r"(r7) : "memory", "cc");
  return r0;
#endif
}

static __attribute__((noreturn)) void raw_exit(long code) {
#if defined(__aarch64__)
  register long x0 __asm__("x0") = code;
  register long x8 __asm__("x8") = 93;
  __asm__ volatile("svc #0" : : "r"(x0), "r"(x8) : "memory", "cc");
#else
  register long r0 __asm__("r0") = code;
  register long r7 __asm__("r7") = 1;
  __asm__ volatile("svc #0" : : "r"(r0), "r"(r7) : "memory", "cc");
#endif
  __builtin_unreachable();
}

static void out_reset(void) { out_len = 0; }
static void out_char(char c) { if (out_len < sizeof(out_buf)) out_buf[out_len++] = c; }
static void out_text(const char *s) { while (*s) out_char(*s++); }
static void out_u32(u32 value) {
  char digits[10]; u8 n = 0;
  do { digits[n++] = (char)('0' + value % 10u); value /= 10u; } while (value && n < 10u);
  while (n) out_char(digits[--n]);
}
static void out_hex64(perf_u64 value) {
  static const char HEX[] = "0123456789abcdef"; s8 shift;
  for (shift = 60; shift >= 0; shift -= 4) out_char(HEX[(value >> (u8)shift) & 15u]);
}
static void out_hex_bytes(const u8 *bytes, u32 len) {
  static const char HEX[] = "0123456789abcdef"; u32 i;
  for (i = 0; i < len; i++) { out_char(HEX[bytes[i] >> 4]); out_char(HEX[bytes[i] & 15u]); }
}
static void out_flush(void) {
  u32 sent = 0;
  while (sent < out_len) { long n = raw_write(out_buf + sent, out_len - sent); if (n <= 0) raw_exit(70); sent += (u32)n; }
}

static perf_u64 fnv_byte(perf_u64 hash, u8 byte) {
  return (hash ^ (perf_u64)byte) * 0x100000001b3ULL;
}
static perf_u64 fnv_u32(perf_u64 hash, u32 value) {
  u8 i; for (i = 0; i < 4; i++) { hash = fnv_byte(hash, (u8)value); value >>= 8; } return hash;
}

/* Dependency-free SHA-256, used only by the observational correctness replay. */
typedef struct {
  u32 state[8];
  u8 block[64];
  u32 block_len;
  perf_u64 byte_len;
} perf_sha256;

static const u32 PERF_SHA256_K[64] = {
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
  0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
  0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
  0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
  0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
  0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
  0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
  0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
  0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

static u32 sha_rotr(u32 value, u8 bits) {
  return (value >> bits) | (value << (32u - bits));
}

static void sha256_compress(perf_sha256 *sha) {
  u32 words[64]; u32 i;
  u32 a, b, c, d, e, f, g, h;
  for (i = 0; i < 16u; i++) {
    u32 at = i * 4u;
    words[i] = ((u32)sha->block[at] << 24) | ((u32)sha->block[at + 1u] << 16) |
      ((u32)sha->block[at + 2u] << 8) | (u32)sha->block[at + 3u];
  }
  for (i = 16u; i < 64u; i++) {
    u32 s0 = sha_rotr(words[i - 15u], 7) ^ sha_rotr(words[i - 15u], 18) ^
      (words[i - 15u] >> 3);
    u32 s1 = sha_rotr(words[i - 2u], 17) ^ sha_rotr(words[i - 2u], 19) ^
      (words[i - 2u] >> 10);
    words[i] = words[i - 16u] + s0 + words[i - 7u] + s1;
  }
  a = sha->state[0]; b = sha->state[1]; c = sha->state[2]; d = sha->state[3];
  e = sha->state[4]; f = sha->state[5]; g = sha->state[6]; h = sha->state[7];
  for (i = 0; i < 64u; i++) {
    u32 choice = (e & f) ^ ((~e) & g);
    u32 majority = (a & b) ^ (a & c) ^ (b & c);
    u32 sum1 = sha_rotr(e, 6) ^ sha_rotr(e, 11) ^ sha_rotr(e, 25);
    u32 sum0 = sha_rotr(a, 2) ^ sha_rotr(a, 13) ^ sha_rotr(a, 22);
    u32 temp1 = h + sum1 + choice + PERF_SHA256_K[i] + words[i];
    u32 temp2 = sum0 + majority;
    h = g; g = f; f = e; e = d + temp1; d = c; c = b; b = a; a = temp1 + temp2;
  }
  sha->state[0] += a; sha->state[1] += b; sha->state[2] += c; sha->state[3] += d;
  sha->state[4] += e; sha->state[5] += f; sha->state[6] += g; sha->state[7] += h;
}

static void sha256_init(perf_sha256 *sha) {
  u8 i;
  static const u32 INITIAL[8] = {
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
  };
  for (i = 0; i < 8u; i++) sha->state[i] = INITIAL[i];
  for (i = 0; i < 64u; i++) sha->block[i] = 0;
  sha->block_len = 0; sha->byte_len = 0;
}

static void sha256_update(perf_sha256 *sha, const u8 *bytes, u32 len) {
  u32 at = 0;
  sha->byte_len += (perf_u64)len;
  while (at < len) {
    u32 room = 64u - sha->block_len;
    u32 take = len - at < room ? len - at : room;
    u32 i;
    for (i = 0; i < take; i++) sha->block[sha->block_len + i] = bytes[at + i];
    sha->block_len += take; at += take;
    if (sha->block_len == 64u) { sha256_compress(sha); sha->block_len = 0; }
  }
}

static void sha256_finish(perf_sha256 *sha, u8 digest[32]) {
  perf_u64 bit_len = sha->byte_len * 8u; u32 i;
  sha->block[sha->block_len++] = 0x80u;
  if (sha->block_len > 56u) {
    while (sha->block_len < 64u) sha->block[sha->block_len++] = 0;
    sha256_compress(sha); sha->block_len = 0;
  }
  while (sha->block_len < 56u) sha->block[sha->block_len++] = 0;
  for (i = 0; i < 8u; i++) sha->block[63u - i] = (u8)(bit_len >> (i * 8u));
  sha256_compress(sha);
  for (i = 0; i < 8u; i++) {
    digest[i * 4u] = (u8)(sha->state[i] >> 24);
    digest[i * 4u + 1u] = (u8)(sha->state[i] >> 16);
    digest[i * 4u + 2u] = (u8)(sha->state[i] >> 8);
    digest[i * 4u + 3u] = (u8)sha->state[i];
  }
}

static u8 sha256_self_test(void) {
  static const u8 EXPECTED[32] = {
    0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
    0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
    0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
    0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad
  };
  static const u8 ABC[3] = { (u8)'a', (u8)'b', (u8)'c' };
  perf_sha256 sha; u8 digest[32]; u8 i;
  sha256_init(&sha); sha256_update(&sha, ABC, 3u); sha256_finish(&sha, digest);
  for (i = 0; i < 32u; i++) if (digest[i] != EXPECTED[i]) return 0;
  return 1;
}

static perf_sha256 perf_framebuffer_trace;
static u8 perf_framebuffer_trace_digest[32];

static perf_u64 grid_hash(void) {
  perf_u64 hash = 0xcbf29ce484222325ULL; u16 i;
  for (i = 0; i < (u16)(VP_GRID_W * VP_GRID_H); i++) hash = fnv_byte(hash, ((u8 *)vp_grid_ch)[i]);
  for (i = 0; i < (u16)(VP_GRID_W * VP_GRID_H); i++) hash = fnv_byte(hash, ((u8 *)vp_grid_pal)[i]);
  return hash;
}
static perf_u64 state_hash(void) {
  union { perf_u64 align; u8 bytes[4096]; } state; perf_u64 hash = 0xcbf29ce484222325ULL;
  u16 len = app_debug_state(state.bytes);
  if (len != ${debugStateLength}u) { perf_state_valid = 0; return hash; }
${debugStateHashBody}
  return hash;
}
static perf_u64 events_hash(void) {
  perf_u64 hash = 0xcbf29ce484222325ULL; u32 i;
  for (i = 0; i < ${eventCount}u; i++) {
    const perf_event *event = &PERF_EVENTS[i];
    hash = fnv_byte(hash, event->kind);
    hash = fnv_u32(hash, event->frame);
    hash = fnv_byte(hash, event->control);
    if (event->kind == 2u) hash = fnv_u32(hash, (u32)event->value);
  }
  return hash;
}

static void emit_phase(const perf_phase *phase) {
  out_reset();
  out_text("POCKETJS_PERF_GUEST {\\\"schemaVersion\\\":1,\\\"event\\\":\\\"phase\\\",\\\"scenarioId\\\":\\\"${cString(scenario.id)}\\\",\\\"phase\\\":\\\"");
  out_text(phase->name);
  out_text("\\\",\\\"phaseId\\\":"); out_u32(phase->id);
  out_text(",\\\"iteration\\\":0,\\\"allocCalls\\\":0,\\\"allocatedBytes\\\":0,\\\"currentBytes\\\":0,\\\"peakBytes\\\":0,\\\"quickjsLiveBytesAfterGc\\\":0,\\\"drawListHash\\\":\\\"fnv1a64:");
  out_hex64(grid_hash()); out_text("\\\"}\\n"); out_flush();
}

static void emit_state_checkpoint(u32 frame) {
  out_reset();
  out_text("POCKETJS_PERF_VAPOR {\\\"schemaVersion\\\":1,\\\"event\\\":\\\"state-checkpoint\\\",\\\"scenarioId\\\":\\\"${cString(scenario.id)}\\\",\\\"frame\\\":");
  out_u32(frame);
  out_text(",\\\"stateHash\\\":\\\"fnv1a64:"); out_hex64(state_hash());
  out_text("\\\"}\\n"); out_flush();
}

static void emit_complete(void) {
  out_reset();
  out_text("POCKETJS_PERF_GUEST {\\\"schemaVersion\\\":1,\\\"event\\\":\\\"complete\\\",\\\"scenarioId\\\":\\\"${cString(scenario.id)}\\\",\\\"suite\\\":\\\"${cString(scenario.suite)}\\\",\\\"framework\\\":\\\"core\\\",\\\"finalDrawListHash\\\":\\\"fnv1a64:");
  out_hex64(grid_hash()); out_text("\\\",\\\"finalStateHash\\\":\\\"fnv1a64:");
  out_hex64(state_hash()); out_text("\\\",\\\"effectHash\\\":\\\"fnv1a64:");
  out_hex64(events_hash());
  if (perf_correctness) {
    out_text("\\\",\\\"framebufferTraceHash\\\":\\\"");
    out_hex_bytes(perf_framebuffer_trace_digest, 32u);
  }
  out_text("\\\"}\\n"); out_flush();
}

static int perf_main(void) {
  u32 frame, event_at = 0, phase_at = 0; u16 cell;
  for (cell = 0; cell < (u16)(VP_GRID_W * VP_GRID_H); cell++) {
    ((u8 *)vp_grid_ch)[cell] = (u8)' '; ((u8 *)vp_grid_pal)[cell] = 0;
  }
  if (perf_correctness) {
    if (!sha256_self_test()) return 78;
    sha256_init(&perf_framebuffer_trace);
  }
  app_init();
  for (frame = 0; frame < ${scenario.frames}u; frame++) {
    if (phase_at < ${phases.length}u && PERF_PHASES[phase_at].start_frame == frame) {
      long marker_result = pocketjs_perf_begin(PERF_PHASES[phase_at].id, 0);
      if (perf_correctness) {
        if (marker_result != -38) return 76;
      } else if (marker_result != 0) return 71;
    }
    while (event_at < ${eventCount}u && PERF_EVENTS[event_at].frame == frame) {
      const perf_event *event = &PERF_EVENTS[event_at++];
      if (event->kind == 1u) app_on_button(event->control);
      else app_on_axis_delta(event->control, event->value);
    }
    (void)app_flush();
    if (perf_correctness) {
      sha256_update(&perf_framebuffer_trace, (const u8 *)vp_grid_ch, (u32)(VP_GRID_W * VP_GRID_H));
      sha256_update(&perf_framebuffer_trace, (const u8 *)vp_grid_pal, (u32)(VP_GRID_W * VP_GRID_H));
    }
    if (phase_at < ${phases.length}u && PERF_PHASES[phase_at].end_frame == frame + 1u) {
      const perf_phase *phase = &PERF_PHASES[phase_at];
      if (!perf_correctness && pocketjs_perf_end(phase->id, 0) != 0) return 72;
      emit_phase(phase);
      if (phase->capture_state) emit_state_checkpoint(frame);
      phase_at++;
    }
  }
  if (event_at != ${eventCount}u || phase_at != ${phases.length}u) return 73;
  if (perf_correctness) sha256_finish(&perf_framebuffer_trace, perf_framebuffer_trace_digest);
  emit_complete();
  if (vp_tripwires != 0) return 74;
  return perf_state_valid ? 0 : 75;
}

static u8 text_equal(const char *left, const char *right) {
  if (!left || !right) return 0;
  while (*left && *right && *left == *right) { left++; right++; }
  return (u8)(*left == *right);
}

static __attribute__((used, noreturn, noinline)) void perf_start(const perf_word *stack) {
  u32 argc = (u32)stack[0];
  if (argc == 2u && text_equal((const char *)(perf_word)stack[2], "--correctness")) {
    perf_correctness = 1;
  } else if (argc != 1u) {
    raw_exit(77);
  }
  raw_exit(perf_main());
}

#if defined(__aarch64__)
__asm__(
  ".pushsection .text.start,\\\"ax\\\",%progbits\\n"
  ".align 2\\n"
  ".global _start\\n"
  ".type _start, %function\\n"
  "_start:\\n"
  "mov x0, sp\\n"
  "b perf_start\\n"
  ".size _start, . - _start\\n"
  ".popsection\\n"
);
#else
__attribute__((naked, noreturn)) void _start(void) {
  __asm__("mov r0, sp\\n\\tb perf_start");
}
#endif
`;
}

export interface PreparedVaporQemuFixture {
  readonly directory: string;
  readonly generatedApp: string;
  readonly runtimeCore: string;
  readonly runtimeHeader: string;
  readonly guestHarness: string;
  readonly elfPath: string;
  readonly build: VaporQemuBuildSpec;
  readonly profile: TargetProfile;
}

/** Materialize only deterministic generated inputs; compilation stays in the pinned image. */
export async function prepareVaporQemuFixture(
  options: RunVaporScenarioOptions,
  eventsInput?: readonly VaporEvent[],
): Promise<PreparedVaporQemuFixture> {
  if (options.executor === "native") throw new Error("native has no QEMU fixture");
  const sourceRoot = resolve(options.sourceRoot);
  const harnessRoot = resolve(options.harnessRoot);
  const profile = profileForEntry(sourceRoot, options.scenario.subject.entry);
  if (!profile) throw new Error(`Vapor oracle has no real Vue entry adapter for ${options.scenario.subject.entry}`);
  const eventsResult = eventsInput ? { events: [...eventsInput], reasons: [] } : buildEvents(options.scenario);
  if (eventsResult.reasons.length > 0) throw new Error(eventsResult.reasons.join("; "));
  const checkpointReasons = qemuStateCheckpointReasons(options.scenario);
  if (checkpointReasons.length > 0) throw new Error(checkpointReasons.join("; "));
  const directory = resolve(options.outDir ?? mkdtempSync(join(tmpdir(), "pocketjs-perf-vapor-")));
  mkdirSync(directory, { recursive: true });

  const compiled = await withSourceDependencies(sourceRoot, harnessRoot, async () => {
    const compilerUrl = pathToFileURL(join(sourceRoot, "vapor/compiler/compile.ts"));
    compilerUrl.searchParams.set("pocket-perf-qemu", basename(sourceRoot));
    const compiler = await import(compilerUrl.href) as {
      compileVaporApp(fileName: string, source: string, title: string, target: VaporTargetName): CompiledVaporAppLike;
    };
    return compiler.compileVaporApp(
      profile.benchmarkEntry,
      benchmarkFixtureSource(profile),
      "PERF AXIS",
      profile.target,
    );
  });

  const generatedApp = join(directory, "gen_app.c");
  const runtimeCore = join(directory, "vapor_core.c");
  const runtimeHeader = join(directory, "vapor.h");
  const guestHarness = join(directory, "vapor_perf_guest.c");
  const elfPath = join(directory, `vapor-${options.executor}.elf`);
  writeFileSync(generatedApp, compiled.c);
  writeFileSync(runtimeCore, readFileSync(join(sourceRoot, "vapor/runtime/vapor_core.c")));
  writeFileSync(runtimeHeader, patchedRuntimeHeader(sourceRoot));
  writeFileSync(guestHarness, linuxHarnessSource(
    options.scenario,
    eventsResult.events,
    compiled.debugSlots,
  ));
  return {
    directory,
    generatedApp,
    runtimeCore,
    runtimeHeader,
    guestHarness,
    elfPath,
    build: VAPOR_QEMU_BUILD_SPECS[options.executor],
    profile,
  };
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function command(argv: readonly string[], cwd: string): ProcessResult {
  const child = Bun.spawnSync(argv as string[], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: child.exitCode,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
}

function dockerCommand(image: string, directory: string, argv: readonly string[]): ProcessResult {
  return command([
    "docker", "run", "--rm",
    "--volume", `${directory}:/work`,
    "--workdir", "/work",
    image,
    ...argv,
  ], directory);
}

function combinedProcessOutput(result: ProcessResult): string {
  return `${result.stdout}${result.stdout && result.stderr ? "\n" : ""}${result.stderr}`;
}

function elfTextRodata(sizeOutput: string): number {
  let total = 0;
  for (const line of sizeOutput.split(/\r?\n/)) {
    const match = /^\s*(\.text(?:\.[^\s]+)?|\.rodata(?:\.[^\s]+)?)\s+(\d+)\b/.exec(line);
    if (match) total += Number(match[2]);
  }
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error("ELF size output has no .text/.rodata bytes");
  return total;
}

const VAPOR_STATE_OUTPUT_PREFIX = "POCKETJS_PERF_VAPOR ";
const FNV1A64_DIGEST = /^fnv1a64:[a-f0-9]{16}$/;

interface VaporStateCheckpointRecord {
  readonly schemaVersion: 1;
  readonly event: "state-checkpoint";
  readonly scenarioId: string;
  readonly frame: number;
  readonly stateHash: string;
}

function parseVaporStateCheckpoints(output: string): {
  readonly records: readonly VaporStateCheckpointRecord[];
  readonly reasons: readonly string[];
} {
  const records: VaporStateCheckpointRecord[] = [];
  const reasons: string[] = [];
  for (const [index, line] of output.split(/\r?\n/u).entries()) {
    if (!line.startsWith(VAPOR_STATE_OUTPUT_PREFIX)) continue;
    const label = `Vapor state line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(VAPOR_STATE_OUTPUT_PREFIX.length));
    } catch (error) {
      reasons.push(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      reasons.push(`${label}: protocol value is not an object`);
      continue;
    }
    const record = value as Record<string, unknown>;
    const required = ["schemaVersion", "event", "scenarioId", "frame", "stateHash"] as const;
    const unknown = Object.keys(record).filter((key) => !required.includes(key as typeof required[number]));
    const missing = required.filter((key) => !Object.hasOwn(record, key));
    if (unknown.length > 0 || missing.length > 0) {
      if (unknown.length > 0) reasons.push(`${label}: unknown properties: ${unknown.join(", ")}`);
      if (missing.length > 0) reasons.push(`${label}: missing properties: ${missing.join(", ")}`);
      continue;
    }
    if (record.schemaVersion !== 1 || record.event !== "state-checkpoint" ||
        typeof record.scenarioId !== "string" || record.scenarioId.length === 0 ||
        typeof record.frame !== "number" || !Number.isSafeInteger(record.frame) || record.frame < 0 ||
        typeof record.stateHash !== "string" || !FNV1A64_DIGEST.test(record.stateHash)) {
      reasons.push(`${label}: invalid state-checkpoint record`);
      continue;
    }
    records.push(record as unknown as VaporStateCheckpointRecord);
  }
  return { records, reasons };
}

function generatedCReplayShapeReasons(
  label: "correctness" | "measurement",
  scenario: ScenarioV1,
  guest: GuestProtocolResult,
  states: ReturnType<typeof parseVaporStateCheckpoints>,
): string[] {
  const reasons = states.reasons.map((reason) => `${label}: ${reason}`);
  const expectedPhases = scenario.phases.filter((phase) => phase.collect);
  if (guest.phases.length !== expectedPhases.length) {
    reasons.push(`${label} emitted ${guest.phases.length} phases; expected ${expectedPhases.length}`);
  }
  guest.phases.forEach((phase, index) => {
    const expected = expectedPhases[index];
    if (!expected || phase.scenarioId !== scenario.id || phase.phase !== expected.name ||
        phase.phaseId !== scenarioPhaseId(scenario.id, expected.name) || phase.iteration !== 0) {
      reasons.push(`${label} phase ${index} identity differs from scenario`);
    }
  });
  if (guest.complete &&
      (guest.complete.scenarioId !== scenario.id || guest.complete.suite !== scenario.suite ||
        guest.complete.framework !== scenario.subject.framework)) {
    reasons.push(`${label} complete identity differs from scenario`);
  }
  const expectedStateFrames = stateCheckpointFrames(scenario);
  if (states.records.length !== expectedStateFrames.length) {
    reasons.push(
      `${label} emitted ${states.records.length} state checkpoints; expected ${expectedStateFrames.length}`,
    );
  }
  states.records.forEach((record, index) => {
    if (record.scenarioId !== scenario.id || record.frame !== expectedStateFrames[index]) {
      reasons.push(`${label} state checkpoint ${index} identity differs from scenario`);
    }
  });
  const finalPhaseIndex = expectedPhases.findIndex((phase) => phase.endFrame === scenario.frames);
  if (finalPhaseIndex >= 0 && guest.complete && guest.phases[finalPhaseIndex] &&
      guest.phases[finalPhaseIndex]!.drawListHash !== guest.complete.finalDrawListHash) {
    reasons.push(`${label} final phase DrawList differs from complete`);
  }
  return reasons;
}

/**
 * Validate the two generated-C executions before measurement diagnostics are
 * discarded. The correctness run owns all observational hashes and must be
 * plugin-free; the measurement run owns only the QEMU counter stream.
 */
export function vaporQemuReplayReasons(
  scenario: ScenarioV1,
  correctnessOutput: string,
  measurementOutput: string,
): {
  readonly correctness: GuestProtocolResult;
  readonly measurement: GuestProtocolResult;
  readonly qemu: QemuProtocolResult;
  readonly reasons: string[];
} {
  const correctness = parseGuestOutput(correctnessOutput, { framebufferTraceHash: "required" });
  const measurement = parseGuestOutput(measurementOutput, { framebufferTraceHash: "forbidden" });
  const qemu = parseQemuOutput(measurementOutput);
  const correctnessStates = parseVaporStateCheckpoints(correctnessOutput);
  const measurementStates = parseVaporStateCheckpoints(measurementOutput);
  const reasons: string[] = [
    ...(correctness.status === "invalid"
      ? correctness.reasons.map((reason) => `correctness: ${reason}`)
      : []),
    ...(measurement.status === "invalid"
      ? measurement.reasons.map((reason) => `measurement: ${reason}`)
      : []),
    ...(qemu.status === "invalid" ? qemu.reasons.map((reason) => `measurement: ${reason}`) : []),
    ...generatedCReplayShapeReasons("correctness", scenario, correctness, correctnessStates),
    ...generatedCReplayShapeReasons("measurement", scenario, measurement, measurementStates),
  ];

  if (correctnessOutput.split(/\r?\n/u).some((line) => line.startsWith(QEMU_OUTPUT_PREFIX))) {
    reasons.push("correctness replay emitted QEMU plugin records");
  }
  if (correctness.phases.length !== measurement.phases.length) {
    reasons.push("correctness and measurement emitted different phase counts");
  }
  for (let index = 0; index < Math.max(correctness.phases.length, measurement.phases.length); index += 1) {
    const left = correctness.phases[index];
    const right = measurement.phases[index];
    if (!left || !right) continue;
    if (left.scenarioId !== right.scenarioId || left.phase !== right.phase ||
        left.phaseId !== right.phaseId || left.iteration !== right.iteration) {
      reasons.push(`correctness/measurement phase ${index} identity differs`);
    }
    if (left.drawListHash !== right.drawListHash) {
      reasons.push(`correctness/measurement DrawList differs after phase ${left.phase}`);
    }
  }

  if (correctnessStates.records.length !== measurementStates.records.length) {
    reasons.push("correctness and measurement emitted different state checkpoint counts");
  }
  for (let index = 0;
    index < Math.max(correctnessStates.records.length, measurementStates.records.length);
    index += 1) {
    const left = correctnessStates.records[index];
    const right = measurementStates.records[index];
    if (!left || !right) continue;
    if (left.scenarioId !== right.scenarioId || left.frame !== right.frame) {
      reasons.push(`correctness/measurement state checkpoint ${index} identity differs`);
    }
    if (left.stateHash !== right.stateHash) {
      reasons.push(`correctness/measurement state differs at checkpoint ${left.frame}`);
    }
  }

  if (correctness.complete && measurement.complete) {
    if (correctness.complete.scenarioId !== measurement.complete.scenarioId ||
        correctness.complete.suite !== measurement.complete.suite ||
        correctness.complete.framework !== measurement.complete.framework) {
      reasons.push("correctness/measurement complete identity differs");
    }
    if (correctness.complete.finalDrawListHash !== measurement.complete.finalDrawListHash) {
      reasons.push("correctness/measurement final DrawList differs");
    }
    if (correctness.complete.finalStateHash !== measurement.complete.finalStateHash) {
      reasons.push("correctness/measurement final state differs");
    }
    if (correctness.complete.effectHash !== measurement.complete.effectHash) {
      reasons.push("correctness/measurement effects differ");
    }
  }

  if (qemu.measurements.length !== measurement.phases.length) {
    reasons.push(
      `measurement QEMU emitted ${qemu.measurements.length} phases; ` +
        `guest emitted ${measurement.phases.length}`,
    );
  }
  for (let index = 0; index < Math.max(qemu.measurements.length, measurement.phases.length); index += 1) {
    const counter = qemu.measurements[index];
    const phase = measurement.phases[index];
    if (!counter || !phase) continue;
    if (counter.phase_id !== phase.phaseId || counter.iteration !== phase.iteration) {
      reasons.push(`measurement QEMU phase ${index} identity differs from guest phase`);
    }
    if (counter.vcpu !== 0) reasons.push(`measurement QEMU phase ${index} used unexpected vCPU ${counter.vcpu}`);
    if (qemu.terminal?.event === "complete" && counter.target !== qemu.terminal.target) {
      reasons.push(`measurement QEMU phase ${index} target differs from terminal`);
    }
  }
  return { correctness, measurement, qemu, reasons: unique(reasons) };
}

/** Strictly bind generated-C state observations to the independent Vue Vapor oracle. */
export function vaporGuestStateParityReasons(
  scenario: ScenarioV1,
  output: string,
  guestFinalStateHash: string | null,
  native: Pick<VaporNativeResult, "finalStateDigest" | "checkpointStateDigests">,
): string[] {
  const parsed = parseVaporStateCheckpoints(output);
  const reasons = [...parsed.reasons];
  const expectedFrames = stateCheckpointFrames(scenario);
  if (parsed.records.length !== expectedFrames.length) {
    reasons.push(
      `generated-C emitted ${parsed.records.length} state checkpoints; expected ${expectedFrames.length}`,
    );
  }
  const seen = new Set<number>();
  parsed.records.forEach((record, index) => {
    const expectedFrame = expectedFrames[index];
    if (record.scenarioId !== scenario.id) {
      reasons.push(`generated-C state checkpoint ${record.frame} has a different scenarioId`);
    }
    if (record.frame >= scenario.frames) {
      reasons.push(`generated-C state checkpoint ${record.frame} is outside the scenario`);
    }
    if (seen.has(record.frame)) reasons.push(`generated-C state checkpoint ${record.frame} is duplicated`);
    seen.add(record.frame);
    if (expectedFrame !== undefined && record.frame !== expectedFrame) {
      reasons.push(
        `generated-C state checkpoint ${index} is frame ${record.frame}; expected ${expectedFrame}`,
      );
    }
    const expectedHash = native.checkpointStateDigests[String(record.frame)];
    if (!expectedHash) {
      reasons.push(`Vue Vapor oracle has no state checkpoint ${record.frame}`);
    } else if (record.stateHash !== expectedHash) {
      reasons.push(`generated-C state differs from Vue Vapor oracle at checkpoint ${record.frame}`);
    }
  });
  for (const frame of expectedFrames) {
    if (!Object.hasOwn(native.checkpointStateDigests, String(frame))) {
      reasons.push(`Vue Vapor oracle omitted declared state checkpoint ${frame}`);
    }
  }
  if (!guestFinalStateHash) {
    reasons.push("generated-C did not emit a final state hash");
  } else if (guestFinalStateHash !== native.finalStateDigest) {
    reasons.push("generated-C final state differs from Vue Vapor oracle");
  }
  const finalCheckpoint = parsed.records.find((record) => record.frame === scenario.frames - 1);
  if (finalCheckpoint && guestFinalStateHash && finalCheckpoint.stateHash !== guestFinalStateHash) {
    reasons.push("generated-C final state differs between checkpoint and complete records");
  }
  return unique(reasons);
}

async function runQemu(
  options: RunVaporScenarioOptions & { readonly executor: Exclude<VaporExecutor, "native"> },
  events: readonly VaporEvent[],
  profile: TargetProfile,
): Promise<VaporQemuResult | VaporInvalidResult> {
  const checkpointReasons = qemuStateCheckpointReasons(options.scenario);
  if (checkpointReasons.length > 0) return invalid(options.executor, checkpointReasons);
  const native = await runNative({ ...options, executor: "native" }, events, profile);
  if (native.status !== "ok") return invalid(options.executor, native.reasons);

  let fixture: PreparedVaporQemuFixture;
  try {
    fixture = await prepareVaporQemuFixture(options, events);
  } catch (error) {
    return invalid(options.executor, [error instanceof Error ? error.message : String(error)]);
  }
  const image = options.image ?? "pocketjs-perf-qemu:11.0.3";
  const defines = [
    `-DVP_GRID_W=${fixture.profile.width}`,
    `-DVP_GRID_H=${fixture.profile.height}`,
    `-DVP_STR_CAP=${fixture.profile.strCap}`,
    `-DVP_VIEW_CAP=${fixture.profile.poolCap}`,
  ];
  const compile = dockerCommand(image, fixture.directory, [
    fixture.build.compiler,
    ...fixture.build.cFlags,
    ...defines,
    "-I/work",
    "-I/opt/pocketjs-perf-qemu",
    "/work/gen_app.c",
    "/work/vapor_core.c",
    "/work/vapor_perf_guest.c",
    ...fixture.build.linkerFlags,
    "-o",
    `/work/${basename(fixture.elfPath)}`,
  ]);
  if (compile.exitCode !== 0) {
    return invalid(options.executor, [
      `Vapor ${options.executor} compile failed (${compile.exitCode})`,
      compile.stderr.trim() || compile.stdout.trim(),
    ]);
  }

  const correctnessRun = dockerCommand(image, fixture.directory, [
    fixture.build.emulator,
    ...fixture.build.cpuArgs,
    ...fixture.build.emulatorArgs,
    `/work/${basename(fixture.elfPath)}`,
    "--correctness",
  ]);
  const measurementRun = dockerCommand(image, fixture.directory, [
    fixture.build.emulator,
    ...fixture.build.cpuArgs,
    ...fixture.build.emulatorArgs,
    "-d", "plugin",
    "-plugin", "/opt/pocketjs-perf-qemu/build/pocketjs-perf-counter.so",
    `/work/${basename(fixture.elfPath)}`,
  ]);
  const correctnessOutput = combinedProcessOutput(correctnessRun);
  const measurementOutput = combinedProcessOutput(measurementRun);
  writeFileSync(join(fixture.directory, "correctness.log"), correctnessOutput);
  writeFileSync(join(fixture.directory, "measurement-replay.log"), measurementOutput);
  const replay = vaporQemuReplayReasons(options.scenario, correctnessOutput, measurementOutput);
  const reasons: string[] = [];
  if (correctnessRun.exitCode !== 0) {
    reasons.push(`Vapor ${options.executor} correctness guest failed (${correctnessRun.exitCode})`);
  }
  if (measurementRun.exitCode !== 0) {
    reasons.push(`Vapor ${options.executor} measurement guest failed (${measurementRun.exitCode})`);
  }
  reasons.push(...replay.reasons);
  for (const [label, output, guest] of [
    ["correctness", correctnessOutput, replay.correctness],
    ["measurement", measurementOutput, replay.measurement],
  ] as const) {
    reasons.push(...vaporGuestStateParityReasons(
      options.scenario,
      output,
      guest.complete?.finalStateHash ?? null,
      native,
    ).map((reason) => `${label}: ${reason}`));
    if (guest.complete) {
      if (guest.complete.finalDrawListHash !== native.finalDrawListHash) {
        reasons.push(
          `${label}: generated-C final grid ${guest.complete.finalDrawListHash} ` +
            `differs from Vue Vapor oracle ${native.finalDrawListHash}`,
        );
      }
      if (guest.complete.effectHash !== native.finalEffectDigest) {
        reasons.push(`${label}: generated-C delivered-event digest differs from the Vue Vapor oracle`);
      }
    }
    for (const phase of guest.phases) {
      const expected = native.phaseDrawListHashes[phase.phase];
      if (!expected) {
        reasons.push(`${label}: Vue Vapor oracle has no phase ${phase.phase}`);
      } else if (phase.drawListHash !== expected) {
        reasons.push(`${label}: generated-C grid differs from Vue Vapor oracle after phase ${phase.phase}`);
      }
    }
  }
  const correctnessTrace = replay.correctness.complete?.framebufferTraceHash;
  if (correctnessTrace && correctnessTrace !== native.framebufferHash) {
    reasons.push("generated-C correctness framebuffer trace differs from the Vue Vapor oracle");
  }
  for (const measurement of replay.qemu.measurements) {
    if (measurement.target !== fixture.build.qemuTarget) {
      reasons.push(`measurement QEMU target ${measurement.target} differs from ${fixture.build.qemuTarget}`);
    }
  }
  if (replay.qemu.terminal?.event === "complete" &&
      replay.qemu.terminal.target !== fixture.build.qemuTarget) {
    reasons.push(`measurement QEMU terminal target differs from ${fixture.build.qemuTarget}`);
  }
  const diagnosticOutput = [
    "--- generated-C correctness replay ---",
    correctnessOutput,
    "--- generated-C measurement replay ---",
    measurementOutput,
  ].join("\n");
  if (reasons.length > 0) return invalid(options.executor, reasons, diagnosticOutput);

  const protocolOutput = [
    ...correctnessOutput.split(/\r?\n/u).filter((line) =>
      line.startsWith(GUEST_OUTPUT_PREFIX) || line.startsWith(VAPOR_STATE_OUTPUT_PREFIX)
    ),
    ...measurementOutput.split(/\r?\n/u).filter((line) => line.startsWith(QEMU_OUTPUT_PREFIX)),
  ].join("\n") + "\n";

  const sizeTool = fixture.build.compiler.replace(/gcc$/, "size");
  const size = dockerCommand(image, fixture.directory, [sizeTool, "-A", `/work/${basename(fixture.elfPath)}`]);
  if (size.exitCode !== 0) {
    return invalid(options.executor, [
      `cannot inspect Vapor ELF sections (${size.exitCode})`,
      size.stderr.trim() || size.stdout.trim(),
    ], diagnosticOutput);
  }
  let textRodata: number;
  try {
    textRodata = elfTextRodata(size.stdout);
  } catch (error) {
    return invalid(options.executor, [error instanceof Error ? error.message : String(error)], diagnosticOutput);
  }
  return {
    status: "ok",
    executor: options.executor,
    combinedOutput: protocolOutput,
    framebufferHash: correctnessTrace!,
    // Receipts use the richer DOM hash; accepting it is safe only because the
    // generated-C final/checkpoint debug state was matched above.
    stateHash: native.stateHash,
    effectHash: native.effectHash,
    finalDrawListHash: replay.correctness.complete!.finalDrawListHash,
    elfPath: fixture.elfPath,
    artifactMetrics: { "artifact.elf_text_rodata_bytes": textRodata },
    build: fixture.build,
  };
}

/**
 * Run the real Vue Vapor correctness oracle or its allocation-free generated-C
 * Linux guest. Relative-axis samples stay on RelativeAxis/onAxisDelta and are
 * never translated into button presses.
 */
export async function runVaporScenario(options: RunVaporScenarioOptions): Promise<VaporScenarioResult> {
  const reasons = validateScenario(options.scenario);
  const sourceRoot = resolve(options.sourceRoot);
  const profile = profileForEntry(sourceRoot, options.scenario.subject.entry);
  if (!profile) reasons.push(`Vapor oracle has no real Vue entry adapter for ${options.scenario.subject.entry}`);
  else if (!existsSync(profile.benchmarkEntry)) reasons.push(`missing Vapor benchmark source ${profile.benchmarkEntry}`);
  for (const path of [
    join(sourceRoot, options.scenario.subject.entry),
    join(sourceRoot, "vapor/compiler/compile.ts"),
    join(sourceRoot, "vapor/oracle/boot.ts"),
    join(sourceRoot, "vapor/runtime/vapor.h"),
    join(sourceRoot, "vapor/runtime/vapor_core.c"),
  ]) {
    if (!existsSync(path)) reasons.push(`missing Vapor source input ${path}`);
  }
  const built = buildEvents(options.scenario);
  reasons.push(...built.reasons);
  if (reasons.length > 0 || !profile) return invalid(options.executor, reasons);
  if (options.executor === "native") return await runNative(options, built.events, profile);
  return await runQemu(
    options as RunVaporScenarioOptions & { readonly executor: Exclude<VaporExecutor, "native"> },
    built.events,
    profile,
  );
}
