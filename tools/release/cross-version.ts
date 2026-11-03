// Shared mechanics of the cross-version C ABI checks. tools/test-runtime-cabi-compat.ts
// and tools/test-native-program-compat.ts build one old source snapshot from a Git
// archive outside the checkout, compile a fixture consumer against old headers with
// the current archive and against current headers with the old archive, and refuse
// to pass when both archives come from one source revision.
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { inputClassesForCapabilities } from "../../contracts/spec/input.ts";
import { encodeIdentity, encodePocketPackage, POCKET_SECTION } from "../../contracts/spec/pocket-package.ts";
import { canonicalProfileJson, type PocketProfile } from "../../contracts/spec/profile.ts";
import { STABLE_RUST_TOOLCHAIN } from "../build/toolchains/rust.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = resolve(import.meta.dir, "../..");
/** The first main-line revision whose pocket_runtime_config points at
 * pocket_profile_facts and whose program crate declares pocket_native_program.h:
 * the squash merge of #603. Its headers and archives are the oldest a current
 * configuration links against. The revision is an ancestor of main, so every
 * clone of main holds it. */
export const OLD_SOURCE_CANDIDATE = "1c248fb18f976e91a313f11e0dbb35273c9e48dd";

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const fixtureProfile: PocketProfile = { format: "pocket-host/2", id: "fixture", platform: "test", form: "takeover", cadences: [60], display: { logicalViewports: [[4, 4]], presentations: ["native"], rasterDensity: 1, animation: "repaint" }, panel: { primary: [4, 4] }, capabilities: [] };
const profileJson = canonicalProfileJson(fixtureProfile);
const profileHash = createHash("sha256").update(profileJson).digest();

export interface ProcessResult {
  stdout: string;
  stderr: string;
  status: number;
  signal: string | null;
  log: string;
}
export class CommandFailure extends Error {
  constructor(args: string[], readonly result: ProcessResult) {
    super(`${args.join(" ")} failed (exit=${result.status}, signal=${result.signal}): ${result.log}\n${result.stdout}${result.stderr}`);
  }
}
export interface CommandRunner {
  readonly env: Record<string, string | undefined>;
  /** Run and log; the caller judges the result. */
  execute(args: string[], cwd?: string): Promise<ProcessResult>;
  /** Run and log; a nonzero status or any signal is a CommandFailure. */
  command(args: string[], cwd?: string): Promise<ProcessResult>;
}

/** Numbered logs under output. Cargo builds release archives with panic=abort
 * and without ambient rustflags or compiler wrappers. */
