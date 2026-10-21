#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { encodeIdentity, encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { exportSdk, parseSdkExport, type SdkManifest } from "./sdk.ts";

export const OLD_RUNTIME_CANDIDATE = "9cf1347295b9f9bfeffa4496f67a65c5b2b449db";
const ROOT = resolve(import.meta.dir, "..");
const HEADER_NAMES = ["runtime", "drivers", "spec"] as const;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const profile = '{"capabilities":[],"display":{"logicalViewports":[[4,4]],"physicalViewport":[4,4],"presentations":["native"],"rasterDensity":1},"form":"takeover","id":"fixture","platform":"test","tickHz":60}';
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
  oldArchiveCompatibilityShim: "rust_eh_personality";
  cases: string[];
  signalProbe: { asynchronous: string; synchronous: string };
  result: "passed";
  artifactDirectory: string;
}

/** Compare real archives from two revisions; never replace the old implementation. */
export async function runRuntimeCompatibility(options: { output?: string } = {}): Promise<RuntimeCompatibilityReceipt> {
  const cc = Bun.which("cc");
  if (!cc) throw new Error("cross-version C ABI checks require a C compiler");
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
    const compiler = (await command(["rustc", "+stable", "-Vv"])).stdout.trim();
    const target = /^host: (.+)$/m.exec(compiler)?.[1];
    if (!target) throw new Error("rustc did not report a host target");
    const cCompiler = (await command([cc, "--version"])).stdout.trim();
    const snapshot = join(temporary, "old-source");
    mkdirSync(snapshot);
    const tar = join(output, "old-source.tar");
    // All workspace manifests and dependencies reside under engine. Keeping
    // only these source roots avoids copying unrelated applications/assets.
    await command(["git", "-C", ROOT, "archive", "--format=tar", "--output", tar, OLD_RUNTIME_CANDIDATE, "engine", "contracts/generated"]);
    await command(["tar", "-xf", tar, "-C", snapshot]);
    const oldOutput = join(output, "old-candidate");
    const oldHeaders = join(oldOutput, "include");
    mkdirSync(oldHeaders, { recursive: true });
    for (const name of HEADER_NAMES) copyFileSync(join(snapshot, `contracts/generated/pocket_${name}.h`), join(oldHeaders, `pocket_${name}.h`));
    const oldTarget = join(output, "old-cargo-target");
    const oldBuild = await command([
      "cargo", "+stable", "rustc", "--locked", "--manifest-path", join(snapshot, "engine/Cargo.toml"),
      "-p", "pocket-runtime-cabi", "--no-default-features", "--release", "--target", target,
      "--target-dir", oldTarget, "--", "--print=native-static-libs",
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
    const packageBytes = encodePocketPackage({ manifest: utf8("{}"), variants: [{ target: "fixture", hostAbi: 1, sections: [
      { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: "app", id: "test.app", title: "App" }) },
      { kind: POCKET_SECTION.plan, bytes: utf8('{"viewport":{"logical":[4,4],"rasterDensity":1},"features":{}}') },
      { kind: POCKET_SECTION.js, bytes: utf8("test\0") },
    ] }] });
    const array = (name: string, bytes: Uint8Array) => `static const uint8_t ${name}[] = {${[...bytes].join(",")}};\n`;
    const fixture = `static const uint8_t profile_json[] = ${JSON.stringify(profile)};\n`
      + array("profile_hash", createHash("sha256").update(profile).digest()) + array("package_bytes", packageBytes);
    writeFileSync(join(temporary, "fixture.h"), fixture);
    writeFileSync(join(output, "fixture.h"), fixture);
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
    await positive("new-header-old-archive", currentHeaders, oldArchive, oldLibraries, ["POCKET_OLD_CANDIDATE_PERSONALITY"]);
    await positive("new-api-current-control", currentHeaders, currentArchive, manifest.build.nativeStaticLibs, ["POCKET_REQUIRE_VISITOR"]);
    const missing = await execute(link("new-api-old-archive", currentHeaders, oldArchive, oldLibraries, ["POCKET_OLD_CANDIDATE_PERSONALITY", "POCKET_REQUIRE_VISITOR"]));
    if (missing.status === 0 || missing.signal !== null || !(missing.stdout + missing.stderr).includes("pocket_draw_list_visit")) {
      throw new Error(`old archive must reject the added entry point at link time: ${missing.log}`);
    }
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
      oldArchiveCompatibilityShim: "rust_eh_personality",
      cases: ["old-header-new-archive", "new-header-old-archive", "new-api-current-control", "new-api-old-archive-link-rejected"],
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
