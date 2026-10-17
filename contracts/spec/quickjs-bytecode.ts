import { createHash } from "node:crypto";

/** The source filename is serialized into QuickJS bytecode. Keep every
 * compiler entry point on this value so identical bundles produce identical
 * bytes regardless of their checkout path. */
export const QUICKJS_BYTECODE_FILENAME = "app.js";

export interface QuickJsEngineAbiDescriptor {
  readonly schema: "pocketjs.quickjs-engine-abi/v1";
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
    readonly writeFlags: readonly ["JS_WRITE_OBJ_BYTECODE"];
  };
}

export interface QuickJsEngineAbi {
  readonly name: "psp" | "desktop";
  readonly targets: readonly string[];
  readonly descriptor: QuickJsEngineAbiDescriptor;
  readonly canonicalDescriptor: string;
  readonly sha256: `sha256:${string}`;
}

/** RFC 8785's object-key ordering is enough for this descriptor: it contains
 * only JSON primitives, arrays, and objects, with no non-integer numbers. */
export function canonicalEngineAbiDescriptor(value: QuickJsEngineAbiDescriptor): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

export function engineAbiDigest(descriptor: QuickJsEngineAbiDescriptor): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalEngineAbiDescriptor(descriptor), "utf8")
    .digest("hex")}`;
}

function engineAbi(
  name: QuickJsEngineAbi["name"],
  targets: readonly string[],
  descriptor: QuickJsEngineAbiDescriptor,
): QuickJsEngineAbi {
  return {
    name,
    targets,
    descriptor,
    canonicalDescriptor: canonicalEngineAbiDescriptor(descriptor),
    sha256: engineAbiDigest(descriptor),
  };
}

export const PSP_QUICKJS_ENGINE_ABI = engineAbi("psp", ["psp"], {
  schema: "pocketjs.quickjs-engine-abi/v1",
  binding: {
    name: "pocket-nexus/quickjs-rs:libquickjs-sys",
    version: "0.9.0",
    revision: "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b",
  },
  engine: {
    family: "quickjs",
    repository: "https://github.com/pocket-nexus/quickjs-rs.git",
    revision: "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b",
    version: "2026-06-04",
    bytecodeVersion: 5,
  },
  build: {
    defines: [
      "CONFIG_VERSION=2026-06-04",
      "_GNU_SOURCE",
      "__PSP__",
      "__psp__",
    ],
    flags: ["-funsigned-char"],
    endianness: "little",
    pointerWidth: 32,
    valueRepresentation: "nan-boxed",
  },
  serialization: {
    filename: QUICKJS_BYTECODE_FILENAME,
    evalType: "global",
    strict: false,
    evalFlags: ["JS_EVAL_TYPE_GLOBAL", "JS_EVAL_FLAG_COMPILE_ONLY"],
    writeFlags: ["JS_WRITE_OBJ_BYTECODE"],
  },
});

export const DESKTOP_QUICKJS_ENGINE_ABI = engineAbi("desktop", ["macos-app", "linux-app"], {
  schema: "pocketjs.quickjs-engine-abi/v1",
  binding: {
    name: "rquickjs-sys",
    version: "0.12.2",
    checksum: "a13ac243b86a74120814ef7e9e30ad5a2c1199b7b9963b1cf7c84e4cdc1cad99",
    revision: "635f9322ccc875e3f9851e7f75ec538cf3274fd5",
  },
  engine: {
    family: "quickjs-ng",
    repository: "https://github.com/quickjs-ng/quickjs.git",
    revision: "fd0a0210b7be00957751871e7e01b8291268fc29",
    version: "0.15.1",
    bytecodeVersion: 26,
  },
  build: {
    defines: ["_GNU_SOURCE"],
    flags: [],
    endianness: "little",
    pointerWidth: 64,
    valueRepresentation: "tagged-struct",
  },
  serialization: {
    filename: QUICKJS_BYTECODE_FILENAME,
    evalType: "global",
    strict: true,
    evalFlags: [
      "JS_EVAL_TYPE_GLOBAL",
      "JS_EVAL_FLAG_STRICT",
      "JS_EVAL_FLAG_COMPILE_ONLY",
    ],
    writeFlags: ["JS_WRITE_OBJ_BYTECODE"],
  },
});

export const QUICKJS_ENGINE_ABIS = [
  PSP_QUICKJS_ENGINE_ABI,
  DESKTOP_QUICKJS_ENGINE_ABI,
] as const;

export function quickJsEngineAbiForTarget(target: string): QuickJsEngineAbi | undefined {
  return QUICKJS_ENGINE_ABIS.find((abi) => abi.targets.includes(target));
}
