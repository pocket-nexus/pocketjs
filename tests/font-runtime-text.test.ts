import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRINTABLE_ASCII } from "../framework/compiler/bake-font.ts";
import { createWasmUi } from "../hosts/web/wasm-ops.js";

const repository = join(import.meta.dir, "..");
const wasmPath = join(repository, "hosts/web/pocketjs.wasm");
const missingDeclarationFixture = join(
  repository,
  "tests/fixtures/runtime-text-missing/main.tsx",
);
const LTRIGGER = 0x0100;
const RTRIGGER = 0x0200;

let outdir: string;
let wasmBytes: ArrayBuffer;

interface BuiltApp {
  bundle: string;
  pak: ArrayBuffer;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function build(app: string, name: string, extraArgs: string[] = []): BuiltApp {
  const target = join(outdir, name);
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "tools/build.ts",
      app,
      `--outdir=${target}`,
      ...extraArgs,
    ],
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `runtime text fixture build failed (exit ${result.exitCode}):\n` +
        result.stdout.toString() +
        result.stderr.toString(),
    );
  }
  return {
    bundle: readFileSync(join(target, `${app}.js`), "utf8"),
    pak: exactArrayBuffer(readFileSync(join(target, `${app}.pak`))),
  };
}

function resetGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  delete globals.ui;
  delete globals.__pak;
  delete globals.frame;
}

beforeAll(() => {
  if (!existsSync(wasmPath)) {
    throw new Error(
      "runtime text test needs hosts/web/pocketjs.wasm; run: bun tools/wasm.ts",
    );
  }
  outdir = mkdtempSync(join(tmpdir(), "pocketjs-runtime-text-"));
  wasmBytes = exactArrayBuffer(readFileSync(wasmPath));
}, 120_000);

afterAll(() => {
  resetGlobals();
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

test("host-service text requires an explicit manifest charset", () => {
  const target = join(outdir, "missing");
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "tools/build.ts",
      missingDeclarationFixture,
      `--outdir=${target}`,
    ],
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("runtime text source requires app.runtimeText");
  expect(output).toContain('{ "app": { "runtimeText": { "charset": "ascii" } } }');
  expect(output).toContain("host service input in tests/fixtures/runtime-text-missing/main.tsx");
  expect(output).toContain("capability input.text");
}, 120_000);

test("note renders a host-loaded exclamation mark with its ASCII declaration", async () => {
  const app = build("note-main", "note");
  const wasm = await createWasmUi(wasmBytes);
  let delivered = false;
  const ops = {
    ...wasm.ops,
    svcOpen: () => true,
    svcPoll: () => {
      if (delivered) return undefined;
      delivered = true;
      return [
        JSON.stringify({ t: "hello", w: 480, h: 272 }),
        JSON.stringify({ t: "load", text: "!" }),
      ].join("\n");
    },
    svcSend: () => {},
  };
  const globals = globalThis as Record<string, unknown>;
  globals.ui = ops;
  globals.__pak = app.pak;
  globals.frame = undefined;
  (0, eval)(app.bundle);
  const frame = globals.frame as ((buttons: number) => void) | undefined;
  expect(frame).toBeFunction();
  for (let index = 0; index < 5; index++) {
    frame!(0);
    wasm.tick();
  }
  const hash = fnv1a(wasm.render().slice());
  console.log(`runtime text: note load("!") frame ${hash}`);
  expect(hash).toBe("91da5283");
}, 120_000);

interface ZoomJourney {
  frames?: Uint8Array[];
  differingFrames: number[];
  readouts: Set<string>;
}

async function runZoom(
  app: BuiltApp,
  referenceFrames?: readonly Uint8Array[],
): Promise<ZoomJourney> {
  const wasm = await createWasmUi(wasmBytes);
  const readouts = new Set<string>();
  const record = (value: string) => {
    if (value.includes("%")) readouts.add(value);
  };
  const ops = {
    ...wasm.ops,
    setText(id: number, value: string) {
      record(value);
      wasm.ops.setText(id, value);
    },
    replaceText(id: number, value: string) {
      record(value);
      wasm.ops.replaceText(id, value);
    },
  };
  const globals = globalThis as Record<string, unknown>;
  globals.ui = ops;
  globals.__pak = app.pak;
  globals.frame = undefined;
  (0, eval)(app.bundle);
  const frame = globals.frame as ((buttons: number) => void) | undefined;
  if (!frame) throw new Error("zoomlab bundle did not install globalThis.frame");
  const frames = referenceFrames ? undefined : [];
  const differingFrames: number[] = [];
  for (let index = 0; index < 270; index++) {
    const buttons = index < 120 ? RTRIGGER : index < 240 ? LTRIGGER : 0;
    frame(buttons);
    wasm.tick();
    const rendered = wasm.render();
    if (referenceFrames) {
      if (!Buffer.from(rendered).equals(Buffer.from(referenceFrames[index]))) {
        differingFrames.push(index);
      }
    } else {
      frames!.push(rendered.slice());
    }
  }
  return { frames, differingFrames, readouts };
}

test("zoomlab's 270-frame numeric HUD matches a full-ASCII reference", async () => {
  const subset = await runZoom(build("zoomlab-main", "zoom-subset"));
  const fullAscii = await runZoom(
    build("zoomlab-main", "zoom-ascii", [`--extra-chars=${PRINTABLE_ASCII}`]),
    subset.frames!,
  );
  expect([...fullAscii.readouts].some((readout) => readout.includes("6"))).toBe(true);
  expect(fullAscii.differingFrames).toEqual([]);
  console.log(
    `runtime text: zoomlab 270/270 frames match full ASCII; ` +
      `${[...fullAscii.readouts].filter((readout) => readout.includes("6")).length} readout(s) contain 6`,
  );
}, 120_000);
