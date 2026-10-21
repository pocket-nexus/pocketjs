import { gzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { readRuntimeDirectory } from "../repack.ts";
import { readRuntime } from "../repack/shared/runtime.ts";
import { releaseVersion, validateReleaseManifest, type ReleaseAsset, type ReleaseManifest } from "./manifest.ts";
import { verifySdk } from "./receipt.ts";
import { archiveDirectory } from "./tar.ts";

export interface ReleaseInputs {
  version: string; revision: string; sourceRoot?: string; sdks: Record<string, string>; runtimes: Record<string, string>;
}
/** Prepare assets locally. Uploading and registry publication belong to CI. */
export async function prepareRelease(inputs: ReleaseInputs, output: string): Promise<ReleaseManifest> {
  const version = releaseVersion(inputs.version);
  if (!/^[0-9a-f]{40}$/.test(inputs.revision)) throw new Error("release requires an exact source revision");
  if (!Object.keys(inputs.sdks).length) throw new Error("release requires SDK artifacts");
  output = resolve(output);
  if (existsSync(output)) throw new Error("release output already exists: " + output);
  mkdirSync(dirname(output), { recursive: true });
  const staging = join(dirname(output), "." + basename(output) + "-" + randomUUID() + ".tmp");
  mkdirSync(staging);
  try {
    const sdks: Record<string, ReleaseAsset> = {}, runtimes: Record<string, ReleaseAsset> = {};
    const archive = (directory: string, file: string): ReleaseAsset => {
      const bytes = archiveDirectory(directory); writeFileSync(join(staging, file), bytes);
      return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), format: "tar.gz" };
    };
    for (const [triple, directory] of Object.entries(inputs.sdks).sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(triple)) throw new Error("invalid SDK target");
      const receipt = verifySdk(directory);
      if (receipt.source.revision !== inputs.revision || receipt.source.dirty !== false ||
          receipt.hostAbi !== POCKET_BINDING_GENERATION || receipt.build.triple !== triple ||
          receipt.build.defaultFeatures !== false || receipt.build.features.length !== 0)
        throw new Error("SDK release requires a clean matching revision and default archive: " + triple);
      const copy = join(staging, "sdk"); cpSync(directory, copy, { recursive: true });
      // Release status records distribution, not completion of ABI acceptance.
      writeFileSync(join(copy, "sdk-manifest.json"), JSON.stringify({ ...receipt, status: "release" }, null, 2) + "\n");
      verifySdk(copy); sdks[triple] = archive(copy, "pocket-sdk-" + triple + ".tar.gz");
      rmSync(copy, { recursive: true });
    }
    for (const [target, directory] of Object.entries(inputs.runtimes).sort()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(target)) throw new Error("invalid runtime target");
      const copy = join(staging, "runtime"); cpSync(directory, copy, { recursive: true });
      const receipt = await readRuntime(readRuntimeDirectory(copy), target);
      if (receipt.pocketjs !== inputs.revision) throw new Error("runtime release requires a clean matching revision: " + target);
      runtimes[target] = { ...archive(copy, "pocket-runtime-" + target + ".tar.gz"), profileHash: receipt.profileHash };
      rmSync(copy, { recursive: true });
    }
    let source: ReleaseAsset | undefined;
    if (inputs.sourceRoot) {
      const git = (args: string[]) => {
        const result = Bun.spawnSync(["git", "-C", inputs.sourceRoot!, ...args], { stdout: "pipe", stderr: "pipe" });
        if (!result.success) throw new Error("source release Git command failed: " + result.stderr);
        return result.stdout;
      };
      if (git(["rev-parse", "HEAD"]).toString().trim() !== inputs.revision ||
          git(["status", "--porcelain", "--untracked-files=normal"]).length)
        throw new Error("source release requires a clean matching revision");
      const file = "pocketjs-" + version + ".tar.gz";
      const bytes = gzipSync(git(["archive", "--format=tar", "--prefix=pocketjs-" + version + "/", inputs.revision]), { level: 9 });
      writeFileSync(join(staging, file), bytes);
      source = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), format: "tar.gz" };
    }
    const manifest = validateReleaseManifest({ schema: "pocket-release/1", version, revision: inputs.revision,
      hostAbi: POCKET_BINDING_GENERATION, sdks, runtimes, ...(source ? { source } : {}) }, version);
    writeFileSync(join(staging, "pocket-release.json"), JSON.stringify(manifest, null, 2) + "\n");
    if (existsSync(output)) throw new Error("release output was created during preparation");
    renameSync(staging, output); return manifest;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const [input, output, ...extra] = Bun.argv.slice(2);
  if (!input || !output || extra.length) throw new Error("usage: bun tools/release/publish.ts <inputs.json> <output-directory>");
  const config = JSON.parse(readFileSync(input, "utf8")) as ReleaseInputs;
  if (config.sourceRoot) config.sourceRoot = resolve(dirname(input), config.sourceRoot);
  for (const paths of [config.sdks, config.runtimes]) for (const key of Object.keys(paths)) paths[key] = resolve(dirname(input), paths[key]!);
  await prepareRelease(config, output);
}
