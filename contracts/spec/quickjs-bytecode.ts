// contracts/spec/quickjs-bytecode.ts — QuickJS bytecode engine ABIs (docs/PLATFORM.md, "Bytecode").
//
// A variant may carry its UI bundle as a serialized QuickJS object in
// section 6 and its worker bundle in section 9, beside or instead of the
// source sections 3 and 8. A serialized QuickJS object is specific to the
// engine build that reads it: the source revision, the bytecode format
// version and the build options that shape the serialized form. One such
// build is an engine ABI. Its descriptor is canonicalized and hashed; the
// digest names the ABI in a bytecode section's envelope, a guest evaluates
// the payload only when the digest is its own, and a host contract names
// the ABI its program embeds (`bytecode.engine`) so the compiler emits
// bytecode for that program.

import { createHash } from "node:crypto";
import {
  POCKET_BYTECODE_FLAGS,
  POCKET_BYTECODE_HEADER_SIZE,
  POCKET_BYTECODE_MAGIC,
  POCKET_BYTECODE_VERSION,
  POCKET_LAYOUT,
} from "./pocket-package.ts";

/** The source filename serialized into the bytecode; one value keeps
 *  identical bundles byte-identical whatever their checkout path. */
export const QUICKJS_BYTECODE_FILENAME = "app.js";

export interface QuickJsEngineAbiDescriptor {
  readonly schema: "pocketjs.quickjs-engine-abi/v1";
  /** The package or component that embeds the engine. */
  readonly binding: {
    readonly name: string;
    readonly version: string;
    readonly checksum?: string;
    readonly revision?: string;
  };
  readonly engine: {
    readonly family: "quickjs" | "quickjs-ng";
    readonly repository: string;
    readonly revision: string;
    readonly version: string;
    /** `BC_VERSION` of that source: the first byte of a serialized object. */
    readonly bytecodeVersion: number;
  };
  readonly build: {
    readonly defines: readonly string[];
    readonly flags: readonly string[];
    readonly endianness: "little" | "big";
    readonly pointerWidth: 32 | 64;
    readonly valueRepresentation: "nan-boxed" | "tagged-struct";
  };
  readonly serialization: {
    readonly filename: typeof QUICKJS_BYTECODE_FILENAME;
    readonly evalType: "global";
    readonly strict: boolean;
    readonly evalFlags: readonly string[];
    readonly writeFlags: readonly string[];
  };
}

export interface QuickJsEngineAbi {
  /** The name a host contract's `bytecode.engine` gives. */
  readonly name: string;
  readonly descriptor: QuickJsEngineAbiDescriptor;
  readonly canonicalDescriptor: string;
  readonly sha256: `sha256:${string}`;
}

/** RFC 8785's object-key ordering is enough for this descriptor: it holds
 *  only JSON primitives, arrays and objects, with no non-integer numbers. */
export function canonicalEngineAbiDescriptor(value: QuickJsEngineAbiDescriptor): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

