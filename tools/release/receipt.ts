import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface SdkManifest {
  schemaVersion: 1; status: "candidate" | "release"; abiFrozen: boolean; hostAbi: number;
  source: { revision: string | null; dirty: boolean | null; sha256: string };
  build: { triple: string; target: string; targetSha256: string | null; cargo: string; compiler: string; toolchain: string; profile: "release"; defaultFeatures: false; features: string[]; rustflags: string[]; cargoArgs: string[]; archive: string; nativeStaticLibs: string[] };
  preparation: null | { kind: "esp32p4"; version: 1; archiver: string; originalSha256: string; removedMembers: string[] };
  files: Record<string, { sha256: string; bytes: number }>;
}
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
export function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`SDK inputs must be regular files: ${path}`);
  if (stat.isFile()) return [path];
  return readdirSync(path).sort().flatMap(name => filesUnder(join(path, name)));
}
export function bindingGeneration(header: string): number {
  const match = /^#define POCKET_BINDING_GENERATION (\d+)U?\s*$/m.exec(header);
  const generation = Number(match?.[1]);
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 0xffffffff)
    throw new Error("SDK specification header has no valid binding generation");
  return generation;
}
export function verifySdk(directory: string): SdkManifest {
  const manifest = JSON.parse(readFileSync(join(directory, "sdk-manifest.json"), "utf8")) as SdkManifest;
  if (manifest.schemaVersion !== 1 || !["candidate", "release"].includes(manifest.status) || typeof manifest.abiFrozen !== "boolean" || !manifest.files || !manifest.build?.archive) throw new Error("unsupported SDK manifest");
  const actual = filesUnder(directory).map(file => relative(directory, file).split(sep).join("/")).filter(file => file !== "sdk-manifest.json").sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error("SDK file list differs from manifest");
  if (!manifest.files[manifest.build.archive]) throw new Error("SDK archive is absent from manifest");
  for (const [name, receipt] of Object.entries(manifest.files)) {
    if (name.startsWith("/") || name.split("/").some(part => part === ".." || !part) || name.includes("\\")) throw new Error(`invalid SDK manifest path: ${name}`);
    const bytes = readFileSync(join(directory, name));
    if (bytes.length !== receipt.bytes || hash(bytes) !== receipt.sha256) throw new Error(`SDK checksum mismatch: ${name}`);
  }
  if (manifest.hostAbi !== bindingGeneration(readFileSync(join(directory, "include/pocket/spec.h"), "utf8")))
    throw new Error("SDK binding generation differs from specification header");
  return manifest;
}
