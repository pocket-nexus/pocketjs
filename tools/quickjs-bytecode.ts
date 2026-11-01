// tools/quickjs-bytecode.ts — compile a variant's bundles to QuickJS bytecode
// with a host-native compiler built from the engine source the target embeds
// (contracts/spec/quickjs-bytecode.ts).
//
// The source comes from POCKETJS_QUICKJS_SOURCE, the directory an ESP-IDF
// build already holds through its component manager, or from a checkout of
// the ABI's pinned revision under the pocket-nexus cache. Either way the
// files are verified against the ABI before the compiler is built from
// them, and the compiler reads every object back before it writes it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  encodeBytecodeEnvelope,
  POCKET_SECTION,
  type PocketPackageSection,
  type PocketPackageVariant,
} from "../contracts/spec/pocket-package.ts";
import { quickJsEngineAbiByName, type QuickJsEngineAbi } from "../contracts/spec/quickjs-bytecode.ts";
import { mustRunCommand, runCommand } from "./native-source.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const COMPILER_SOURCE = join(ROOT, "tools/quickjs-bytecode-compiler.c");
/** The translation units of a QuickJS-NG checkout the compiler links. */
const ENGINE_SOURCES = ["quickjs.c", "dtoa.c", "libregexp.c", "libunicode.c"];

export interface QuickJsSource {
  readonly abi: QuickJsEngineAbi;
  /** The directory holding quickjs.h and the engine translation units. */
  readonly directory: string;
}

export interface QuickJsBytecodeOptions {
  /** Build products: the compiler binary and scratch files. */
  readonly buildDirectory?: string;
  /** A verified engine source the caller found, for offline tests. */
  readonly engineSource?: QuickJsSource;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CompiledQuickJsBytecode {
  readonly abi: QuickJsEngineAbi;
  /** The serialized QuickJS object. */
  readonly bytecode: Uint8Array;
  /** The whole section: envelope and object. */
  readonly section: Uint8Array;
}

const cacheRoot = (env: NodeJS.ProcessEnv) => env.POCKET_NEXUS_CACHE?.trim() || join(homedir(), ".cache/pocket-nexus");
const cachedCheckout = (abi: QuickJsEngineAbi, env: NodeJS.ProcessEnv) =>
  join(cacheRoot(env), "sources", `${abi.descriptor.engine.family}-${abi.descriptor.engine.revision}`);

/** The version quickjs.h declares, as `major.minor.patch`. */
function headerVersion(directory: string): string | undefined {
  let header: string;
  try {
    header = readFileSync(join(directory, "quickjs.h"), "utf8");
  } catch {
    return undefined;
  }
  const part = (name: string) => header.match(new RegExp(`#define QJS_VERSION_${name} (\\d+)`))?.[1];
  const [major, minor, patch] = [part("MAJOR"), part("MINOR"), part("PATCH")];
  return major && minor && patch ? `${major}.${minor}.${patch}` : undefined;
}

/** `directory` holds the engine the ABI describes: this tool knows the
 *  QuickJS-NG layout, whose header states its version. */
function verifiedSource(abi: QuickJsEngineAbi, directory: string): QuickJsSource | undefined {
  if (abi.descriptor.engine.family !== "quickjs-ng") return undefined;
  if (!ENGINE_SOURCES.every((file) => existsSync(join(directory, file)))) return undefined;
  if (headerVersion(directory) !== abi.descriptor.engine.version) return undefined;
  return { abi, directory };
}

/** Find the engine source without network or filesystem changes. */
export function findQuickJsSource(abi: QuickJsEngineAbi, env: NodeJS.ProcessEnv = process.env): QuickJsSource | undefined {
  const named = env.POCKETJS_QUICKJS_SOURCE?.trim();
  if (named) {
    const source = verifiedSource(abi, resolve(named));
    if (source) return source;
  }
  return verifiedSource(abi, cachedCheckout(abi, env));
}

/** The engine source, cloned at the ABI's pinned revision when no verified
 *  copy exists yet. */
export function ensureQuickJsSource(abi: QuickJsEngineAbi, env: NodeJS.ProcessEnv = process.env): QuickJsSource {
  const found = findQuickJsSource(abi, env);
  if (found) return found;
  const named = env.POCKETJS_QUICKJS_SOURCE?.trim();
  if (named) {
    throw new Error(`quickjs bytecode: POCKETJS_QUICKJS_SOURCE=${named} does not hold ${abi.descriptor.engine.family} ${abi.descriptor.engine.version}`);
  }
  const root = cachedCheckout(abi, env);
  if (existsSync(root)) throw new Error(`quickjs bytecode: ${root} is not the pinned ${abi.descriptor.engine.family} checkout; remove it`);
  mkdirSync(dirname(root), { recursive: true });
  mustRunCommand("quickjs bytecode", "git", ["clone", "--filter=blob:none", "--no-checkout", abi.descriptor.engine.repository, root], dirname(root), env);
  mustRunCommand("quickjs bytecode", "git", ["-C", root, "checkout", "--detach", abi.descriptor.engine.revision], root, env);
  const source = verifiedSource(abi, root);
  if (!source) throw new Error(`quickjs bytecode: ${root} at ${abi.descriptor.engine.revision} is not ${abi.descriptor.engine.version}`);
  return source;
}

/** One compiler binary per compiler source, engine source and build host. */
function compilerKey(source: QuickJsSource): string {
  const hash = createHash("sha256").update(readFileSync(COMPILER_SOURCE)).update("\0").update(source.abi.sha256).update("\0");
  for (const file of ["quickjs.h", ...ENGINE_SOURCES]) hash.update(readFileSync(join(source.directory, file))).update("\0");
  return hash.update(`${process.platform}-${process.arch}`).digest("hex").slice(0, 20);
}

function buildCompiler(source: QuickJsSource, buildDirectory: string, env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") throw new Error("quickjs bytecode: the compiler builds on macOS and Linux hosts");
  const directory = join(buildDirectory, "compiler");
  mkdirSync(directory, { recursive: true });
  const output = join(directory, `pocket-qjsc-${compilerKey(source)}`);
  if (existsSync(output)) return output;
  const cc = env.CC?.trim() || Bun.which("cc") || Bun.which("clang");
  if (!cc) throw new Error("quickjs bytecode: a C compiler (cc or clang) is required");
  const temporary = `${output}.building-${process.pid}`;
  const args = [
    "-std=gnu11",
    "-O2",
    ...source.abi.descriptor.build.defines.map((define) => `-D${define}`),
    `-I${source.directory}`,
    COMPILER_SOURCE,
    ...ENGINE_SOURCES.map((file) => join(source.directory, file)),
    "-lm",
    "-pthread",
    ...(process.platform === "linux" ? ["-ldl"] : []),
    "-o",
    temporary,
  ];
  const result = runCommand(cc, args, ROOT, env);
  if (result.exitCode !== 0) {
    rmSync(temporary, { force: true });
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`quickjs bytecode: compiler build failed (${result.exitCode})${detail ? `:\n${detail}` : ""}`);
  }
  try {
    renameSync(temporary, output);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (!existsSync(output)) throw error;
  }
  return output;
}

