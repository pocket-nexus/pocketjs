#!/usr/bin/env bun
// Cross-version check of pocket_native_program.h, run by hand before a
// release; CI does not run it.
//
// It builds the native program archive of OLD_NATIVE_PROGRAM_CANDIDATE from a
// Git archive outside the checkout under that revision's own crate name,
// features and artifact path, builds the current pocket-native-program
// archive with the same features, and compiles
// tests/fixtures/native-program-compat/consumer.c against old headers with
// the current archive and against current headers with the old archive. The
// two archives must come from different source revisions. Both are std
// software builds: the archive supplies the six pocket_host_* hooks, no GL
// library is linked, and the consumer reads the ARGB buffer.
//
//   bun tools/test-native-program-compat.ts [--output directory]
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  abortProbe, assertDistinctSources, buildStaticlib, commandRunner, extractSnapshot, fixturePackages, hostToolchain,
  linkAndRun, OLD_SOURCE_CANDIDATE, requireRevision, ROOT, sha256, sourceRevision, writeFixtureHeaders,
} from "./release/cross-version.ts";

/** The first main-line revision with pocket_native_program.h; the header's
 * declarations other than pocket_native_package_open are unchanged since. */
export const OLD_NATIVE_PROGRAM_CANDIDATE = OLD_SOURCE_CANDIDATE;
export interface ProgramCrate {
  package: string;
  features: string;
  artifact: string;
  /** Directory of pocket_native_program.h, relative to the source root. */
  include: string;
}
/** The old crate as its own revision named it; the archive consumed as pocketjs_symbian_core. */
export const OLD_PROGRAM_CRATE: ProgramCrate = { package: "pocketjs-ui-cabi", features: "std,software-only", artifact: "libpocketjs_symbian_core.a", include: "programs/native/cabi/include" };
export const CURRENT_PROGRAM_CRATE: ProgramCrate = { package: "pocket-native-program", features: "std,software-only", artifact: "libpocket_native_program.a", include: "programs/native/runtime/include" };
const HEADER_NAMES = ["runtime", "drivers", "spec", "native_program"] as const;
const PASS = "cross-version native program API: constructors and lifecycle passed";

export interface NativeProgramCompatibilityReceipt {
  schemaVersion: 1;
  status: "candidate";
  abiFrozen: false;
  oldRevision: string;
  currentSource: { revision: string | null; dirty: boolean | null };
  oldCrate: ProgramCrate;
  currentCrate: ProgramCrate;
  compiler: string;
  cCompiler: string;
  target: string;
  oldArchiveSha256: string;
  currentArchiveSha256: string;
  headers: { old: Record<string, string>; current: Record<string, string> };
  cases: string[];
  signalProbe: { asynchronous: string; synchronous: string };
  result: "passed";
  artifactDirectory: string;
}

/** Copy the three runtime headers and pocket_native_program.h of one source root. */
function collectHeaders(root: string, include: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const name of ["runtime", "drivers", "spec"]) copyFileSync(join(root, `contracts/generated/pocket_${name}.h`), join(destination, `pocket_${name}.h`));
  copyFileSync(join(root, include, "pocket_native_program.h"), join(destination, "pocket_native_program.h"));
}

