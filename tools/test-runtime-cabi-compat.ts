#!/usr/bin/env bun
// Cross-version C ABI check, run by hand before a release; CI does not run it.
//
// It builds the runtime archive of OLD_RUNTIME_CANDIDATE from a Git archive
// outside the checkout, exports the current SDK, and compiles
// tests/fixtures/runtime-cabi-compat/consumer.c against old headers with the
// current archive and against current headers with the old archive.
//
// The revision must be present in the local clone. After its branch is
// deleted, fetch it with `git fetch origin refs/pull/603/head`.
//
//   bun tools/test-runtime-cabi-compat.ts [--output directory]
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { basename, join, resolve } from "node:path";
import { encodeIdentity, encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { canonicalProfileJson, type PocketProfile } from "../contracts/spec/profile.ts";
import { inputClassesForCapabilities } from "../contracts/spec/input.ts";
import { STABLE_RUST_TOOLCHAIN } from "./build/toolchains/rust.ts";
import { exportSdk, parseSdkExport, type SdkManifest } from "./sdk.ts";

/** The first revision whose pocket_runtime_config points at pocket_profile_facts.
 * Its headers and archive are the oldest a current configuration links against. */
export const OLD_RUNTIME_CANDIDATE = "4c82eee5ec9afc46eb7fce57191e0ace1ab6b855";
const OLD_RUNTIME_REF = "refs/pull/603/head";
const ROOT = resolve(import.meta.dir, "..");
const HEADER_NAMES = ["runtime", "drivers", "spec"] as const;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fixtureProfile: PocketProfile = { format: "pocket-host/2", id: "fixture", platform: "test", form: "takeover", cadences: [60], display: { logicalViewports: [[4, 4]], presentations: ["native"], rasterDensity: 1, animation: "repaint" }, panel: { primary: [4, 4] }, capabilities: [] };
const profile = canonicalProfileJson(fixtureProfile);
const PASS = "cross-version C ABI: common entry points and lifecycle passed";

interface ProcessResult {
  stdout: string;
  stderr: string;
  status: number;
  signal: string | null;
  log: string;
}
class CommandFailure extends Error {
  constructor(args: string[], readonly result: ProcessResult) {
    super(`${args.join(" ")} failed (exit=${result.status}, signal=${result.signal}): ${result.log}\n${result.stdout}${result.stderr}`);
  }
}
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

/** The fixture header: the profile's facts as macros the consumer copies into
 * a pocket_profile_facts record by member name, its hash, and the package. */
function fixtureHeader(generation: number, packageBytes: Uint8Array): string {
  const array = (name: string, bytes: Uint8Array) => `static const uint8_t ${name}[] = {${[...bytes].join(",")}};\n`;
  const { display } = fixtureProfile;
  return `static const uint32_t fixture_binding_generation = ${generation};\n`
    + `#define FIXTURE_ID ${JSON.stringify(fixtureProfile.id)}\n#define FIXTURE_TICK_HZ ${Math.max(...fixtureProfile.cadences)}u\n`
    + `#define FIXTURE_INPUT_CLASSES ${inputClassesForCapabilities(fixtureProfile.capabilities)}u\n`
    + `#define FIXTURE_WIDTH ${fixtureProfile.panel.primary[0]}u\n#define FIXTURE_HEIGHT ${fixtureProfile.panel.primary[1]}u\n`
    + `#define FIXTURE_RASTER_DENSITY ${display.rasterDensity}u\n`
    + array("profile_hash", createHash("sha256").update(profile).digest()) + array("package_bytes", packageBytes);
}

/** Compare real archives from two revisions; never replace the old implementation. */
export async function runRuntimeCompatibility(options: { output?: string } = {}): Promise<RuntimeCompatibilityReceipt> {
  const cc = Bun.which("cc");
  if (!cc) throw new Error("cross-version C ABI checks require a C compiler");
  const present = Bun.spawnSync(["git", "-C", ROOT, "cat-file", "-e", `${OLD_RUNTIME_CANDIDATE}^{commit}`], { stdout: "ignore", stderr: "ignore" });
  if (!present.success) throw new Error(`revision ${OLD_RUNTIME_CANDIDATE} is not in this clone; run: git fetch origin ${OLD_RUNTIME_REF}`);
  const output = resolve(options.output ?? join(ROOT, ".pocket-build/validation/runtime-cabi-compat", `${Date.now()}-${process.pid}`));
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), "pocket-cabi-compat-"));
  let commandIndex = 0;
  const env = {
    ...process.env, RUSTFLAGS: "", CARGO_ENCODED_RUSTFLAGS: "-C\x1fpanic=abort",
    RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "",
  };
  async function execute(args: string[], cwd = temporary): Promise<ProcessResult> {
    const log = join(output, `${String(++commandIndex).padStart(2, "0")}-${basename(args[0]!)}.log`);
    const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const signal = child.signalCode;
    writeFileSync(log, `$ ${args.join(" ")}\nexit=${status}, signal=${signal}\n${stdout}${stderr}`);
    return { stdout, stderr, status, signal, log };
  }
  async function command(args: string[], cwd = temporary): Promise<ProcessResult> {
    const result = await execute(args, cwd);
    // Bun can report exit code zero for SIGABRT. The signal is authoritative.
    if (result.status !== 0 || result.signal !== null) throw new CommandFailure(args, result);
    return result;
  }
  try {
    const compiler = (await command(["rustc", `+${STABLE_RUST_TOOLCHAIN}`, "-Vv"])).stdout.trim();
    const target = /^host: (.+)$/m.exec(compiler)?.[1];
    if (!target) throw new Error("rustc did not report a host target");
    const cCompiler = (await command([cc, "--version"])).stdout.trim();
    const snapshot = join(temporary, "old-source");
    mkdirSync(snapshot);
    const tar = join(output, "old-source.tar");
    // The root Cargo workspace lists members across the repository, so the
    // snapshot holds the complete tree at that revision.
    await command(["git", "-C", ROOT, "archive", "--format=tar", "--output", tar, OLD_RUNTIME_CANDIDATE]);
    await command(["tar", "-xf", tar, "-C", snapshot]);
    const oldOutput = join(output, "old-candidate");
    const oldHeaders = join(oldOutput, "include");
    mkdirSync(oldHeaders, { recursive: true });
    for (const name of HEADER_NAMES) copyFileSync(join(snapshot, `contracts/generated/pocket_${name}.h`), join(oldHeaders, `pocket_${name}.h`));
    const oldTarget = join(output, "old-cargo-target");
    const oldBuild = await command([
      "cargo", `+${STABLE_RUST_TOOLCHAIN}`, "rustc", "--lib", "--crate-type", "staticlib", "--locked",
      "--manifest-path", join(snapshot, "Cargo.toml"), "-p", "pocket-runtime-cabi", "--no-default-features",
      "--release", "--target", target, "--target-dir", oldTarget, "--", "--print=native-static-libs",
    ], snapshot);
    const oldLibraries = [...(oldBuild.stdout + oldBuild.stderr).matchAll(/native-static-libs:[ \t]*([^\r\n]*)/g)]
      .flatMap(match => match[1]!.trim().split(/\s+/).filter(Boolean));
    const oldArchive = join(oldOutput, "libpocket_runtime.a");
    copyFileSync(join(oldTarget, target, "release/libpocket_runtime_cabi.a"), oldArchive);

    const currentSdk = join(output, "current-sdk");
    const manifest = await exportSdk(parseSdkExport(["--triple", target, "--out", currentSdk]));
    const currentHeaders = join(currentSdk, "include/pocket");
    const currentArchive = join(currentSdk, manifest.build.archive);
    copyFileSync(join(ROOT, "tests/fixtures/runtime-cabi-compat/consumer.c"), join(temporary, "consumer.c"));
    const utf8 = (text: string) => new TextEncoder().encode(text);
    const sections = [
      { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: "app", id: "test.app", title: "App" }) },
      { kind: POCKET_SECTION.plan, bytes: utf8('{"animation":"repaint","profile":{"tickHz":60},"viewport":{"logical":[4,4],"presentation":"native","rasterDensity":1},"features":{}}') },
      { kind: POCKET_SECTION.js, bytes: utf8("test\0") },
    ];
    const packageBytes = encodePocketPackage({ manifest: utf8("{}"), variants: [{ target: fixtureProfile.id, hostAbi: POCKET_BINDING_GENERATION, profileHash: "sha256:" + hash(profile), sections }] });
    const fixture = fixtureHeader(POCKET_BINDING_GENERATION, packageBytes);
    writeFileSync(join(temporary, "fixture-current.h"), fixture);
    writeFileSync(join(output, "fixture-current.h"), fixture);
    // The C ABI matrix is independent of the package format version and the
    // binding generation. The old archive receives bytes from the old
    // revision's own encoder, tagged with that revision's generation.
    const oldSpecFile = join(temporary, "package-old.ts");
    writeFileSync(oldSpecFile, (await command(["git", "-C", ROOT, "show", `${OLD_RUNTIME_CANDIDATE}:contracts/spec/pocket-package.ts`])).stdout);
    const oldEncoder = await import(pathToFileURL(oldSpecFile).href);
    const oldGenerationSource = (await command(["git", "-C", ROOT, "show", `${OLD_RUNTIME_CANDIDATE}:contracts/spec/binding-generation.ts`])).stdout;
    const oldGeneration = Number(/POCKET_BINDING_GENERATION = (\d+)/.exec(oldGenerationSource)?.[1]);
    if (!Number.isInteger(oldGeneration)) throw new Error("old revision does not declare POCKET_BINDING_GENERATION");
    const oldPackageBytes: Uint8Array = oldEncoder.encodePocketPackage({ manifest: utf8("{}"), variants: [{ target: fixtureProfile.id, hostAbi: oldGeneration, profileHash: "sha256:" + hash(profile), sections }] });
    const oldFixture = fixtureHeader(oldGeneration, oldPackageBytes);
    writeFileSync(join(temporary, "fixture-old.h"), oldFixture);
    writeFileSync(join(output, "fixture-old.h"), oldFixture);
    const link = (name: string, headers: string, archive: string, libraries: string[], macros: string[] = []) => [
      cc, "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", headers, "-I", temporary,
      ...macros.map(name => "-D" + name), join(temporary, "consumer.c"), archive,
      ...libraries, "-o", join(output, name),
    ];
    async function positive(name: string, headers: string, archive: string, libraries: string[], macros: string[] = []) {
      await command(link(name, headers, archive, libraries, macros));
      const result = await command([join(output, name)]);
      if (!result.stdout.includes(PASS)) throw new Error(`consumer did not finish: ${result.log}`);
    }
    await positive("old-header-new-archive", oldHeaders, currentArchive, manifest.build.nativeStaticLibs);
    await positive("new-header-old-archive", currentHeaders, oldArchive, oldLibraries, ["POCKET_OLD_ARCHIVE"]);
    // Exercise the very success check used above against a real aborted C
    // process, then check the synchronous API used by other contract tests.
    const abortArgs = [join(output, "old-header-new-archive"), "--abort"];
    let asynchronous: string | undefined;
    try { await command(abortArgs); } catch (error) {
      if (!(error instanceof CommandFailure) || error.result.signal === null) throw error;
      asynchronous = error.result.signal;
    }
    if (asynchronous !== "SIGABRT") throw new Error("async command helper accepted the aborted consumer");
    const sync = Bun.spawnSync(abortArgs, { cwd: temporary, env, stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(output, "sync-abort.log"), `exit=${sync.exitCode}, signal=${sync.signalCode}, success=${sync.success}\n${sync.stdout}${sync.stderr}`);
    if (sync.success || sync.signalCode !== "SIGABRT") throw new Error("synchronous command check accepted the aborted consumer");

    const headers = { old: {} as Record<string, string>, current: {} as Record<string, string> };
    for (const name of HEADER_NAMES) {
      headers.old[name] = hash(readFileSync(join(oldHeaders, `pocket_${name}.h`)));
      headers.current[name] = hash(readFileSync(join(currentHeaders, `${name}.h`)));
    }
    const receipt: RuntimeCompatibilityReceipt = {
      schemaVersion: 1, status: "candidate", abiFrozen: false, oldRevision: OLD_RUNTIME_CANDIDATE,
      currentSource: manifest.source, compiler, cCompiler, target,
      oldArchiveSha256: hash(readFileSync(oldArchive)), currentArchiveSha256: hash(readFileSync(currentArchive)), headers,
      cases: ["old-header-new-archive", "new-header-old-archive"],
      signalProbe: { asynchronous, synchronous: sync.signalCode }, result: "passed", artifactDirectory: output,
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
