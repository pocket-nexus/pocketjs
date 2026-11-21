// tools/pocket3d-packs.ts: a Pocket3D game's packs as content-addressed
// pieces, the manifest every device reads (engine/pocket3d/crates/pocket3d-packs),
// and bringing a device's copy up to date with only the pieces it lacks.
//
//   bun tools/pocket3d-packs.ts cut <directory> <name>=<pack>...
//       Cuts each pack into pieces under <directory> (a piece's file is the
//       first 20 hexadecimal digits of its SHA-256, `.bin`) and writes the
//       manifest that lists them, named by its own hash. A piece two packs
//       share is one file.
//   bun tools/pocket3d-packs.ts check <directory> <manifest>
//       Every piece is there with the size and the bytes its name says, and
//       each pack's pieces make up the pack the manifest names.
//   bun tools/pocket3d-packs.ts bring <directory> <manifest> <to> [--prune]
//       Copies into <to> the pieces it lacks and then the manifest, as
//       `pocket.packs`: the directory a handheld's program reads beside
//       itself, or the one a release archive is made from. --prune removes
//       the pieces of <to> the manifest does not name.
//
// A pack is cut **where its sections begin** (`sectionCuts` reads the table a
// Pocket3D pack starts with), so a section two packs share is the same piece
// in both, and **inside a section longer than `max` where its content says
// so** (`contentCuts`), so a change in one part of a long section leaves the
// pieces of its other parts as they were.
//
// A game's build tool imports these functions from its PocketJS checkout; the
// command line is the same functions.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The first line of a manifest (`pocket3d_packs::FORMAT`). */
export const PACK_PIECES = "pocket-pack-pieces/2";
/** The manifest's name in a directory a handheld's program reads. */
export const PACKS_FILE = "pocket.packs";
/** Hexadecimal digits in a piece's name. */
const DIGITS = 20;

export interface Piece {
  /** The first 20 hexadecimal digits of the SHA-256 of the piece's bytes. */
  name: string;
  bytes: number;
}
export interface Pack {
  /** Lowercase letters, digits and hyphens, 24 at most. */
  name: string;
  bytes: number;
  sha256: string;
  pieces: Piece[];
}

export interface CutSizes {
  /** No piece cut by content is shorter (bytes). */
  min: number;
  /** A section of this size or less is one piece, and no piece is longer. */
  max: number;
  /** Bits of the rolling hash that are zero at a cut: a cut every 2^bits bytes on average, after `min`. */
  bits: number;
}
export const CUT_SIZES: CutSizes = { min: 512 << 10, max: 4 << 20, bits: 20 };

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export const pieceFile = (piece: Piece): string => `${piece.name}.bin`;

/**
 * Where the sections of a Pocket3D pack begin: the file starts with four
 * 32-bit words (a mark, a version, the number of sections, a spare) and a
 * table of 16 bytes a section (a tag, its offset, its size, a spare). Returns
 * the offsets in rising order, or none for a file that is not laid out so.
 */
export function sectionCuts(bytes: Uint8Array): number[] {
  if (bytes.length < 32) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  const table = 16 + count * 16;
  if (count < 1 || count > 4096 || table > bytes.length) return [];
  const cuts: number[] = [];
  for (let i = 0; i < count; i++) {
    const offset = view.getUint32(16 + i * 16 + 4, true);
    const size = view.getUint32(16 + i * 16 + 8, true);
    if (offset < table || offset + size > bytes.length) return [];
    cuts.push(offset);
  }
  return [...new Set(cuts)].sort((a, b) => a - b);
}

/** One 32-bit number a byte value, the same on every machine: what the rolling hash adds for a byte. */
const GEAR = (() => {
  const table = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    table[i] = (t ^ (t >>> 14)) >>> 0;
  }
  return table;
})();

/**
 * Cuts inside `bytes[from, to)` chosen by the content: a hash of the last 32
 * bytes rolls along, and a cut falls where its upper `bits` bits are zero, no
 * nearer than `min` to the cut before and no farther than `max`. The same
 * bytes are cut at the same places wherever they lie in a file, so bytes
 * inserted or changed move the cuts around them and no others.
 */
export function contentCuts(bytes: Uint8Array, from: number, to: number, sizes: CutSizes = CUT_SIZES): number[] {
  const cuts: number[] = [];
  const mask = (~0 << (32 - sizes.bits)) >>> 0;
  let start = from;
  while (to - start > sizes.max) {
    let hash = 0;
    let at = start + sizes.min - 32;
    const end = start + sizes.max;
    let cut = end;
    for (; at < end; at++) {
      hash = ((hash << 1) + GEAR[bytes[at]!]!) >>> 0;
      if (at >= start + sizes.min && (hash & mask) === 0) {
        cut = at + 1;
        break;
      }
    }
    cuts.push(cut);
    start = cut;
  }
  return cuts;
}

