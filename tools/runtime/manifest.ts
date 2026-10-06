// runtime.json beside a generic runtime: what tools/repack/shared/runtime.ts
// reads back to check the runtime directory before a repack.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { RUNTIME_MANIFEST, sha256Hex, type RuntimeManifest } from "../repack/shared/runtime.ts";

const repository = resolvePath(new URL("../..", import.meta.url).pathname);

/** HEAD of this checkout, "-dirty" when tracked files differ from it. */
export function pocketjsCommit(): string {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repository });
  if (head.exitCode !== 0) return "unknown";
  const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: repository });
  return head.stdout.toString().trim() + (dirty.stdout.toString().trim() ? "-dirty" : "");
}

export async function writeRuntimeManifest(
  directory: string,
  fields: {
    target: string;
    hostAbi: number;
    profile: string;
    files: readonly string[];
    /** Target-specific fields written beside the common ones (an Android runtime's viewport and SDK levels). */
    extra?: Readonly<Record<string, unknown>>;
  },
): Promise<RuntimeManifest> {
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const name of fields.files) {
    const bytes = new Uint8Array(readFileSync(join(directory, name)));
    files[name] = { bytes: bytes.length, sha256: await sha256Hex(bytes) };
  }
  const manifest: RuntimeManifest = {
    target: fields.target,
    hostAbi: fields.hostAbi,
    pocketjs: pocketjsCommit(),
    profile: fields.profile,
    ...fields.extra,
    files,
  };
  writeFileSync(join(directory, RUNTIME_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
