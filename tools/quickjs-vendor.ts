// tools/quickjs-vendor.ts — QuickJS translation units compiled once per
// checkout. Five host tests link the vendored QuickJS (quickjs.c alone is
// 55k lines) into a C harness; each compiled it into its own run directory,
// so the suite paid for the same objects five times. Objects live under
// .pocket-build/cache/quickjs-vendor/<hash>/, keyed by the compiler, its
// flags and the bytes of every source and header in the QuickJS directory:
// a changed pin or flag misses the cache, nothing is ever reused across them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const CACHE = join(root, ".pocket-build/cache/quickjs-vendor");

/** The vendored QuickJS directory of the workspace's locked rquickjs-sys crate. */
export function lockedQuickJsSources(toolchain = "stable"): string {
  const result = Bun.spawnSync(["cargo", `+${toolchain}`, "metadata", "--locked", "--format-version=1", "--manifest-path", join(root, "Cargo.toml")], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`cargo metadata failed:\n${result.stderr.toString()}`);
  const metadata = JSON.parse(result.stdout.toString()) as { packages: { name: string; manifest_path: string }[] };
  const dependency = metadata.packages.find((p) => p.name === "rquickjs-sys");
  if (!dependency) throw new Error("the locked workspace has no rquickjs-sys package");
  return join(dirname(dependency.manifest_path), "quickjs");
}

export interface QuickJsVendorBuild {
  /** C compiler executable. */
  readonly cc: string;
  /** Directory holding quickjs.c and its headers. */
  readonly quickjs: string;
  /** Translation units to compile, without the .c suffix. */
  readonly units: readonly string[];
  /** Flags placed before the source file; `-c`, `-I <quickjs>` and `-o` are added. */
  readonly flags: readonly string[];
  /** Receives each compiler invocation and its output, for a test's command log. */
  readonly log?: (command: readonly string[], output: string) => void;
}

function compilerIdentity(cc: string): string {
  const result = Bun.spawnSync([cc, "--version"], { stdout: "pipe", stderr: "pipe" });
  return `${cc}\n${result.stdout.toString()}${result.stderr.toString()}`;
}

function sourceDigest(quickjs: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(quickjs).filter((n) => n.endsWith(".c") || n.endsWith(".h")).sort()) {
    hash.update(name).update("\0").update(readFileSync(join(quickjs, name))).update("\0");
  }
  return hash.digest("hex");
}

/** Compile the units that are not cached yet and return every object path.
 * A unit compiles to a temporary name and is renamed into place, so a
 * concurrent caller sees either no object or a complete one. */
export function quickJsVendorObjects(build: QuickJsVendorBuild): string[] {
  const key = createHash("sha256")
    .update(compilerIdentity(build.cc)).update("\0")
    .update(JSON.stringify(build.flags)).update("\0")
    .update(sourceDigest(build.quickjs))
    .digest("hex").slice(0, 16);
  const directory = join(CACHE, key);
  mkdirSync(directory, { recursive: true });
  return build.units.map((unit) => {
    const object = join(directory, `${unit}.o`);
    if (existsSync(object)) return object;
    const partial = join(directory, `${unit}.${process.pid}.o.tmp`);
    const command = [build.cc, ...build.flags, "-I", build.quickjs, "-c", join(build.quickjs, `${unit}.c`), "-o", partial];
    const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const output = result.stdout.toString() + result.stderr.toString();
    build.log?.(command, output);
    if (!result.success) throw new Error(`${build.cc} failed on ${unit}.c (signal=${result.signalCode})\n${output}`);
    renameSync(partial, object);
    return object;
  });
}
