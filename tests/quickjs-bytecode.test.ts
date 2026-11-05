import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeBytecodeEnvelope,
  encodeBytecodeEnvelope,
  encodeIdentity,
  POCKET_BYTECODE_HEADER_SIZE,
  POCKET_SECTION,
  type PocketPackageVariant,
} from "../contracts/spec/pocket-package.ts";
import {
  canonicalEngineAbiDescriptor,
  engineAbiDigest,
  ESP_IDF_QUICKJS_NG_0_14_0,
  quickJsEngineAbiByName,
  quickJsEngineAbiHeader,
  quickJsEngineAbiSymbol,
} from "../contracts/spec/quickjs-bytecode.ts";
import { compileQuickJsBytecode, findQuickJsSource, withBytecode } from "../tools/quickjs-bytecode.ts";

const root = resolve(import.meta.dir, "..");
const abi = ESP_IDF_QUICKJS_NG_0_14_0;
const text = (value: string) => new TextEncoder().encode(value);

describe("quickjs bytecode", () => {
  test("the envelope round-trips and refuses other shapes", () => {
    const section = encodeBytecodeEnvelope({ engineAbi: abi.sha256, bytecode: new Uint8Array([25, 1, 2, 3]) });
    expect(section.length).toBe(POCKET_BYTECODE_HEADER_SIZE + 4);
    const decoded = decodeBytecodeEnvelope(section);
    expect(decoded.engineAbi).toBe(abi.sha256);
    expect([...decoded.bytecode]).toEqual([25, 1, 2, 3]);
    expect(() => encodeBytecodeEnvelope({ engineAbi: abi.sha256, bytecode: new Uint8Array() })).toThrow("empty");
    expect(() => decodeBytecodeEnvelope(section.subarray(0, POCKET_BYTECODE_HEADER_SIZE))).toThrow("truncated");
    const other = section.slice();
    other[0] ^= 0xff;
    expect(() => decodeBytecodeEnvelope(other)).toThrow("magic");
    const flagged = section.slice();
    flagged[12] = 1;
    expect(() => decodeBytecodeEnvelope(flagged)).toThrow("flags");
  });

  test("an engine ABI is named by the SHA-256 of its key-sorted descriptor", () => {
    expect(abi.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const { descriptor } = abi;
    const reordered = {
      serialization: descriptor.serialization,
      build: descriptor.build,
      engine: descriptor.engine,
      binding: descriptor.binding,
      schema: descriptor.schema,
    };
    expect(canonicalEngineAbiDescriptor(reordered)).toBe(abi.canonicalDescriptor);
    expect(engineAbiDigest(reordered)).toBe(abi.sha256);
    expect(engineAbiDigest({ ...descriptor, engine: { ...descriptor.engine, bytecodeVersion: 26 } })).not.toBe(abi.sha256);
    expect(quickJsEngineAbiByName(abi.name)).toBe(abi);
    expect(quickJsEngineAbiByName("desktop")).toBeUndefined();
    const header = quickJsEngineAbiHeader();
    expect(quickJsEngineAbiSymbol(abi)).toBe("POCKET_QUICKJS_ENGINE_ABI_ESP_IDF_QUICKJS_NG_0_14_0");
    expect(header).toContain(`${quickJsEngineAbiSymbol(abi)}[32] = {0x${abi.sha256.slice(7, 9)}`);
    expect(header).toContain("#define POCKET_BYTECODE_HEADER_SIZE 48u");
  });

  const source = findQuickJsSource(abi);
  test.skipIf(!Bun.which("cc") || !source)(
    "the compiler built from the pinned engine emits deterministic bytecode the engine reads back",
    () => {
      const buildDirectory = resolve(root, `.pocket-build/validation/quickjs-bytecode/${Date.now()}-${process.pid}`);
      mkdirSync(buildDirectory, { recursive: true });
      const compiled = compileQuickJsBytecode(abi, text("globalThis.answer = 6 * 7;"), { buildDirectory, engineSource: source });
      expect(compiled.bytecode[0]).toBe(abi.descriptor.engine.bytecodeVersion);
      expect(decodeBytecodeEnvelope(compiled.section).engineAbi).toBe(abi.sha256);
      const again = compileQuickJsBytecode(abi, text("globalThis.answer = 6 * 7;"), { buildDirectory, engineSource: source });
      expect(again.section).toEqual(compiled.section);
      expect(() => compileQuickJsBytecode(abi, text("globalThis.answer = ;"), { buildDirectory, engineSource: source })).toThrow("compile");

      const variant: PocketPackageVariant = {
        target: "fixture",
        hostAbi: 12,
        profileHash: `sha256:${"11".repeat(32)}`,
        sections: [
          { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: "app", id: "test.app", title: "App" }) },
          { kind: POCKET_SECTION.js, bytes: text("globalThis.frame = () => {};\0") },
          { kind: POCKET_SECTION.workerJs, bytes: text("globalThis.worker = 1;\0") },
        ],
      };
      const kinds = (value: PocketPackageVariant) => value.sections.map((section) => section.kind).sort((a, b) => a - b);
      const kept = withBytecode(variant, { engine: abi.name, buildDirectory, engineSource: source });
      expect(kinds(kept)).toEqual([1, 3, 6, 8, 9]);
      const dropped = withBytecode(variant, { engine: abi.name, source: "drop", buildDirectory, engineSource: source });
      expect(kinds(dropped)).toEqual([1, 6, 9]);
      expect(kinds(variant)).toEqual([1, 3, 8]);
      expect(() => withBytecode(variant, { engine: "no-such-engine", buildDirectory, engineSource: source })).toThrow("no engine ABI");
    },
    180_000,
  );
});