/** Every place a pack is cut, 0 and its length among them: at `cuts` and, between two of them that are far apart, by content. */
export function pieceBounds(bytes: Uint8Array, cuts: readonly number[], sizes: CutSizes = CUT_SIZES): number[] {
  const marks = [...new Set([0, ...cuts.filter((c) => c > 0 && c < bytes.length), bytes.length])].sort((a, b) => a - b);
  const bounds: number[] = [0];
  for (let i = 1; i < marks.length; i++) {
    bounds.push(...contentCuts(bytes, marks[i - 1]!, marks[i]!, sizes), marks[i]!);
  }
  return bounds;
}

/** A manifest's text. */
export function manifestText(packs: readonly Pack[]): string {
  const lines = [PACK_PIECES];
  for (const pack of packs) {
    lines.push(`pack ${pack.name} ${pack.bytes} ${pack.sha256}`);
    for (const piece of pack.pieces) lines.push(`${piece.name} ${piece.bytes}`);
  }
  return lines.join("\n") + "\n";
}

/** The packs of a manifest's text. Throws on a text the devices' reader would refuse. */
export function parseManifest(text: string): Pack[] {
  const lines = text.split("\n").map((line) => line.trimEnd());
  if (lines[0] !== PACK_PIECES) throw new Error(`pocket3d-packs: the manifest is not a "${PACK_PIECES}"`);
  const packs: Pack[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    if (line === "") continue;
    const words = line.split(" ");
    const refuse = () => new Error(`pocket3d-packs: line ${index + 2} of the manifest is neither a pack nor a piece`);
    if (words[0] === "pack") {
      if (words.length !== 4 || !/^[a-z0-9-]{1,24}$/.test(words[1]!) || !/^\d+$/.test(words[2]!) || !/^[0-9a-f]{64}$/.test(words[3]!)) throw refuse();
      if (packs.some((p) => p.name === words[1])) throw new Error(`pocket3d-packs: the manifest names the pack "${words[1]}" twice`);
      packs.push({ name: words[1]!, bytes: Number(words[2]), sha256: words[3]!, pieces: [] });
    } else {
      if (words.length !== 2 || !new RegExp(`^[0-9a-f]{${DIGITS}}$`).test(words[0]!) || !/^[1-9]\d*$/.test(words[1]!)) throw refuse();
      const pack = packs.at(-1);
      if (!pack) throw new Error(`pocket3d-packs: line ${index + 2} of the manifest is a piece of no pack`);
      pack.pieces.push({ name: words[0]!, bytes: Number(words[1]) });
    }
  }
  for (const pack of packs) {
    if (pack.pieces.reduce((sum, piece) => sum + piece.bytes, 0) !== pack.bytes) throw new Error(`pocket3d-packs: the pieces of the pack "${pack.name}" do not make up its size`);
  }
  return packs;
}

/** Every piece the packs name, each once. */
export function piecesOf(packs: readonly Pack[]): Piece[] {
  const seen = new Map<string, Piece>();
  for (const piece of packs.flatMap((pack) => pack.pieces)) if (!seen.has(piece.name)) seen.set(piece.name, piece);
  return [...seen.values()];
}

export interface Written {
  /** The manifest's file under the directory: `<16 hexadecimal digits of its hash>.packs`. */
  manifest: string;
  text: string;
  packs: Pack[];
  /** Bytes of the packs, one after another. */
  bytes: number;
  /** Bytes of the pieces, each counted once: what the directory holds of them. */
  stored: number;
  /** Bytes of the pieces this call wrote: the others were there. */
  written: number;
}

/**
 * Cuts each pack into pieces under `out` and writes the manifest that lists
 * them. `cuts` are a pack's own boundaries; without them `sectionCuts` reads
 * the pack's table. A piece whose file is there is not written again.
 */
export function writePacks(out: string, packs: ReadonlyArray<{ name: string; file: string; cuts?: readonly number[] }>, sizes: CutSizes = CUT_SIZES): Written {
  mkdirSync(out, { recursive: true });
  const listed: Pack[] = [];
  let written = 0;
  for (const each of packs) {
    if (!/^[a-z0-9-]{1,24}$/.test(each.name)) throw new Error(`pocket3d-packs: "${each.name}" is not a pack's name (lowercase letters, digits and hyphens, 24 at most)`);
    const whole = readFileSync(each.file);
    const bounds = pieceBounds(whole, each.cuts ?? sectionCuts(whole), sizes);
    const pieces: Piece[] = [];
    for (let i = 1; i < bounds.length; i++) {
      const piece = whole.subarray(bounds[i - 1]!, bounds[i]!);
      const entry = { name: sha256(piece).slice(0, DIGITS), bytes: piece.length };
      pieces.push(entry);
      const file = join(out, pieceFile(entry));
      if (!existsSync(file) || statSync(file).size !== piece.length) {
        writeFileSync(file, piece);
        written += piece.length;
      }
    }
    listed.push({ name: each.name, bytes: whole.length, sha256: sha256(whole), pieces });
  }
  const text = manifestText(listed);
  const manifest = `${sha256(new TextEncoder().encode(text)).slice(0, 16)}.packs`;
  writeFileSync(join(out, manifest), text);
  checkPacks(out, manifest);
  return { manifest, text, packs: listed, bytes: listed.reduce((sum, pack) => sum + pack.bytes, 0), stored: piecesOf(listed).reduce((sum, piece) => sum + piece.bytes, 0), written };
}

