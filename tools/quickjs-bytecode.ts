import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  DESKTOP_QUICKJS_ENGINE_ABI,
  PSP_QUICKJS_ENGINE_ABI,
  quickJsEngineAbiForTarget,
  type QuickJsEngineAbi,
} from "../contracts/spec/quickjs-bytecode.ts";
import { encodeBytecodeEnvelope } from "../contracts/spec/pocket-package.ts";
import {
  ensureQuickJsCheckout,
  mustRunCommand,
  quickJsCheckout,
  quickJsCheckoutStatus,
  runCommand,
  type QuickJsPin,
} from "./native-source.ts";
import { pocketNexusCacheRoot } from "./psp-toolchain.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const COMPILER_SOURCE = join(ROOT, "tools/quickjs-bytecode-compiler.c");

const PSP_PIN: QuickJsPin = {
  repository: PSP_QUICKJS_ENGINE_ABI.descriptor.engine.repository,
  revision: PSP_QUICKJS_ENGINE_ABI.descriptor.engine.revision,
  version: PSP_QUICKJS_ENGINE_ABI.descriptor.engine.version,
};

interface QuickJsNgPin {
  readonly repository: string;
  readonly revision: string;
  readonly version: string;
}

const DESKTOP_PIN: QuickJsNgPin = {
  repository: DESKTOP_QUICKJS_ENGINE_ABI.descriptor.engine.repository,
  revision: DESKTOP_QUICKJS_ENGINE_ABI.descriptor.engine.revision,
  version: DESKTOP_QUICKJS_ENGINE_ABI.descriptor.engine.version,
};

export interface QuickJsCompilerSource {
  readonly abi: QuickJsEngineAbi;
  readonly root: string;
  readonly source: string;
}

export interface QuickJsBytecodeCompileOptions {
  /** Build products live here; source checkouts remain in the shared verified cache. */
  readonly buildDirectory?: string;
  /** A verified source found by the caller, used by offline tests. */
  readonly compilerSource?: QuickJsCompilerSource;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CompiledQuickJsBytecode {
  readonly engineAbi: QuickJsEngineAbi;
  readonly bytecode: Uint8Array;
  /** The complete section-6 envelope ready for makeVariant. */
  readonly section: Uint8Array;
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

function pspSource(root: string): QuickJsCompilerSource | undefined {
  if (!quickJsCheckoutStatus(root, PSP_PIN).ok) return undefined;
  return {
    abi: PSP_QUICKJS_ENGINE_ABI,
    root,
    source: quickJsCheckout(root).source,
  };
}

/** Cargo adds an untracked `.cargo-ok` marker to git dependencies. Accept that
 * marker, but retain native-source.ts's exact HEAD, VERSION, and clean-source
 * requirements for every source file. */
function cargoPspSource(root: string): QuickJsCompilerSource | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  const revision = runCommand("git", ["-C", root, "rev-parse", "HEAD"], root);
  const status = runCommand(
    "git",
    ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
    root,
  );
  const changes = status.stdout.trim().split("\n").filter(Boolean);
  const version = (() => {
    try {
      return readFileSync(join(quickJsCheckout(root).source, "VERSION"), "utf8").trim();
    } catch {
      return "";
    }
  })();
  if (
    revision.exitCode !== 0 ||
    revision.stdout.trim() !== PSP_PIN.revision ||
    status.exitCode !== 0 ||
    changes.some((line) => line !== "?? .cargo-ok") ||
    version !== PSP_PIN.version
  ) return undefined;
  return { abi: PSP_QUICKJS_ENGINE_ABI, root, source: quickJsCheckout(root).source };
}

function desktopVersion(source: string): string {
  try {
    const meson = readFileSync(join(source, "meson.build"), "utf8");
    return meson.match(/version:\s*'([^']+)'/)?.[1] ?? "";
  } catch {
    return "";
  }
}

function desktopSource(root: string): QuickJsCompilerSource | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  const revision = runCommand("git", ["-C", root, "rev-parse", "HEAD"], root);
  const status = runCommand(
    "git",
    ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
    root,
  );
  if (
    revision.exitCode !== 0 ||
    revision.stdout.trim() !== DESKTOP_PIN.revision ||
    status.exitCode !== 0 ||
    status.stdout.trim() !== "" ||
    desktopVersion(root) !== DESKTOP_PIN.version
  ) return undefined;
  return { abi: DESKTOP_QUICKJS_ENGINE_ABI, root, source: root };
}

/** Find an already verified source without network or filesystem mutation. */
export function findCachedQuickJsCompilerSource(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): QuickJsCompilerSource | undefined {
  const abi = quickJsEngineAbiForTarget(target);
  if (!abi) return undefined;
  const cache = pocketNexusCacheRoot(env);
  if (abi.name === "psp") {
    const shared = pspSource(join(cache, "sources", `quickjs-rs-${PSP_PIN.revision}`));
    if (shared) return shared;
    const cargo = join(env.CARGO_HOME || join(homedir(), ".cargo"), "git/checkouts");
    for (const family of directories(cargo).filter((path) => basename(path).startsWith("quickjs-rs-"))) {
      for (const checkout of directories(family)) {
        const source = cargoPspSource(checkout);
        if (source) return source;
      }
    }
    return undefined;
  }
  return desktopSource(join(cache, "sources", `quickjs-ng-${DESKTOP_PIN.revision}`));
}

