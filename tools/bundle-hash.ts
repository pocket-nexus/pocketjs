// tools/bundle-hash.ts — the build-identity hash, host side.
//
// PSP build identity uses FNV-1a 64 over the embedded bytes. A compiled
// single-app .pocket hashes the complete file; a launcher hashes complete
// package files in table order. Legacy raw embedding hashes JS followed by
// pak. tools/build/psp/embed.rs produces the device value reported through
// OP.debugStats; the bridge must select the same input mode.
//
// Keep both implementations in lockstep; the published FNV-1a test vectors
// below are asserted in tests/devtools.test.ts.

import { readFileSync } from "node:fs";

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** FNV-1a 64 over the concatenation of `chunks`, as 16 hex digits. */
export function fnv1a64(...chunks: Uint8Array[]): string {
  let h = OFFSET;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      h ^= BigInt(chunk[i]);
      h = (h * PRIME) & MASK;
    }
  }
  return h.toString(16).padStart(16, "0");
}

/** Hash for legacy raw embedding: js file, then pak file.
 *  A missing pak hashes as empty — build.rs embeds an empty pak then too. */
export function bundleHash(jsPath: string, pakPath: string): string {
  const js = readFileSync(jsPath);
  let pak: Uint8Array;
  try {
    pak = readFileSync(pakPath);
  } catch {
    pak = new Uint8Array(0);
  }
  return fnv1a64(js, pak);
}

/** Multi-app twin (docs/LAUNCHER.md): the launcher EBOOT embeds `.pocket`
 *  package FILES verbatim, so its identity is FNV-1a64 over those files in
 *  table order — app 0 (the launcher), then each registry entry. `outputs`
 *  must match that order; packages live in `<dist>/packages/`. */
export function launcherBundleHash(dist: string, outputs: readonly string[]): string {
  const chunks: Uint8Array[] = [];
  for (const output of outputs) {
    chunks.push(readFileSync(`${dist}/packages/${output}.pocket`));
  }
  return fnv1a64(...chunks);
}