export function engineAbiDigest(descriptor: QuickJsEngineAbiDescriptor): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalEngineAbiDescriptor(descriptor), "utf8").digest("hex")}`;
}

function engineAbi(name: string, descriptor: QuickJsEngineAbiDescriptor): QuickJsEngineAbi {
  return { name, descriptor, canonicalDescriptor: canonicalEngineAbiDescriptor(descriptor), sha256: engineAbiDigest(descriptor) };
}

/** The QuickJS-NG build every ESP-IDF program links through the
 *  `espressif/quickjs-ng` 0.14.0 component (`pocket_guest_quickjs`,
 *  `pocket_worker_esp`): 32-bit, NaN-boxed, little-endian. Bytecode for it
 *  is written without the function sources QuickJS otherwise keeps for
 *  `Function.prototype.toString`, which is the saving on the device. */
export const ESP_IDF_QUICKJS_NG_0_14_0 = engineAbi("esp-idf-quickjs-ng-0.14.0", {
  schema: "pocketjs.quickjs-engine-abi/v1",
  binding: {
    name: "espressif/quickjs-ng",
    version: "0.14.0",
    checksum: "51ead31abca34af01a44df24128e9ea10331cf35beb976a18fae62a03d36d6e2",
    revision: "0d0b99456ce9112f4ac4838927ba837949359f9b",
  },
  engine: {
    family: "quickjs-ng",
    repository: "https://github.com/quickjs-ng/quickjs.git",
    revision: "3c051980ab7e783dfbfb1c70c014ce5e05ecf24c",
    version: "0.14.0",
    bytecodeVersion: 25,
  },
  build: {
    defines: ["QUICKJS_NG_BUILD", "_GNU_SOURCE"],
    flags: ["-fno-strict-aliasing"],
    endianness: "little",
    pointerWidth: 32,
    valueRepresentation: "nan-boxed",
  },
  serialization: {
    filename: QUICKJS_BYTECODE_FILENAME,
    evalType: "global",
    strict: false,
    evalFlags: ["JS_EVAL_TYPE_GLOBAL", "JS_EVAL_FLAG_COMPILE_ONLY"],
    writeFlags: ["JS_WRITE_OBJ_BYTECODE", "JS_WRITE_OBJ_STRIP_SOURCE"],
  },
});

export const QUICKJS_ENGINE_ABIS: readonly QuickJsEngineAbi[] = [ESP_IDF_QUICKJS_NG_0_14_0];

export function quickJsEngineAbiByName(name: string): QuickJsEngineAbi | undefined {
  return QUICKJS_ENGINE_ABIS.find((abi) => abi.name === name);
}

export function quickJsEngineAbiBySha256(sha256: string): QuickJsEngineAbi | undefined {
  return QUICKJS_ENGINE_ABIS.find((abi) => abi.sha256 === sha256);
}

/** The C identifier of an ABI's digest in pocket_quickjs_abi.h. */
export function quickJsEngineAbiSymbol(abi: QuickJsEngineAbi): string {
  return `POCKET_QUICKJS_ENGINE_ABI_${abi.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** The text of contracts/generated/pocket_quickjs_abi.h: the envelope
 *  constants and every engine ABI's digest, for the guests and workers that
 *  compare a bytecode section's digest with their own. */
export function quickJsEngineAbiHeader(): string {
  const digest = (abi: QuickJsEngineAbi) => abi.sha256.slice(7).match(/../g)!.map((byte) => `0x${byte}`).join(", ");
  let out = "/* Generated by tools/quickjs-bytecode-contracts.ts from contracts/spec/quickjs-bytecode.ts. Do not edit. */\n";
  out += "#pragma once\n#include <stdint.h>\n\n";
  out += `/* A bytecode section (package sections 6 and 9): "QJBC", the envelope version, the header size, flags, the engine-ABI digest at ${POCKET_LAYOUT.bytecode.engineAbi}, then the serialized QuickJS object at ${POCKET_LAYOUT.bytecode.payload}. A guest evaluates the payload only when the digest names its own engine build. */\n`;
  out += `#define POCKET_BYTECODE_MAGIC 0x${POCKET_BYTECODE_MAGIC.toString(16)}u\n`;
  out += `#define POCKET_BYTECODE_VERSION ${POCKET_BYTECODE_VERSION}u\n`;
  out += `#define POCKET_BYTECODE_HEADER_SIZE ${POCKET_BYTECODE_HEADER_SIZE}u\n`;
  out += `#define POCKET_BYTECODE_FLAGS ${POCKET_BYTECODE_FLAGS}u\n`;
  out += `#define POCKET_BYTECODE_ENGINE_ABI_OFFSET ${POCKET_LAYOUT.bytecode.engineAbi}u\n`;
  out += "#define POCKET_BYTECODE_ENGINE_ABI_BYTES 32u\n";
  for (const abi of QUICKJS_ENGINE_ABIS) {
    const { engine, build, serialization } = abi.descriptor;
    const source = serialization.writeFlags.includes("JS_WRITE_OBJ_STRIP_SOURCE") ? "source stripped" : "source kept";
    out += `\n/* ${abi.name}: ${engine.family} ${engine.version} (${engine.revision.slice(0, 8)}), bytecode format ${engine.bytecodeVersion}, ${build.pointerWidth}-bit ${build.valueRepresentation}, ${source}. */\n`;
    out += `static const uint8_t ${quickJsEngineAbiSymbol(abi)}[32] = {${digest(abi)}};\n`;
  }
  return out;
}