export function commandRunner(output: string, cwd: string): CommandRunner {
  let index = 0;
  const env = { ...process.env, RUSTFLAGS: "", CARGO_ENCODED_RUSTFLAGS: "-C\x1fpanic=abort", RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "" };
  async function execute(args: string[], at = cwd): Promise<ProcessResult> {
    const log = join(output, `${String(++index).padStart(2, "0")}-${basename(args[0]!)}.log`);
    const child = Bun.spawn(args, { cwd: at, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const signal = child.signalCode;
    writeFileSync(log, `$ ${args.join(" ")}\nexit=${status}, signal=${signal}\n${stdout}${stderr}`);
    return { stdout, stderr, status, signal, log };
  }
  async function command(args: string[], at = cwd): Promise<ProcessResult> {
    const result = await execute(args, at);
    // Bun can report exit code zero for SIGABRT. The signal is authoritative.
    if (result.status !== 0 || result.signal !== null) throw new CommandFailure(args, result);
    return result;
  }
  return { env, execute, command };
}

export function requireRevision(revision: string): void {
  const present = Bun.spawnSync(["git", "-C", ROOT, "cat-file", "-e", `${revision}^{commit}`], { stdout: "ignore", stderr: "ignore" });
  if (!present.success) throw new Error(`revision ${revision} is not in this clone; run: git fetch origin main`);
}

/** The checkout's own revision and whether its tree differs from it. */
export function sourceRevision(root = ROOT): { revision: string | null; dirty: boolean | null } {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    return result.success ? result.stdout.toString().trim() : null;
  };
  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  return { revision: git(["rev-parse", "HEAD"]), dirty: status === null ? null : status.length > 0 };
}

export interface HostToolchain { compiler: string; target: string; cCompiler: string }
export async function hostToolchain(run: CommandRunner, cc: string): Promise<HostToolchain> {
  const compiler = (await run.command(["rustc", `+${STABLE_RUST_TOOLCHAIN}`, "-Vv"])).stdout.trim();
  const target = /^host: (.+)$/m.exec(compiler)?.[1];
  if (!target) throw new Error("rustc did not report a host target");
  const cCompiler = (await run.command([cc, "--version"])).stdout.trim();
  return { compiler, target, cCompiler };
}

/** Extract the revision's complete tree into temporary/old-source; the tar
 * stays in output. The root Cargo workspace lists members across the
 * repository, so the snapshot holds every crate at that revision. */
export async function extractSnapshot(run: CommandRunner, revision: string, output: string, temporary: string): Promise<string> {
  const snapshot = join(temporary, "old-source");
  mkdirSync(snapshot);
  const tar = join(output, "old-source.tar");
  await run.command(["git", "-C", ROOT, "archive", "--format=tar", "--output", tar, revision]);
  await run.command(["tar", "-xf", tar, "-C", snapshot]);
  return snapshot;
}

/** rustc's native-static-libs note from a --print=native-static-libs build. */
export function nativeStaticLibs(text: string): string[] {
  return [...text.matchAll(/native-static-libs:[ \t]*([^\r\n]*)/g)].flatMap(match => match[1]!.trim().split(/\s+/).filter(Boolean));
}

export interface StaticlibBuild {
  /** Cargo.toml of the workspace or crate to build from. */
  manifest: string;
  cwd: string;
  package: string;
  /** Cargo features after --no-default-features; none by default. */
  features?: string;
  target: string;
  targetDir: string;
  /** The archive file name Cargo writes for the crate's lib name. */
  artifact: string;
}
/** Build one crate as a release staticlib for the host target. */
export async function buildStaticlib(run: CommandRunner, build: StaticlibBuild): Promise<{ archive: string; libraries: string[] }> {
  const result = await run.command([
    "cargo", `+${STABLE_RUST_TOOLCHAIN}`, "rustc", "--lib", "--crate-type", "staticlib", "--locked",
    "--manifest-path", build.manifest, "-p", build.package, "--no-default-features",
    ...(build.features ? ["--features", build.features] : []),
    "--release", "--target", build.target, "--target-dir", build.targetDir, "--", "--print=native-static-libs",
  ], build.cwd);
  return { archive: join(build.targetDir, build.target, "release", build.artifact), libraries: nativeStaticLibs(result.stdout + result.stderr) };
}

/** The fixture header: the profile's facts as macros the consumer copies into
 * a pocket_profile_facts record by member name, its hash, and the package. */
export function fixtureHeader(generation: number, packageBytes: Uint8Array): string {
  const array = (name: string, bytes: Uint8Array) => `static const uint8_t ${name}[] = {${[...bytes].join(",")}};\n`;
  const { display } = fixtureProfile;
  return `static const uint32_t fixture_binding_generation = ${generation};\n`
    + `#define FIXTURE_ID ${JSON.stringify(fixtureProfile.id)}\n#define FIXTURE_TICK_HZ ${Math.max(...fixtureProfile.cadences)}u\n`
    + `#define FIXTURE_INPUT_CLASSES ${inputClassesForCapabilities(fixtureProfile.capabilities)}u\n`
    + `#define FIXTURE_WIDTH ${fixtureProfile.panel.primary[0]}u\n#define FIXTURE_HEIGHT ${fixtureProfile.panel.primary[1]}u\n`
    + `#define FIXTURE_RASTER_DENSITY ${display.rasterDensity}u\n`
    + array("profile_hash", profileHash) + array("package_bytes", packageBytes);
}

export interface FixturePackage { generation: number; bytes: Uint8Array; header: string }
/** The fixture package from the current encoder, and from the snapshot
 * revision's own encoder tagged with that revision's binding generation. The
 * C ABI matrix is independent of the package format version and the
 * generation; each archive receives bytes its own codec reads. The package
 * carries the identity output "app", id "test.app", title "App" and the
 * JavaScript "test" with its terminator. */
export async function fixturePackages(snapshot: string): Promise<{ current: FixturePackage; old: FixturePackage }> {
  const utf8 = (text: string) => new TextEncoder().encode(text);
  const sections = [
    { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: "app", id: "test.app", title: "App" }) },
    { kind: POCKET_SECTION.plan, bytes: utf8('{"animation":"repaint","profile":{"tickHz":60},"viewport":{"logical":[4,4],"presentation":"native","rasterDensity":1},"features":{}}') },
    { kind: POCKET_SECTION.js, bytes: utf8("test\0") },
  ];
  const variant = (hostAbi: number) => ({ manifest: utf8("{}"), variants: [{ target: fixtureProfile.id, hostAbi, profileHash: "sha256:" + sha256(profileJson), sections }] });
  const bytes = encodePocketPackage(variant(POCKET_BINDING_GENERATION));
  const oldEncoder = await import(pathToFileURL(join(snapshot, "contracts/spec/pocket-package.ts")).href);
  const oldGeneration = Number(/POCKET_BINDING_GENERATION = (\d+)/.exec(readFileSync(join(snapshot, "contracts/spec/binding-generation.ts"), "utf8"))?.[1]);
  if (!Number.isInteger(oldGeneration)) throw new Error("old revision does not declare POCKET_BINDING_GENERATION");
  const oldBytes: Uint8Array = oldEncoder.encodePocketPackage(variant(oldGeneration));
  return {
    current: { generation: POCKET_BINDING_GENERATION, bytes, header: fixtureHeader(POCKET_BINDING_GENERATION, bytes) },
    old: { generation: oldGeneration, bytes: oldBytes, header: fixtureHeader(oldGeneration, oldBytes) },
  };
}

