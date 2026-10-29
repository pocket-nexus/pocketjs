import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { addTarget } from "../targets/install.ts";
import { componentDigest, type ArchiveComponent } from "../targets/toolchain.ts";
import { currentHost, HOST_IDS } from "../targets/types.ts";
import { storeLayout, storeLock, storeMissing, storeTree, targetLock } from "../targets/store.ts";
import { withSharedLock } from "../targets/lock.ts";
import { verifySdk, type SdkManifest } from "./receipt.ts";
import { readRuntimeDirectory } from "../repack.ts";
import { readRuntime } from "../repack/shared/runtime.ts";
import { readRelease, releaseVersion } from "./manifest.ts";
import { createHash } from "node:crypto";
import { hashPocketProfile, validatePocketProfile, type PocketProfile } from "../../framework/src/profile.ts";

export interface ReleaseFetchOptions { version?: string; manifestUrl?: string; env?: NodeJS.ProcessEnv; }
async function withReleaseArtifact<T>(kind: "sdks" | "runtimes", id: string, options: ReleaseFetchOptions,
  use: (directory: string, revision: string, profileHash?: string) => Promise<T>): Promise<T> {
  const version = releaseVersion(options.version);
  const { manifest, url } = await readRelease(version, options.manifestUrl);
  const asset = manifest[kind][id];
  if (!asset) throw new Error("release " + version + " has no " + kind + " artifact for " + id);
  const marker = kind === "sdks" ? "sdk-manifest.json" : "runtime.json";
  const component: ArchiveComponent = { name: "release-archive", kind: "archive", role: "toolchain",
    source: { url: new URL(asset.file, url).href, sha256: asset.sha256 }, format: asset.format, markers: [marker] };
  const target = "release-" + kind + "-" + asset.sha256.slice(0, 24);
  const descriptor = { id: target, title: version + " " + id, hosts: HOST_IDS,
    toolchain: { schema: "pocket-toolchain/2" as const, target, components: [component] } };
  const env = options.env ?? process.env, layout = storeLayout(env), host = currentHost();
  if (!host) throw new Error("release downloads require a supported CLI host");
  await addTarget(descriptor, { env });
  return withSharedLock(targetLock(layout, target), () => withSharedLock(storeLock(layout), async () => {
    const digest = componentDigest(component, host);
    const missing = storeMissing(layout, component, digest);
    if (missing.length) throw new Error("release cache entry is incomplete: " + missing.join(", "));
    return use(storeTree(layout, digest), manifest.revision, asset.profileHash);
  }));
}
export async function exportReleasedSdk(triple: string, out: string, options: ReleaseFetchOptions = {}): Promise<SdkManifest> {
  out = resolve(out);
  if (existsSync(out)) throw new Error("SDK output already exists: " + out);
  return withReleaseArtifact("sdks", triple, options, async (directory, revision) => {
    const manifest = verifySdk(directory);
    if (manifest.build.triple !== triple || manifest.source.revision !== revision || manifest.source.dirty !== false ||
        manifest.status !== "release" || manifest.hostAbi !== POCKET_BINDING_GENERATION) throw new Error("SDK does not match its release identity");
    mkdirSync(dirname(out), { recursive: true });
    const staging = join(dirname(out), "." + basename(out) + "-" + randomUUID() + ".tmp");
    try {
      cpSync(directory, staging, { recursive: true });
      verifySdk(staging);
      if (existsSync(out)) throw new Error("SDK output was created during export");
      renameSync(staging, out);
    } finally { rmSync(staging, { recursive: true, force: true }); }
    return manifest;
  });
}
export async function releasedRuntime(target: string, profileHash: string, options: ReleaseFetchOptions = {}): Promise<Map<string, Uint8Array>> {
  return withReleaseArtifact("runtimes", target, options, async (directory, revision, expectedHash) => {
    if (expectedHash !== profileHash) throw new Error("released runtime profileHash differs from the program");
    const files = readRuntimeDirectory(directory), manifest = await readRuntime(files, target);
    if (manifest.profileHash !== profileHash || manifest.pocketjs !== revision)
      throw new Error("runtime does not match its release identity");
    return files;
  });
}

/** The profile document a release publishes for a runtime target, checked
 *  against the release's file hash, profileHash and binding generation. An
 *  application compiles against it with `pocket compile --target FILE.json`. */
export async function releasedProfile(target: string, options: ReleaseFetchOptions = {}): Promise<PocketProfile> {
  const version = releaseVersion(options.version);
  const { manifest, url } = await readRelease(version, options.manifestUrl);
  const asset = manifest.runtimes[target];
  if (!asset?.profile) throw new Error("release " + version + " publishes no profile document for " + target);
  const response = await fetch(new URL(asset.profile.file, url));
  if (!response.ok) throw new Error("release profile unavailable: " + asset.profile.file + " (HTTP " + response.status + ")");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== asset.profile.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.profile.sha256)
    throw new Error("release profile does not match its recorded hash: " + target);
  const validated = validatePocketProfile(JSON.parse(new TextDecoder().decode(bytes)));
  if (!validated.ok) throw new Error("release profile is invalid: " + validated.diagnostics.map(item => item.path + ": " + item.message).join("; "));
  if (validated.value.hostAbi !== manifest.hostAbi || hashPocketProfile(validated.value) !== asset.profileHash)
    throw new Error("release profile does not match its runtime: " + target);
  return validated.value;
}
