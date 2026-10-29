// runtime.json beside a generic runtime: what tools/repack/shared/runtime.ts
// reads back to check the runtime directory before a repack.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { RUNTIME_MANIFEST, sha256Hex, type RuntimeManifest } from "../repack/shared/runtime.ts";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { POCKET_PROFILE_FILE, type PocketProfile } from "../../contracts/spec/profile.ts";
import { hashPocketProfile } from "../../framework/src/profile.ts";
import { releasedProfileDocument } from "../profile-export.ts";

const repository = resolvePath(new URL("../..", import.meta.url).pathname);

/** HEAD of this checkout, "-dirty" when tracked files differ from it. */
export function pocketjsCommit(): string {
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repository });
  if (!head.success) return "unknown";
  const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: repository });
  if (!dirty.success) return "unknown";
  return head.stdout.toString().trim() + (dirty.stdout.toString().trim() ? "-dirty" : "");
}

/** Write runtime.json and the stamped host contract beside the runtime's
 * files. Repack admits packages against that document. */
export async function writeRuntimeManifest(
  directory: string,
  fields: {
    target: string;
    hostAbi: number;
    /** The host contract the runtime was built for. */
    profile: PocketProfile;
    files: readonly string[];
    /** Target-specific fields written beside the common ones (an Android runtime's viewport and SDK levels). */
    extra?: Readonly<Record<string, unknown>>;
  },
): Promise<RuntimeManifest> {
  if (fields.hostAbi !== POCKET_BINDING_GENERATION) {
    throw new TypeError(`runtime manifest: binding generation ${fields.hostAbi} is unsupported; rebuild for ${POCKET_BINDING_GENERATION}`);
  }
  writeFileSync(join(directory, POCKET_PROFILE_FILE), JSON.stringify(releasedProfileDocument(fields.profile, fields.hostAbi), null, 2) + "\n");
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const name of [...fields.files, POCKET_PROFILE_FILE]) {
    const bytes = new Uint8Array(readFileSync(join(directory, name)));
    files[name] = { bytes: bytes.length, sha256: await sha256Hex(bytes) };
  }
  const manifest: RuntimeManifest = {
    ...fields.extra,
    target: fields.target,
    hostAbi: fields.hostAbi,
    pocketjs: pocketjsCommit(),
    profile: fields.profile.id,
    profileHash: hashPocketProfile(fields.profile),
    files,
  };
  writeFileSync(join(directory, RUNTIME_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
