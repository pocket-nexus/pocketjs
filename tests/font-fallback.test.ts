import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseFont } from "opentype.js";
import {
  FONT_CMAP_ENTRY_SIZE,
  FONT_HEADER_SIZE,
} from "../contracts/spec/spec.ts";
import { unpack, type PakBlob } from "../framework/compiler/pak.ts";
import { DEFAULT_REGULAR } from "../framework/compiler/bake-font.ts";
import { createWasmUi } from "../hosts/web/wasm-ops.js";

const repository = join(import.meta.dir, "..");
const fixture = join(repository, "tests/fixtures/font-fallback/main.tsx");
const wasmPath = join(repository, "hosts/web/pocketjs.wasm");
const runtimeCodepoint = 0x7e;
const replacementCodepoint = 0xfffd;
const runtimeCharacter = String.fromCodePoint(runtimeCodepoint);
const replacementCharacter = String.fromCodePoint(replacementCodepoint);

let outdir: string;
let bundle: string;
let pak: ArrayBuffer;
let atlas: PakBlob;
let fontSlot: number;
let wasmBytes: ArrayBuffer;

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function cmap(blob: Uint8Array): Map<number, number> {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const glyphCount = view.getUint16(6, true);
  const entries = new Map<number, number>();
  for (let index = 0; index < glyphCount; index++) {
    const offset = FONT_HEADER_SIZE + index * FONT_CMAP_ENTRY_SIZE;
    entries.set(view.getUint32(offset, true), view.getUint16(offset + 4, true));
  }
  return entries;
}

function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

beforeAll(() => {
  if (!existsSync(wasmPath)) {
    throw new Error("font fallback test needs hosts/web/pocketjs.wasm; run: bun tools/wasm.ts");
  }
  outdir = mkdtempSync(join(tmpdir(), "pocketjs-font-fallback-"));
  const build = Bun.spawnSync({
    cmd: [
      process.execPath,
      "tools/build.ts",
      fixture,
      "--no-config",
      `--outdir=${outdir}`,
    ],
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(
      `font fallback fixture build failed (exit ${build.exitCode}):\n` +
        build.stdout.toString() +
        build.stderr.toString(),
    );
  }

  bundle = readFileSync(join(outdir, "main.js"), "utf8");
  pak = exactArrayBuffer(readFileSync(join(outdir, "main.pak")));
  const fonts = unpack(new Uint8Array(pak)).filter((entry) =>
    entry.key.startsWith("ui:font."),
  );
  expect(fonts).toHaveLength(1);
  atlas = fonts[0];
  fontSlot = atlas.data[12];
  wasmBytes = exactArrayBuffer(readFileSync(wasmPath));
}, 120_000);

afterAll(() => {
  if (outdir) rmSync(outdir, { recursive: true, force: true });
  const globals = globalThis as Record<string, unknown>;
  delete globals.ui;
  delete globals.__pak;
  delete globals.frame;
  delete globals.__fontFallbackCodepoint;
});

async function renderFixture(replacement?: string): Promise<{
  frame: Uint8Array;
  requested: string[];
  measuredWidth: number;
}> {
  const wasm = await createWasmUi(wasmBytes);
  const requested: string[] = [];
  const rewrite = (value: string): string =>
    replacement === undefined
      ? value
      : value.replaceAll(runtimeCharacter, replacement);
  const ops = {
    ...wasm.ops,
    setText(id: number, value: string) {
      requested.push(value);
      wasm.ops.setText(id, rewrite(value));
    },
    replaceText(id: number, value: string) {
      requested.push(value);
      wasm.ops.replaceText(id, rewrite(value));
    },
  };
  const globals = globalThis as Record<string, unknown>;
  globals.ui = ops;
  globals.__pak = pak;
  globals.frame = undefined;
  globals.__fontFallbackCodepoint = runtimeCodepoint;
  (0, eval)(bundle);
  const frame = globals.frame as ((buttons: number) => void) | undefined;
  if (!frame) throw new Error("font fallback fixture did not install globalThis.frame");
  frame(0);
  wasm.tick();
  const measuredWidth = wasm.ops.measureText(runtimeCharacter, fontSlot);
  return { frame: wasm.render().slice(), requested, measuredWidth };
}

test("a runtime-only character renders the atlas tofu glyph", async () => {
  const entries = cmap(atlas.data);
  const sourceFont = parseFont(await Bun.file(DEFAULT_REGULAR).arrayBuffer());
  expect(sourceFont.charToGlyphIndex(runtimeCharacter)).toBeGreaterThan(0);
  expect(entries.has(runtimeCodepoint)).toBe(false);
  expect(entries.get(replacementCodepoint)).toBe(0);

  const dynamic = await renderFixture();
  expect(dynamic.requested.some((value) => value.includes(runtimeCharacter))).toBe(true);
  expect(dynamic.measuredWidth).toBe(atlas.data[8]);

  const explicitTofu = await renderFixture(replacementCharacter);
  const framesMatch = Buffer.from(dynamic.frame).equals(Buffer.from(explicitTofu.frame));
  expect(framesMatch).toBe(true);
  const empty = await renderFixture("");
  expect(Buffer.from(dynamic.frame).equals(Buffer.from(empty.frame))).toBe(false);

  const pixels = new Uint32Array(
    dynamic.frame.buffer,
    dynamic.frame.byteOffset,
    dynamic.frame.byteLength / 4,
  );
  expect(new Set(pixels).size).toBeGreaterThan(1);
  console.log(
    `font fallback: runtime request U+007E, cmap absent, U+FFFD -> gid 0, ` +
      `advance ${dynamic.measuredWidth}, frame ${fnv1a(dynamic.frame)} matches explicit tofu=${framesMatch}`,
  );
}, 120_000);
