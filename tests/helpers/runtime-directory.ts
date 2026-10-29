// A runtime directory in memory, as tools/runtime/manifest.ts writes one:
// the program files, the stamped profile document and runtime.json listing
// both.

import { createHash } from "node:crypto";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { POCKET_PROFILE_FILE, type PocketProfile } from "../../contracts/spec/profile.ts";
import { hashPocketProfile } from "../../framework/src/profile.ts";

const encoder = new TextEncoder();

export function runtimeDirectory(
  profile: PocketProfile,
  files: ReadonlyMap<string, Uint8Array>,
  fields: { target?: string; hostAbi?: number; pocketjs?: string; extra?: Readonly<Record<string, unknown>> } = {},
): Map<string, Uint8Array> {
  const hostAbi = fields.hostAbi ?? POCKET_BINDING_GENERATION;
  const output = new Map(files);
  output.set(POCKET_PROFILE_FILE, encoder.encode(JSON.stringify({ ...profile, hostAbi }, null, 2) + "\n"));
  const listed = Object.fromEntries([...output].sort(([a], [b]) => a < b ? -1 : 1).map(([name, bytes]) =>
    [name, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }]));
  output.set("runtime.json", encoder.encode(JSON.stringify({
    ...fields.extra, target: fields.target ?? profile.id, hostAbi, pocketjs: fields.pocketjs ?? "0".repeat(40),
    profile: profile.id, profileHash: hashPocketProfile(profile), files: listed,
  })));
  return output;
}
