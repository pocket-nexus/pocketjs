#!/usr/bin/env bun
// Cross-version C ABI check, run by hand before a release; CI does not run it.
//
// It builds the runtime archive of OLD_RUNTIME_CANDIDATE from a Git archive
// outside the checkout, exports the current SDK, and compiles
// tests/fixtures/runtime-cabi-compat/consumer.c against old headers with the
// current archive and against current headers with the old archive. The two
// archives must come from different source revisions. The mechanics are
// shared with tools/test-native-program-compat.ts, which applies them to
// pocket_native_program.h.
//
//   bun tools/test-runtime-cabi-compat.ts [--output directory]
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  abortProbe, assertDistinctSources, buildStaticlib, commandRunner, extractSnapshot, fixturePackages, hostToolchain,
  linkAndRun, OLD_SOURCE_CANDIDATE, requireRevision, ROOT, sha256, writeFixtureHeaders,
} from "./release/cross-version.ts";
import { exportSdk, parseSdkExport, type SdkManifest } from "./sdk.ts";

/** The first main-line revision whose pocket_runtime_config points at
 * pocket_profile_facts. Its headers and archive are the oldest a current
 * configuration links against. */
export const OLD_RUNTIME_CANDIDATE = OLD_SOURCE_CANDIDATE;
const HEADER_NAMES = ["runtime", "drivers", "spec"] as const;
const PASS = "cross-version C ABI: common entry points and lifecycle passed";

export interface RuntimeCompatibilityReceipt {
  schemaVersion: 1;
  status: "candidate";
  abiFrozen: false;
  oldRevision: string;
  currentSource: SdkManifest["source"];
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

/** Compare real archives from two revisions; never replace the old implementation. */
export async function runRuntimeCompatibility(options: { output?: string } = {}): Promise<RuntimeCompatibilityReceipt> {
  const cc = Bun.which("cc");
  if (!cc) throw new Error("cross-version C ABI checks require a C compiler");
  requireRevision(OLD_RUNTIME_CANDIDATE);
  const output = resolve(options.output ?? join(ROOT, ".pocket-build/validation/runtime-cabi-compat", `${Date.now()}-${process.pid}`));
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), "pocket-cabi-compat-"));
  const run = commandRunner(output, temporary);
  try {
    const { compiler, target, cCompiler } = await hostToolchain(run, cc);
    const snapshot = await extractSnapshot(run, OLD_RUNTIME_CANDIDATE, output, temporary);
    const oldOutput = join(output, "old-candidate");
    const oldHeaders = join(oldOutput, "include");
    mkdirSync(oldHeaders, { recursive: true });
    for (const name of HEADER_NAMES) copyFileSync(join(snapshot, `contracts/generated/pocket_${name}.h`), join(oldHeaders, `pocket_${name}.h`));
    // The old crate under its own name and artifact path; the SDK's default archive has no features.
    const oldBuild = await buildStaticlib(run, {
      manifest: join(snapshot, "Cargo.toml"), cwd: snapshot, package: "pocket-runtime-cabi", target,
      targetDir: join(output, "old-cargo-target"), artifact: "libpocket_runtime_cabi.a",
    });
    const oldArchive = join(oldOutput, "libpocket_runtime.a");
    copyFileSync(oldBuild.archive, oldArchive);

    const currentSdk = join(output, "current-sdk");
    const manifest = await exportSdk(parseSdkExport(["--triple", target, "--out", currentSdk]));
    const currentHeaders = join(currentSdk, "include/pocket");
    const currentArchive = join(currentSdk, manifest.build.archive);
    const archives = assertDistinctSources({ oldRevision: OLD_RUNTIME_CANDIDATE, currentRevision: manifest.source.revision, oldArchive, currentArchive });
    copyFileSync(join(ROOT, "tests/fixtures/runtime-cabi-compat/consumer.c"), join(temporary, "consumer.c"));
    writeFixtureHeaders(await fixturePackages(snapshot), temporary, output);
    const consumer = { cc, source: join(temporary, "consumer.c"), output, pass: PASS };
    const binary = await linkAndRun(run, { ...consumer, name: "old-header-new-archive", headers: [oldHeaders, temporary], archive: currentArchive, libraries: manifest.build.nativeStaticLibs });
    await linkAndRun(run, { ...consumer, name: "new-header-old-archive", headers: [currentHeaders, temporary], archive: oldArchive, libraries: oldBuild.libraries, macros: ["POCKET_OLD_ARCHIVE"] });
    const signalProbe = await abortProbe(run, binary, output, temporary);

    const headers = { old: {} as Record<string, string>, current: {} as Record<string, string> };
    for (const name of HEADER_NAMES) {
      headers.old[name] = sha256(readFileSync(join(oldHeaders, `pocket_${name}.h`)));
      headers.current[name] = sha256(readFileSync(join(currentHeaders, `${name}.h`)));
    }
    const receipt: RuntimeCompatibilityReceipt = {
      schemaVersion: 1, status: "candidate", abiFrozen: false, oldRevision: OLD_RUNTIME_CANDIDATE,
      currentSource: manifest.source, compiler, cCompiler, target, ...archives, headers,
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
  if (args.length && (args.length !== 2 || args[0] !== "--output")) throw new Error("usage: test-runtime-cabi-compat [--output directory]");
  const receipt = await runRuntimeCompatibility({ output: args[1] });
  console.log(`Cross-version C ABI: ${receipt.cases.length} cases passed; ${receipt.artifactDirectory}`);
}
