import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { exportReleasedSdk, releasedProfile, releasedRuntime } from "../tools/release/fetch.ts";
import { validateReleaseManifest } from "../tools/release/manifest.ts";
import { prepareRelease } from "../tools/release/publish.ts";
import { verifySdk, type SdkManifest } from "../tools/release/receipt.ts";
import { archiveDirectory } from "../tools/release/tar.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import { POCKET_PROFILES } from "../profiles/index.ts";
import { runtimeDirectory } from "./helpers/runtime-directory.ts";

const root = resolve(import.meta.dir, ".."), base = join(root, ".pocket-build/validation/release-stage9/tests");
mkdirSync(base, { recursive: true });
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fixtureProfile = { ...POCKET_PROFILES["psp-runtime"], id: "fixture" };
const revision = "a".repeat(40), triple = "x86_64-unknown-linux-gnu", profileHash = hashPocketProfile(fixtureProfile);
function scratch() { const path = mkdtempSync(join(base, "release-")); temporary.push(path); return path; }
function fixture(directory: string) {
  const sdk = join(directory, "sdk"), runtime = join(directory, "runtime");
  const files: SdkManifest["files"] = {};
  for (const [name, bytes] of Object.entries({ "include/pocket/spec.h": "#define POCKET_BINDING_GENERATION " + POCKET_BINDING_GENERATION + "U\n", "lib/" : "" })) {
    if (name === "lib/") continue;
    mkdirSync(dirname(join(sdk, name)), { recursive: true }); writeFileSync(join(sdk, name), bytes);
    files[name] = { bytes: Buffer.byteLength(bytes), sha256: hash(bytes) };
  }
  const archive = "lib/" + triple + "/libpocket_runtime.a", bytes = "!<arch>\nfixture";
  mkdirSync(dirname(join(sdk, archive)), { recursive: true }); writeFileSync(join(sdk, archive), bytes);
  files[archive] = { bytes: bytes.length, sha256: hash(bytes) };
  const manifest: SdkManifest = { schemaVersion: 1, status: "candidate", abiFrozen: false, hostAbi: POCKET_BINDING_GENERATION,
    source: { revision, dirty: false, sha256: "c".repeat(64) }, build: { triple, target: triple, targetSha256: null,
      cargo: "fixture", compiler: "fixture", toolchain: "fixture", profile: "release", defaultFeatures: false, features: [],
      rustflags: ["-C", "panic=abort"], cargoArgs: [], archive, nativeStaticLibs: [] }, preparation: null, files };
  writeFileSync(join(sdk, "sdk-manifest.json"), JSON.stringify(manifest));
  mkdirSync(runtime);
  const runtimeFiles = runtimeDirectory(fixtureProfile, new Map([["program.bin", new TextEncoder().encode("runtime fixture")]]), { pocketjs: revision });
  for (const [name, bytes] of runtimeFiles) writeFileSync(join(runtime, name), bytes);
  return { sdk, runtime, manifest, inputs: { version: "0.15.0", revision, sdks: { [triple]: sdk }, runtimes: { fixture: runtime } } };
}

test("release preparation preserves candidates and rejects dirty revisions", async () => {
  const directory = scratch(), { inputs, sdk } = fixture(directory);
  await prepareRelease(inputs, join(directory, "release1"));
  expect(verifySdk(sdk).status).toBe("candidate");
  const receipt = verifySdk(sdk); receipt.source.dirty = true;
  writeFileSync(join(sdk, "sdk-manifest.json"), JSON.stringify(receipt));
  await expect(prepareRelease(inputs, join(directory, "rejected"))).rejects.toThrow("clean matching revision");
  expect(existsSync(join(directory, "rejected"))).toBe(false);
});

test("SDK and runtime downloads reuse the cache and reject existing destinations", async () => {
  const directory = scratch(), { inputs } = fixture(directory), output = join(directory, "release");
  const release = await prepareRelease(inputs, output);
  let downloads = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const file = new URL(request.url).pathname.slice(1);
    if (file === "pocket-release.json") return Response.json(release);
    if (file === release.runtimes.fixture?.profile?.file) return new Response(readFileSync(join(output, file)));
    if (!Object.values({ ...release.sdks, ...release.runtimes }).some(asset => asset.file === file)) return new Response("missing", { status: 404 });
    downloads++;
    return new Response(readFileSync(join(output, file)));
  } });
  const options = { version: inputs.version, manifestUrl: server.url + "pocket-release.json", env: { ...process.env, POCKET_NEXUS_CACHE_DIR: join(directory, "cache") } };
  try {
    const first = await exportReleasedSdk(triple, join(directory, "export1"), options);
    expect(first.status).toBe("release"); expect(first.abiFrozen).toBe(false);
    await exportReleasedSdk(triple, join(directory, "export2"), options); expect(downloads).toBe(1);
    expect((await releasedRuntime("fixture", profileHash, options)).get("program.bin")).toEqual(new Uint8Array(Buffer.from("runtime fixture")));
    // The firmware release publishes its stamped profile document beside the archive.
    expect(release.runtimes.fixture!.profile!.file).toBe("pocket-profile-fixture.json");
    expect(await releasedProfile("fixture", options)).toEqual({ ...fixtureProfile, hostAbi: POCKET_BINDING_GENERATION });
    await expect(exportReleasedSdk(triple, join(directory, "export1"), options)).rejects.toThrow("already exists");
  } finally { server.stop(true); }
}, 30_000);

