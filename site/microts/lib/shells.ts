// The handhelds' shells the playground draws its devices in: a picture of each device from the front, a
// sheet of its keys, and where its screens and keys are in the picture (`profiles.js`). tools/handheld-shells.ts
// renders and writes them. The PSP and the 3DS are the Pocket3D player's; the others are site/microts/shells/.
// The pictures are copied to /shells/ and the profiles reach the app as `microts:shells`.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, SITE } from "./paths.ts";

const POCKET3D = join(ROOT, "devices/web/pocket-web-wgpu/web/shells");
const OWN = join(SITE, "shells");

/** Shell id → the directory of the set it is in. */
export const PLAYGROUND_SHELLS: Record<string, string> = {
  psp: POCKET3D,
  gba: OWN,
  "3ds": POCKET3D,
  "iphone-4s": OWN,
  "ipod-touch-5": OWN,
  "bb-classic": OWN,
  "ipod-nano": OWN,
};

interface Profile {
  art: string;
  partsArt?: string;
  [key: string]: unknown;
}

async function profiles(dir: string): Promise<Record<string, Profile>> {
  return (await import(pathToFileURL(join(dir, "profiles.js")).href)).SHELLS;
}

/** Every shell the playground uses, its pictures as URLs under /shells/. */
export async function shellProfiles(): Promise<Record<string, Profile>> {
  const sets = new Map<string, Record<string, Profile>>();
  const out: Record<string, Profile> = {};
  for (const [id, dir] of Object.entries(PLAYGROUND_SHELLS)) {
    if (!sets.has(dir)) sets.set(dir, await profiles(dir));
    const profile = sets.get(dir)![id];
    if (!profile) throw new Error(`shells: ${id} has no profile in ${dir}/profiles.js`);
    out[id] = { ...profile, art: `/shells/${profile.art}`, ...(profile.partsArt ? { partsArt: `/shells/${profile.partsArt}` } : {}) };
  }
  return out;
}

/** The pictures under `out`/shells/, with the credits and the licence they are offered under. */
export async function copyShells(out: string): Promise<void> {
  const to = join(out, "shells");
  mkdirSync(to, { recursive: true });
  for (const [id, dir] of Object.entries(PLAYGROUND_SHELLS)) {
    const profile = (await profiles(dir))[id]!;
    for (const file of [profile.art, profile.partsArt]) if (file) copyFileSync(join(dir, file), join(to, file));
  }
  copyFileSync(join(OWN, "ATTRIBUTION.md"), join(to, "ATTRIBUTION.md"));
  copyFileSync(join(ROOT, "pocket3d/LICENSE"), join(to, "LICENSE-Pocket3D.txt"));
}
