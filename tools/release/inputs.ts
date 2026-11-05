import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { hashPocketProfile } from "../../framework/src/profile.ts";
import { POCKET_PROFILES } from "../../hosts/index.ts";
import { SDK_MATRIX } from "./matrix.ts";
import type { ReleaseInputs } from "./publish.ts";

/** Generic runtime artifacts shipped alongside every framework release. */
export const RUNTIME_MATRIX = [
  { target: "psp", profile: "psp-runtime", runner: "ubuntu-24.04" },
  { target: "vita", profile: "vita", runner: "macos-15" },
  { target: "3ds", profile: "3ds-runtime", runner: "ubuntu-24.04" },
] as const;

function directory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error("release artifact must be a directory: " + path);
}
function filesUnder(path: string, base = path): string[] {
  const stat = lstatSync(path);
  if (stat.isDirectory()) return readdirSync(path).sort().flatMap(name => filesUnder(join(path, name), base));
  if (!stat.isFile()) throw new Error("release runtime requires regular files: " + path);
  return [relative(base, path)];
}

/** Downloaded Actions artifacts have different absolute paths from their build hosts. */
export function collectReleaseInputs(base: string, sourceRoot: string, version: string, revision: string): ReleaseInputs {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("release inputs require an exact source revision");
  base = resolve(base);
  const sdks: Record<string, string> = {}, runtimes: Record<string, string> = {};
  for (const { triple } of SDK_MATRIX) {
    const path = join(base, "sdks", "pocket-sdk-" + triple);
    directory(path);
    sdks[triple] = path;
  }
  for (const { profile } of RUNTIME_MATRIX) {
    const build = join(base, "runtimes", "pocket-runtime-" + profile);
    directory(build);
    const runtime = join(build, "runtime");
    directory(runtime);
    const receipt = JSON.parse(readFileSync(join(build, "build-receipt.json"), "utf8"));
    if (receipt.schema !== "pocket-runtime-build/1" || receipt.success !== true || receipt.source !== revision ||
        receipt.target !== profile || receipt.profileHash !== hashPocketProfile(POCKET_PROFILES[profile]) ||
        receipt.hostAbi !== POCKET_BINDING_GENERATION || receipt.input !== null || receipt.deployed !== false ||
        !receipt.files || typeof receipt.files !== "object" || Array.isArray(receipt.files))
      throw new Error("release runtime requires a successful generic build at the release revision: " + profile);
    const actual = filesUnder(runtime).sort();
    if (!actual.includes("runtime.json") || JSON.stringify(actual) !== JSON.stringify(Object.keys(receipt.files).sort()))
      throw new Error("release runtime file list differs from build receipt: " + profile);
    for (const name of actual) {
      const bytes = readFileSync(join(runtime, name));
      const recorded = receipt.files[name];
      if (!recorded || recorded.bytes !== bytes.length || recorded.sha256 !== createHash("sha256").update(bytes).digest("hex"))
        throw new Error("release runtime checksum differs from build receipt: " + profile + "/" + name);
    }
    runtimes[profile] = runtime;
  }
  return { version, revision, sourceRoot: resolve(sourceRoot), sdks, runtimes };
}

if (import.meta.main) {
  const [base, sourceRoot, ...extra] = Bun.argv.slice(2);
  if (!base || !sourceRoot || extra.length) throw new Error("usage: inputs.ts <downloaded-artifacts-directory> <source-root>");
  const git = Bun.spawnSync(["git", "-C", sourceRoot, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (!git.success) throw new Error("cannot read release source revision: " + git.stderr);
  const { version } = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  writeFileSync(join(base, "inputs.json"), JSON.stringify(collectReleaseInputs(base, sourceRoot, version, git.stdout.toString().trim()), null, 2) + "\n");
}