/** Reads the directory against its manifest: every piece's size and bytes, and each pack whole. Throws on the first fault. */
export function checkPacks(directory: string, manifest: string): { packs: Pack[]; pieces: number; stored: number } {
  const packs = parseManifest(readFileSync(join(directory, manifest), "utf8"));
  const pieces = piecesOf(packs);
  for (const piece of pieces) {
    const file = join(directory, pieceFile(piece));
    if (!existsSync(file)) throw new Error(`pocket3d-packs: ${pieceFile(piece)} is missing from ${directory}`);
    const bytes = readFileSync(file);
    if (bytes.length !== piece.bytes || sha256(bytes).slice(0, DIGITS) !== piece.name) throw new Error(`pocket3d-packs: ${pieceFile(piece)} in ${directory} is not the piece its name says`);
  }
  for (const pack of packs) {
    const whole = new Bun.CryptoHasher("sha256");
    for (const piece of pack.pieces) whole.update(readFileSync(join(directory, pieceFile(piece))));
    if (whole.digest("hex") !== pack.sha256) throw new Error(`pocket3d-packs: the pieces of "${pack.name}" in ${directory} do not make up the pack`);
  }
  return { packs, pieces: pieces.length, stored: pieces.reduce((sum, piece) => sum + piece.bytes, 0) };
}

/** The pieces of a manifest that a directory lacks (no file, or one of another size). */
export function lacking(directory: string, packs: readonly Pack[]): Piece[] {
  return piecesOf(packs).filter((piece) => {
    const file = join(directory, pieceFile(piece));
    return !existsSync(file) || statSync(file).size !== piece.bytes;
  });
}

export interface Brought {
  /** Pieces copied, and their bytes. */
  sent: number;
  bytes: number;
  /** Pieces that were there. */
  had: number;
  /** Pieces removed (`prune`). */
  removed: number;
}

/**
 * Brings `to` up to date with a manifest of `from`: copies the pieces `to`
 * lacks, then writes the manifest there under `as` (`pocket.packs`), so a
 * program that reads `to` while this runs finds the old manifest with all its
 * pieces or the new one with all of its. `prune` then removes the pieces the
 * manifest does not name.
 */
export function bring(from: string, manifest: string, to: string, options: { as?: string; prune?: boolean } = {}): Brought {
  const text = readFileSync(join(from, manifest), "utf8");
  const packs = parseManifest(text);
  mkdirSync(to, { recursive: true });
  const need = lacking(to, packs);
  for (const piece of need) copyFileSync(join(from, pieceFile(piece)), join(to, pieceFile(piece)));
  writeFileSync(join(to, options.as ?? PACKS_FILE), text);
  let removed = 0;
  if (options.prune) {
    const named = new Set(piecesOf(packs).map(pieceFile));
    for (const file of readdirSync(to)) {
      if (new RegExp(`^[0-9a-f]{${DIGITS}}\\.bin$`).test(file) && !named.has(file)) {
        rmSync(join(to, file));
        removed++;
      }
    }
  }
  return { sent: need.length, bytes: need.reduce((sum, piece) => sum + piece.bytes, 0), had: piecesOf(packs).length - need.length, removed };
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const mib = (bytes: number) => `${(bytes / (1 << 20)).toFixed(1)} MiB`;
  if (command === "cut" && rest.length >= 2 && rest.slice(1).every((each) => each.includes("="))) {
    const written = writePacks(rest[0]!, rest.slice(1).map((each) => ({ name: each.slice(0, each.indexOf("=")), file: each.slice(each.indexOf("=") + 1) })));
    console.log(`${written.manifest}: ${written.packs.length} packs of ${mib(written.bytes)} in ${piecesOf(written.packs).length} pieces of ${mib(written.stored)}; ${mib(written.written)} written`);
  } else if (command === "check" && rest.length === 2) {
    const checked = checkPacks(rest[0]!, rest[1]!);
    console.log(`${checked.packs.length} packs, ${checked.pieces} pieces, ${mib(checked.stored)}: every piece is what its name says`);
  } else if (command === "bring" && rest.filter((each) => each !== "--prune").length === 3) {
    const [from, manifest, to] = rest.filter((each) => each !== "--prune") as [string, string, string];
    const brought = bring(from, manifest, to, { prune: rest.includes("--prune") });
    console.log(`${brought.sent} pieces copied (${mib(brought.bytes)}), ${brought.had} were there${brought.removed ? `, ${brought.removed} removed` : ""}`);
  } else {
    console.error("usage: bun tools/pocket3d-packs.ts cut <directory> <name>=<pack>... | check <directory> <manifest> | bring <directory> <manifest> <to> [--prune]");
    process.exit(1);
  }
}
