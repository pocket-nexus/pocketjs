// PS Vita repack: the generic Vita runtime (tools/runtime/vita.ts) and a
// game's `.pocket` into a .vpk that VitaShell installs:
//
//   sce_sys/param.sfo                        written here: the game's TITLE and STITLE,
//                                            TITLE_ID "P" + the first 8 hex digits of
//                                            SHA-256(id), the other keys as vita-mksfoex
//                                            writes them for tools/vita.ts
//   eboot.bin                                the runtime's, unchanged
//   app.pocket                               the .pocket thinned to its vita variant
//   sce_sys/icon0.png                        128 x 128 indexed PNG-8 from identity.icon
//                                            (the runtime's icon when there is none)
//   sce_sys/livearea/contents/bg.png         the runtime's LiveArea files
//   sce_sys/livearea/contents/startup.png
//   sce_sys/livearea/contents/template.xml
//
// The entries are files only, param.sfo and eboot.bin first, as vita-pack-vpk
// writes them. At startup the runtime reads app0:app.pocket, checks the
// footer, the vita variant and host ABI 2, and runs the game
// (hosts/vita/src/package_file.rs). It has no compiled app id: the file is
// the app.

import { encodeIndexedPng, quantizeRgb } from "./shared/palette.ts";
import { decodePng } from "./shared/png.ts";
import { admitPocket, checkIdentity, readRuntime, sha256Hex, type RepackInput } from "./shared/runtime.ts";
import { fitRgba, flattenRgba } from "./shared/scale.ts";
import { writeSfo } from "./shared/sfo.ts";
import { writeZip } from "./shared/zip.ts";
import { utf8Prefix } from "./psp.ts";

export const VITA_RUNTIME_TARGET = "vita";
/** The runtime's program inside dist/runtime/vita/. */
export const VITA_RUNTIME_FILE = "eboot.bin";
export const VITA_ICON = "sce_sys/icon0.png";
export const VITA_LIVEAREA = [
  "sce_sys/livearea/contents/bg.png",
  "sce_sys/livearea/contents/startup.png",
  "sce_sys/livearea/contents/template.xml",
] as const;
export const VITA_ICON0 = { width: 128, height: 128 } as const;
/** The ground under a transparent icon: PocketJS's plum, the default bubble's. */
const ICON_GROUND = [0x17, 0x12, 0x26] as const;

/** PocketJS's Vita title id rule (framework/src/manifest/vita-package.ts vitaTitleId). */
export async function vitaTitleIdFor(id: string): Promise<string> {
  return `P${(await sha256Hex(new TextEncoder().encode(id))).slice(0, 8).toUpperCase()}`;
}

/**
 * The PARAM.SFO tools/vita.ts writes with `vita-mksfoex -d ATTRIBUTE2=12 -s
 * TITLE_ID=<id> <title>`: the same keys, formats, rooms and values, byte for
 * byte for a title of up to 51 bytes. A longer title is cut to fit STITLE
 * (51 bytes) and TITLE (127 bytes); vita-mksfoex overruns those rooms.
 */
export function vitaSfo(title: string, titleId: string): Uint8Array {
  if (!/^[A-Z][A-Z0-9]{8}$/.test(titleId)) throw new Error(`repack vita: invalid title id ${titleId}`);
  const name = title.trim();
  return writeSfo([
    { key: "APP_VER", value: "00.00", room: 8 },
    { key: "ATTRIBUTE", value: 0x8000 },
    { key: "ATTRIBUTE2", value: 12 },
    { key: "ATTRIBUTE_MINOR", value: 0x10 },
    { key: "BOOT_FILE", value: "", room: 32 },
    { key: "CATEGORY", value: "gd", room: 4 },
    { key: "CONTENT_ID", value: "", room: 48 },
    { key: "EBOOT_APP_MEMSIZE", value: 0 },
    { key: "EBOOT_ATTRIBUTE", value: 0 },
    { key: "EBOOT_PHY_MEMSIZE", value: 0 },
    { key: "LAREA_TYPE", value: 0 },
    { key: "NP_COMMUNICATION_ID", value: "", room: 16 },
    { key: "PARENTAL_LEVEL", value: 0 },
    { key: "PSP2_DISP_VER", value: "00.000", room: 8 },
    { key: "PSP2_SYSTEM_VER", value: 0 },
    { key: "STITLE", value: utf8Prefix(name, 51), room: 52 },
    { key: "TITLE", value: utf8Prefix(name, 127), room: 128 },
    { key: "TITLE_ID", value: titleId, room: 12 },
    { key: "VERSION", value: "00.00", room: 8 },
  ]);
}

/** identity.icon as the bubble: fitted into 128 x 128, over the plum ground, at most 256 colours. */
export async function vitaIcon0(icon: Uint8Array): Promise<Uint8Array> {
  const image = flattenRgba(fitRgba(await decodePng(icon), VITA_ICON0.width, VITA_ICON0.height), ICON_GROUND);
  const { indices, palette } = quantizeRgb(image, 256);
  return encodeIndexedPng(VITA_ICON0.width, VITA_ICON0.height, indices, palette);
}

export async function repackVita(input: RepackInput): Promise<Uint8Array> {
  checkIdentity(input.identity);
  const runtime = await readRuntime(input.runtime, VITA_RUNTIME_TARGET);
  const file = (name: string): Uint8Array => {
    const bytes = input.runtime.get(name);
    if (!bytes || !(name in runtime.files)) throw new Error(`repack vita: the runtime has no ${name}`);
    return bytes;
  };
  const eboot = file(VITA_RUNTIME_FILE);
  const liveArea = VITA_LIVEAREA.map((name) => ({ name, data: file(name) }));
  const pocket = admitPocket(input.pocket, runtime, input.identity);
  const titleId = await vitaTitleIdFor(input.identity.id);
  const icon = input.identity.icon ? await vitaIcon0(input.identity.icon) : file(VITA_ICON);
  return writeZip([
    { name: "sce_sys/param.sfo", data: vitaSfo(input.identity.title, titleId) },
    { name: VITA_RUNTIME_FILE, data: eboot },
    { name: "app.pocket", data: pocket.bytes },
    { name: VITA_ICON, data: icon },
    ...liveArea,
  ]);
}
