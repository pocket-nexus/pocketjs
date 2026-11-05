import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";

/** A file published beside the archives. */
export interface ReleaseFile {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface ReleaseAsset extends ReleaseFile {
  readonly format: "tar.gz";
  readonly profileHash?: string;
  /** A runtime's stamped pocket.host.json, published as its own file so
   *  an application compiles against it without the runtime archive. */
  readonly profile?: ReleaseFile;
}
export interface ReleaseManifest {
  readonly schema: "pocket-release/1";
  readonly version: string;
  readonly revision: string;
  readonly hostAbi: number;
  readonly sdks: Readonly<Record<string, ReleaseAsset>>;
  readonly runtimes: Readonly<Record<string, ReleaseAsset>>;
  readonly source?: ReleaseAsset;
}
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export function releaseVersion(version = JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")).version): string {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("release requires an exact semantic version");
  return version;
}
export function releaseManifestUrl(version: string): string {
  return "https://github.com/pocket-nexus/pocketjs/releases/download/v" + releaseVersion(version) + "/pocket-release.json";
}
export function validateReleaseManifest(value: unknown, version: string): ReleaseManifest {
  const manifest = value as ReleaseManifest;
  if (!manifest || manifest.schema !== "pocket-release/1" || manifest.version !== releaseVersion(version) ||
      !/^[0-9a-f]{40}$/.test(manifest.revision) || manifest.hostAbi !== POCKET_BINDING_GENERATION)
    throw new Error("release identity or binding generation does not match this framework");
  for (const kind of ["sdks", "runtimes"] as const) {
    const entries = manifest[kind];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("release has no " + kind + " table");
    for (const [id, asset] of Object.entries(entries)) {
      if (!NAME.test(id)) throw new Error("invalid release target: " + id);
      validateAsset(asset);
      if (kind === "runtimes" && !/^sha256:[0-9a-f]{64}$/.test(asset.profileHash ?? ""))
        throw new Error("release runtime lacks profileHash: " + id);
      if (kind === "runtimes") validateFile(asset.profile);
    }
  }
  if (manifest.source) validateAsset(manifest.source);
  return manifest;
}
function validateAsset(asset: ReleaseAsset): void {
  if (!asset || asset.format !== "tar.gz") throw new Error("invalid release asset");
  validateFile(asset);
}
function validateFile(file: ReleaseFile | undefined): void {
  if (!file || !NAME.test(file.file) || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0)
    throw new Error("invalid release asset");
}
export async function readRelease(version: string, url = releaseManifestUrl(version)): Promise<{ manifest: ReleaseManifest; url: string }> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("release manifest requires HTTP(S)");
  const response = await fetch(url);
  if (!response.ok) throw new Error("release manifest unavailable: " + url + " (HTTP " + response.status + ")");
  return { manifest: validateReleaseManifest(await response.json(), version), url };
}