function ensureDesktopCheckout(root: string): QuickJsCompilerSource {
  const current = desktopSource(root);
  if (current) return current;
  if (existsSync(root)) {
    throw new Error(`quickjs bytecode: refusing unverified QuickJS-NG directory ${root}`);
  }
  mkdirSync(dirname(root), { recursive: true });
  mustRunCommand(
    "quickjs bytecode",
    "git",
    ["clone", "--filter=blob:none", "--no-checkout", DESKTOP_PIN.repository, root],
    dirname(root),
  );
  mustRunCommand(
    "quickjs bytecode",
    "git",
    ["-C", root, "checkout", "--detach", DESKTOP_PIN.revision],
    root,
  );
  const verified = desktopSource(root);
  if (!verified) throw new Error(`quickjs bytecode: QuickJS-NG verification failed at ${root}`);
  return verified;
}

function resolveCompilerSource(
  target: string,
  env: NodeJS.ProcessEnv,
): QuickJsCompilerSource {
  const cached = findCachedQuickJsCompilerSource(target, env);
  if (cached) return cached;
  const abi = quickJsEngineAbiForTarget(target);
  if (!abi) throw new Error(`quickjs bytecode: target ${target} has no bytecode compiler`);
  const cache = pocketNexusCacheRoot(env);
  if (abi.name === "psp") {
    const root = join(cache, "sources", `quickjs-rs-${PSP_PIN.revision}`);
    ensureQuickJsCheckout("quickjs bytecode", root, PSP_PIN);
    return pspSource(root)!;
  }
  return ensureDesktopCheckout(join(cache, "sources", `quickjs-ng-${DESKTOP_PIN.revision}`));
}

function compilerKey(abi: QuickJsEngineAbi): string {
  return createHash("sha256")
    .update(readFileSync(COMPILER_SOURCE))
    .update("\0")
    .update(abi.sha256)
    .update("\0")
    .update(`${process.platform}-${process.arch}`)
    .digest("hex")
    .slice(0, 20);
}

function compilerInputs(source: QuickJsCompilerSource): string[] {
  if (source.abi.name === "psp") {
    return ["cutils.c", "dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"]
      .map((file) => join(source.source, file));
  }
  return ["libregexp.c", "libunicode.c", "quickjs.c", "dtoa.c"]
    .map((file) => join(source.source, file));
}

function buildCompiler(
  source: QuickJsCompilerSource,
  buildDirectory: string,
  env: NodeJS.ProcessEnv,
): string {
  if (process.platform === "win32") {
    throw new Error("quickjs bytecode: the pinned native compiler supports macOS and Linux build hosts");
  }
  const directory = join(buildDirectory, "compiler");
  mkdirSync(directory, { recursive: true });
  const output = join(directory, `pocket-qjsc-${compilerKey(source.abi)}`);
  if (existsSync(output)) return output;

  const cc = env.CC?.trim() || Bun.which("cc") || Bun.which("clang");
  if (!cc) throw new Error("quickjs bytecode: a C compiler (cc or clang) is required");
  const temporary = `${output}.building-${process.pid}`;
  const args = [
    "-std=gnu11",
    "-O2",
    "-D_GNU_SOURCE",
    `-I${source.source}`,
    // qjsc is a host-native cross compiler. Its bytecode targets the ABI
    // described above, but defining __PSP__ here would compile PSP libc/FPU
    // shims into a program that runs on the build machine.
    ...(source.abi.name === "psp"
      ? [`-DCONFIG_VERSION=\"${PSP_PIN.version}\"`, "-funsigned-char"]
      : []),
    COMPILER_SOURCE,
    ...compilerInputs(source),
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

export function compileQuickJsBytecode(
  target: string,
  javaScript: Uint8Array,
  options: QuickJsBytecodeCompileOptions = {},
): CompiledQuickJsBytecode {
  const abi = quickJsEngineAbiForTarget(target);
  if (!abi) throw new Error(`quickjs bytecode: target ${target} has no bytecode compiler`);
  const env = options.env ?? process.env;
  const source = options.compilerSource ?? resolveCompilerSource(target, env);
  if (source.abi.sha256 !== abi.sha256) {
    throw new Error(`quickjs bytecode: compiler source ABI does not match target ${target}`);
  }
  const buildDirectory = resolve(options.buildDirectory ?? join(process.cwd(), ".pocket-build/quickjs-bytecode"));
  mkdirSync(buildDirectory, { recursive: true });
  const compiler = buildCompiler(source, buildDirectory, env);
  const run = mkdtempSync(join(buildDirectory, "run-"));
  const input = join(run, "input.js");
  const output = join(run, "output.qjbc");
  try {
    writeFileSync(input, javaScript);
    mustRunCommand(
      "quickjs bytecode",
      compiler,
      [input, output, abi.descriptor.serialization.strict ? "strict" : "sloppy"],
      run,
      env,
    );
    const bytecode = new Uint8Array(readFileSync(output));
    if (bytecode.length === 0) throw new Error("quickjs bytecode: compiler emitted an empty object");
    return {
      engineAbi: abi,
      bytecode,
      section: encodeBytecodeEnvelope({ engineAbi: abi.sha256, bytecode }),
    };
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}