/** Compile one classic script (without its NUL) for `abi`. */
export function compileQuickJsBytecode(abi: QuickJsEngineAbi, javaScript: Uint8Array, options: QuickJsBytecodeOptions = {}): CompiledQuickJsBytecode {
  const env = options.env ?? process.env;
  const source = options.engineSource ?? ensureQuickJsSource(abi, env);
  if (source.abi.sha256 !== abi.sha256) throw new Error(`quickjs bytecode: the source is ${source.abi.name}, not ${abi.name}`);
  const buildDirectory = resolve(options.buildDirectory ?? join(process.cwd(), ".pocket-build/quickjs-bytecode"));
  mkdirSync(buildDirectory, { recursive: true });
  const compiler = buildCompiler(source, buildDirectory, env);
  const run = mkdtempSync(join(buildDirectory, "run-"));
  const input = join(run, "input.js");
  const output = join(run, "output.qjbc");
  try {
    writeFileSync(input, javaScript);
    const { serialization } = abi.descriptor;
    const args = [input, output, serialization.strict ? "strict" : "sloppy"];
    if (serialization.writeFlags.includes("JS_WRITE_OBJ_STRIP_SOURCE")) args.push("strip-source");
    mustRunCommand("quickjs bytecode", compiler, args, run, env);
    const bytecode = new Uint8Array(readFileSync(output));
    if (bytecode.length === 0) throw new Error("quickjs bytecode: the compiler emitted an empty object");
    return { abi, bytecode, section: encodeBytecodeEnvelope({ engineAbi: abi.sha256, bytecode }) };
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

export interface WithBytecodeOptions extends QuickJsBytecodeOptions {
  /** The engine ABI's name (a host contract's `bytecode.engine`). */
  readonly engine: string;
  /** Keep the source sections beside the bytecode (the default) or drop them. */
  readonly source?: "keep" | "drop";
}

/** The variant with its UI bundle compiled into section 6 and its worker
 *  bundle, when it has one, into section 9. */
export function withBytecode(variant: PocketPackageVariant, options: WithBytecodeOptions): PocketPackageVariant {
  const abi = quickJsEngineAbiByName(options.engine);
  if (!abi) throw new Error(`quickjs bytecode: no engine ABI is named ${options.engine}`);
  const { source: sourceOption, engine: _engine, ...compileOptions } = options;
  const script = (kind: number, name: string) => {
    const section = variant.sections.find((entry) => entry.kind === kind);
    if (!section) return undefined;
    if (section.bytes.length === 0 || section.bytes[section.bytes.length - 1] !== 0) {
      throw new Error(`quickjs bytecode: the ${name} section is not NUL-terminated`);
    }
    return section.bytes.subarray(0, section.bytes.length - 1);
  };
  const ui = script(POCKET_SECTION.js, "js");
  if (!ui) throw new Error("quickjs bytecode: the variant has no js section to compile");
  const worker = script(POCKET_SECTION.workerJs, "worker");
  const compiled: PocketPackageSection[] = [
    { kind: POCKET_SECTION.bytecode, bytes: compileQuickJsBytecode(abi, ui, compileOptions).section },
    ...(worker ? [{ kind: POCKET_SECTION.workerBytecode, bytes: compileQuickJsBytecode(abi, worker, compileOptions).section }] : []),
  ];
  const dropped = new Set<number>([POCKET_SECTION.bytecode, POCKET_SECTION.workerBytecode]);
  if (sourceOption === "drop") {
    dropped.add(POCKET_SECTION.js);
    dropped.add(POCKET_SECTION.workerJs);
  }
  return { ...variant, sections: [...variant.sections.filter((section) => !dropped.has(section.kind)), ...compiled] };
}
