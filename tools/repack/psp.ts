// PSP repack: the generic PSP runtime (tools/runtime/psp.ts) and a game's
// `.pocket` into a .zip for the root of a Memory Stick:
//
//   PSP/GAME/Studio<Name>/EBOOT.PBP    the runtime's PBP: PARAM.SFO written
//                                      again with the game's TITLE and
//                                      MEMSIZE = 1, ICON0 from identity.icon
//   PSP/GAME/Studio<Name>/app.pocket   the .pocket thinned to its psp variant
//
// The runtime's DATA.PSP (the program) travels unchanged; at boot it reads
// app.pocket from its own folder, checks the footer, the psp variant and the
// host ABI, and runs the game (hosts/psp/src/package_file.rs).
//
// MEMSIZE = 1 asks the firmware of a PSP-2000 or 3000 for the 52 MB user
// partition instead of 24 MB: the runtime holds the whole game file in
// memory beside the QuickJS heap. A PSP-1000 ignores it.

import { decodePng, encodePng } from "./shared/png.ts";
import { admitPocket, checkIdentity, planFeatures, readRuntime, sha256Hex, type RepackIdentity, type RepackInput } from "./shared/runtime.ts";
import { fitRgba } from "./shared/scale.ts";
import { readSfo, writeSfo, type SfoEntry } from "./shared/sfo.ts";
import { writeZip } from "./shared/zip.ts";

export const PSP_RUNTIME_TARGET = "psp";
/** The runtime's program inside dist/runtime/psp/. */
export const PSP_RUNTIME_FILE = "EBOOT.PBP";
export const PSP_ICON0 = { width: 144, height: 80 } as const;
/** Room the PSP firmware reserves for TITLE (127 bytes of UTF-8 and the NUL). */
const TITLE_ROOM = 128;
const FOLDER_NAME_LIMIT = 32;
/** Features the runtime build leaves out (no offload slot); a plan that asks for one is refused. */
const UNSUPPORTED_FEATURES = ["io.offload"] as const;

/** A PBP's eight parts in order: PARAM.SFO, ICON0.PNG, ICON1.PMF, PIC0.PNG, PIC1.PNG, SND0.AT3, DATA.PSP, DATA.PSAR. */
export function pbpParts(pbp: Uint8Array): Uint8Array[] {
  const view = new DataView(pbp.buffer, pbp.byteOffset, pbp.byteLength);
  if (pbp.length < 40 || view.getUint32(0, false) !== 0x00504250) throw new Error("repack psp: not a PBP");
  const at = Array.from({ length: 8 }, (_, i) => view.getUint32(8 + i * 4, true));
  for (let i = 0; i < 8; i++) {
    const end = i < 7 ? at[i + 1]! : pbp.length;
    if (at[i]! < 40 || at[i]! > end || end > pbp.length) throw new Error("repack psp: the PBP's part table is out of order");
  }
  return at.map((start, i) => pbp.subarray(start, i < 7 ? at[i + 1] : pbp.length));
}

export function pbpWrite(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length !== 8) throw new Error("repack psp: a PBP has eight parts");
  const out = new Uint8Array(40 + parts.reduce((n, p) => n + p.length, 0));
  const view = new DataView(out.buffer);
  out.set([0, 0x50, 0x42, 0x50]); // "\0PBP"
  view.setUint32(4, 0x00010000, true);
  let at = 40;
  parts.forEach((part, i) => {
    view.setUint32(8 + i * 4, at, true);
    out.set(part, at);
    at += part.length;
  });
  return out;
}

/** "Snack Snake" -> "SnackSnake": the ASCII letters and digits of a title, each word capitalised (pocket-studio's rule). */
export function pascal(title: string): string {
  return title
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("");
}

/** The folder under PSP/GAME: "Studio" and the title's ASCII words, else the id's last segment's. */
export async function pspFolder(identity: Pick<RepackIdentity, "id" | "title">): Promise<string> {
  const name = pascal(identity.title) || pascal(identity.id.split(".").pop() ?? "") ||
    (await sha256Hex(new TextEncoder().encode(identity.id))).slice(0, 8).toUpperCase();
  return `Studio${name}`.slice(0, FOLDER_NAME_LIMIT);
}

/** `text` cut to at most `limit` bytes of UTF-8 without splitting a character. */
export function utf8Prefix(text: string, limit: number): string {
  let out = "";
  let bytes = 0;
  for (const character of text) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > limit) break;
    out += character;
    bytes += size;
  }
  return out;
}

/** The runtime's PARAM.SFO with the game's TITLE and MEMSIZE = 1; every other value kept. */
export function pspSfo(runtimeSfo: Uint8Array, title: string): Uint8Array {
  const kept: SfoEntry[] = readSfo(runtimeSfo)
    .filter((entry) => entry.key !== "TITLE" && entry.key !== "MEMSIZE")
    .map((entry) => ({ key: entry.key, value: entry.value, room: typeof entry.value === "string" ? entry.room : undefined }));
  return writeSfo([
    ...kept,
    { key: "MEMSIZE", value: 1 },
    { key: "TITLE", value: utf8Prefix(title.trim(), TITLE_ROOM - 1), room: TITLE_ROOM },
  ]);
}

/** identity.icon fitted into the XMB's 144 x 80 ICON0, centred on transparency. */
export async function pspIcon0(icon: Uint8Array): Promise<Uint8Array> {
  return encodePng(fitRgba(await decodePng(icon), PSP_ICON0.width, PSP_ICON0.height));
}

export async function repackPsp(input: RepackInput): Promise<Uint8Array> {
  checkIdentity(input.identity);
  const runtime = await readRuntime(input.runtime, PSP_RUNTIME_TARGET);
  const program = input.runtime.get(PSP_RUNTIME_FILE);
  if (!program || !(PSP_RUNTIME_FILE in runtime.files)) throw new Error(`repack psp: the runtime has no ${PSP_RUNTIME_FILE}`);
  const pocket = admitPocket(input.pocket, runtime, input.identity);
  const features = planFeatures(pocket.plan);
  for (const feature of UNSUPPORTED_FEATURES) {
    if (features[feature] === true) throw new Error(`repack psp: the plan asks for ${feature}, which the PSP runtime leaves out`);
  }
  const parts = pbpParts(program);
  parts[0] = pspSfo(parts[0]!, input.identity.title);
  if (input.identity.icon) parts[1] = await pspIcon0(input.identity.icon);
  const folder = `PSP/GAME/${await pspFolder(input.identity)}`;
  const directory = (name: string) => ({ name, data: new Uint8Array(0) });
  return writeZip([
    directory("PSP/"),
    directory("PSP/GAME/"),
    directory(`${folder}/`),
    { name: `${folder}/EBOOT.PBP`, data: pbpWrite(parts) },
    { name: `${folder}/app.pocket`, data: pocket.bytes },
  ]);
}