/** Write both fixture headers beside the consumer and into the artifact directory. */
export function writeFixtureHeaders(packages: { current: FixturePackage; old: FixturePackage }, temporary: string, output: string): void {
  for (const [name, fixture] of [["fixture-current.h", packages.current], ["fixture-old.h", packages.old]] as const) {
    writeFileSync(join(temporary, name), fixture.header);
    writeFileSync(join(output, name), fixture.header);
  }
}

/** Both archives must come from different source revisions: the checkout is
 * not at the old revision, and the archives differ byte for byte. */
export function assertDistinctSources(check: { oldRevision: string; currentRevision: string | null; oldArchive: string; currentArchive: string }): { oldArchiveSha256: string; currentArchiveSha256: string } {
  if (check.currentRevision === check.oldRevision) throw new Error(`the checkout is at ${check.oldRevision}: both archives would come from one source revision`);
  const oldArchiveSha256 = sha256(readFileSync(check.oldArchive));
  const currentArchiveSha256 = sha256(readFileSync(check.currentArchive));
  if (oldArchiveSha256 === currentArchiveSha256) throw new Error("the old and current archives are byte-identical: the check would compare one archive with itself");
  return { oldArchiveSha256, currentArchiveSha256 };
}

export interface ConsumerLink {
  cc: string;
  name: string;
  source: string;
  /** Header directories, then the directory holding the fixture headers. */
  headers: string[];
  archive: string;
  libraries: string[];
  macros?: string[];
  output: string;
  /** The line the consumer prints at the end. */
  pass: string;
}
/** Compile and link the consumer with -Werror, run it, and require its pass line. */
export async function linkAndRun(run: CommandRunner, link: ConsumerLink): Promise<string> {
  const binary = join(link.output, link.name);
  await run.command([
    link.cc, "-std=c11", "-Wall", "-Wextra", "-Werror", ...link.headers.flatMap(directory => ["-I", directory]),
    ...(link.macros ?? []).map(name => "-D" + name), link.source, link.archive, ...link.libraries, "-o", binary,
  ]);
  const result = await run.command([binary]);
  if (!result.stdout.includes(link.pass)) throw new Error(`consumer did not finish: ${result.log}`);
  return binary;
}

/** Exercise the success check used by command() against a real aborted C
 * process, then the synchronous API other contract tests use. */
export async function abortProbe(run: CommandRunner, binary: string, output: string, cwd: string): Promise<{ asynchronous: string; synchronous: string }> {
  const abortArgs = [binary, "--abort"];
  let asynchronous: string | undefined;
  try { await run.command(abortArgs); } catch (error) {
    if (!(error instanceof CommandFailure) || error.result.signal === null) throw error;
    asynchronous = error.result.signal;
  }
  if (asynchronous !== "SIGABRT") throw new Error("async command helper accepted the aborted consumer");
  const sync = Bun.spawnSync(abortArgs, { cwd, env: run.env, stdout: "pipe", stderr: "pipe" });
  writeFileSync(join(output, "sync-abort.log"), `exit=${sync.exitCode}, signal=${sync.signalCode}, success=${sync.success}\n${sync.stdout}${sync.stderr}`);
  if (sync.success || sync.signalCode !== "SIGABRT") throw new Error("synchronous command check accepted the aborted consumer");
  return { asynchronous, synchronous: sync.signalCode };
}