/** Compare real archives from two revisions; never replace the old implementation. */
export async function runNativeProgramCompatibility(options: { output?: string } = {}): Promise<NativeProgramCompatibilityReceipt> {
  const cc = Bun.which("cc");
  if (!cc) throw new Error("cross-version C ABI checks require a C compiler");
  requireRevision(OLD_NATIVE_PROGRAM_CANDIDATE);
  const output = resolve(options.output ?? join(ROOT, ".pocket-build/validation/native-program-compat", `${Date.now()}-${process.pid}`));
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), "pocket-native-compat-"));
  const run = commandRunner(output, temporary);
  try {
    const { compiler, target, cCompiler } = await hostToolchain(run, cc);
    const snapshot = await extractSnapshot(run, OLD_NATIVE_PROGRAM_CANDIDATE, output, temporary);
    const oldOutput = join(output, "old-candidate");
    const oldHeaders = join(oldOutput, "include");
    collectHeaders(snapshot, OLD_PROGRAM_CRATE.include, oldHeaders);
    const oldBuild = await buildStaticlib(run, {
      manifest: join(snapshot, "Cargo.toml"), cwd: snapshot, package: OLD_PROGRAM_CRATE.package, features: OLD_PROGRAM_CRATE.features,
      target, targetDir: join(output, "old-cargo-target"), artifact: OLD_PROGRAM_CRATE.artifact,
    });
    const oldArchive = join(oldOutput, OLD_PROGRAM_CRATE.artifact);
    copyFileSync(oldBuild.archive, oldArchive);

    const currentOutput = join(output, "current");
    const currentHeaders = join(currentOutput, "include");
    collectHeaders(ROOT, CURRENT_PROGRAM_CRATE.include, currentHeaders);
    // The current archive is the host harness build of the program crate
    // (tests/quickjs-c-harness.test.ts uses the same features); the target
    // directory persists across runs below .pocket-build.
    const currentBuild = await buildStaticlib(run, {
      manifest: join(ROOT, "Cargo.toml"), cwd: ROOT, package: CURRENT_PROGRAM_CRATE.package, features: CURRENT_PROGRAM_CRATE.features,
      target, targetDir: join(ROOT, ".pocket-build/validation/native-program-compat/cargo-target"), artifact: CURRENT_PROGRAM_CRATE.artifact,
    });
    const currentArchive = join(currentOutput, CURRENT_PROGRAM_CRATE.artifact);
    copyFileSync(currentBuild.archive, currentArchive);
    const currentSource = sourceRevision();
    const archives = assertDistinctSources({ oldRevision: OLD_NATIVE_PROGRAM_CANDIDATE, currentRevision: currentSource.revision, oldArchive, currentArchive });

    copyFileSync(join(ROOT, "tests/fixtures/native-program-compat/consumer.c"), join(temporary, "consumer.c"));
    writeFixtureHeaders(await fixturePackages(snapshot), temporary, output);
    const consumer = { cc, source: join(temporary, "consumer.c"), output, pass: PASS };
    const binary = await linkAndRun(run, { ...consumer, name: "old-header-new-archive", headers: [oldHeaders, temporary], archive: currentArchive, libraries: currentBuild.libraries });
    await linkAndRun(run, { ...consumer, name: "new-header-old-archive", headers: [currentHeaders, temporary], archive: oldArchive, libraries: oldBuild.libraries, macros: ["POCKET_OLD_ARCHIVE"] });
    const signalProbe = await abortProbe(run, binary, output, temporary);

    const headers = { old: {} as Record<string, string>, current: {} as Record<string, string> };
    for (const name of HEADER_NAMES) {
      headers.old[name] = sha256(readFileSync(join(oldHeaders, `pocket_${name}.h`)));
      headers.current[name] = sha256(readFileSync(join(currentHeaders, `pocket_${name}.h`)));
    }
    const receipt: NativeProgramCompatibilityReceipt = {
      schemaVersion: 1, status: "candidate", abiFrozen: false, oldRevision: OLD_NATIVE_PROGRAM_CANDIDATE, currentSource,
      oldCrate: OLD_PROGRAM_CRATE, currentCrate: CURRENT_PROGRAM_CRATE, compiler, cCompiler, target, ...archives, headers,
      cases: ["old-header-new-archive", "new-header-old-archive"],
      signalProbe, result: "passed", artifactDirectory: output,
    };
    writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    return receipt;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output")) throw new Error("usage: test-native-program-compat [--output directory]");
  const receipt = await runNativeProgramCompatibility({ output: args[1] });
  console.log(`Cross-version native program API: ${receipt.cases.length} cases passed; ${receipt.artifactDirectory}`);
}