test("release metadata rejects path escapes, stale ABI and invalid artifact sizes", () => {
  const value = { schema: "pocket-release/1", version: "0.15.0", revision, hostAbi: POCKET_BINDING_GENERATION,
    sdks: { host: { file: "../sdk.tar.gz", bytes: 1, sha256: "a".repeat(64), format: "tar.gz" } }, runtimes: {} };
  expect(() => validateReleaseManifest(value, value.version)).toThrow("invalid release asset");
  value.sdks.host.file = "sdk.tar.gz"; value.sdks.host.bytes = 0;
  expect(() => validateReleaseManifest(value, value.version)).toThrow("invalid release asset");
  value.sdks.host.bytes = 1;
  // A runtime publishes its profile document beside the archive.
  const runtime = { file: "runtime.tar.gz", bytes: 1, sha256: "b".repeat(64), format: "tar.gz", profileHash: "sha256:" + "c".repeat(64) };
  expect(() => validateReleaseManifest({ ...value, runtimes: { psp: runtime } }, value.version)).toThrow("invalid release asset");
  expect(validateReleaseManifest({ ...value, runtimes: { psp: { ...runtime, profile: { file: "pocket-profile-psp.json", bytes: 2, sha256: "d".repeat(64) } } } }, value.version).runtimes.psp!.profile!.file).toBe("pocket-profile-psp.json");
  value.hostAbi = 1 as typeof POCKET_BINDING_GENERATION;
  expect(() => validateReleaseManifest(value, value.version)).toThrow("binding generation");
});

test("release archive preserves long paths and executable mode for external tar consumers", () => {
  const directory = scratch(), input = join(directory, "input"), output = join(directory, "extract");
  const name = "nested/" + "a".repeat(110) + "/tool";
  mkdirSync(dirname(join(input, name)), { recursive: true }); writeFileSync(join(input, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const tar = join(directory, "artifact.tar.gz"); writeFileSync(tar, archiveDirectory(input)); mkdirSync(output);
  const result = Bun.spawnSync(["tar", "-xf", tar, "-C", output], { stdout: "pipe", stderr: "pipe" });
  expect(result.success, result.stderr.toString()).toBe(true);
  expect(Bun.spawnSync([join(output, name)]).success).toBe(true);
});

test("source distribution records the exact clean Git revision and archive prefix", async () => {
  const directory = scratch(), source = join(directory, "source"), { inputs, sdk, runtime } = fixture(directory);
  mkdirSync(source); writeFileSync(join(source, "README.md"), "source fixture\n");
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", source, ...args], { stdout: "pipe", stderr: "pipe" });
    expect(result.success, result.stderr.toString()).toBe(true); return result.stdout.toString().trim();
  };
  git(["init", "--initial-branch=feat/release-fixture"]); git(["add", "README.md"]);
  git(["-c", "user.name=Release Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "test: release fixture"]);
  inputs.revision = git(["rev-parse", "HEAD"]);
  const receipt = verifySdk(sdk); receipt.source.revision = inputs.revision;
  writeFileSync(join(sdk, "sdk-manifest.json"), JSON.stringify(receipt));
  const manifest = JSON.parse(readFileSync(join(runtime, "runtime.json"), "utf8")); manifest.pocketjs = inputs.revision;
  writeFileSync(join(runtime, "runtime.json"), JSON.stringify(manifest));
  const output = join(directory, "release");
  const release = await prepareRelease({ ...inputs, sourceRoot: source }, output);
  const listing = Bun.spawnSync(["tar", "-tf", join(output, release.source!.file)], { stdout: "pipe", stderr: "pipe" });
  expect(listing.success).toBe(true); expect(listing.stdout.toString()).toContain("pocketjs-0.15.0/README.md");
  writeFileSync(join(source, "README.md"), "dirty\n");
  await expect(prepareRelease({ ...inputs, sourceRoot: source }, join(directory, "dirty-release"))).rejects.toThrow("clean matching revision");
});
