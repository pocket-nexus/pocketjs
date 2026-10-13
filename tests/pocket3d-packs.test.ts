// A game's packs as content-addressed pieces (tools/pocket3d-packs.ts): where a
// pack is cut, what two packs share, what a re-cook changes, and bringing a
// directory up to date.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUT_SIZES, PACKS_FILE, PACK_PIECES, bring, checkPacks, contentCuts, lacking, manifestText, parseManifest, pieceBounds, piecesOf, sectionCuts, writePacks } from "../tools/pocket3d-packs.ts";

const tmp = mkdtempSync(join(tmpdir(), "pocket3d-packs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Bytes that repeat nowhere, from a seed. */
function noise(seed: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let state = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** A pack laid out as a Pocket3D pack: four words, a table of 16 bytes a section, the sections on 64-byte boundaries. */
function pack(sections: Array<[string, Uint8Array]>): Uint8Array {
  const table = 16 + sections.length * 16;
  let at = (table + 63) & ~63;
  const offsets = sections.map(([, bytes]) => {
    const offset = at;
    at = (at + bytes.length + 63) & ~63;
    return offset;
  });
  const out = new Uint8Array(offsets.at(-1)! + sections.at(-1)![1].length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("TEST"), 0);
  view.setUint32(4, 1, true);
  view.setUint32(8, sections.length, true);
  for (const [i, [tag, bytes]] of sections.entries()) {
    out.set(new TextEncoder().encode(tag), 16 + i * 16);
    view.setUint32(20 + i * 16, offsets[i]!, true);
    view.setUint32(24 + i * 16, bytes.length, true);
    out.set(bytes, offsets[i]!);
  }
  return out;
}
const file = (name: string, bytes: Uint8Array): string => {
  writeFileSync(join(tmp, name), bytes);
  return join(tmp, name);
};

const SMALL = { min: 4 << 10, max: 32 << 10, bits: 13 };
const figures = noise(7, 20_000);
const street = pack([["SCEN", noise(1, 200)], ["WRLD", noise(2, 300_000)], ["FIGS", figures]]);
const yards = pack([["SCEN", noise(3, 200)], ["WRLD", noise(4, 120_000)], ["FIGS", figures]]);

describe("where a pack is cut", () => {
  test("at the beginning of each of its sections, read from its table", () => {
    expect(sectionCuts(street)).toEqual([64, 320, 300_352]);
    // A file with no such table has none: it is cut by its content alone.
    expect(sectionCuts(noise(9, 4096))).toEqual([]);
    expect(sectionCuts(new Uint8Array(8))).toEqual([]);
  });

  test("inside a long section where its content says so, between the least and the most a piece may be", () => {
    const bounds = pieceBounds(street, sectionCuts(street), SMALL);
    expect(bounds[0]).toBe(0);
    expect(bounds.at(-1)).toBe(street.length);
    for (const cut of sectionCuts(street)) expect(bounds).toContain(cut);
    const sizes = bounds.slice(1).map((end, i) => end - bounds[i]!);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(SMALL.max);
    // Every piece cut by content is at least the least; the ones that end at a section's end may be shorter.
    const inside = contentCuts(street, 320, 300_352, SMALL);
    expect(inside.length).toBeGreaterThan(8);
    let before = 320;
    for (const cut of inside) {
      expect(cut - before).toBeGreaterThanOrEqual(SMALL.min);
      before = cut;
    }
    // A section no longer than the most is one piece.
    expect(contentCuts(street, 300_352, street.length, SMALL)).toEqual([]);
  });

  test("the same bytes are cut at the same places wherever they lie", () => {
    const body = noise(11, 200_000);
    const shifted = new Uint8Array(body.length + 777);
    shifted.set(noise(12, 777), 0);
    shifted.set(body, 777);
    const a = contentCuts(body, 0, body.length, SMALL);
    const b = contentCuts(shifted, 0, shifted.length, SMALL).map((cut) => cut - 777);
    // After the first few cuts the two agree: most of the cuts of one are cuts of the other.
    const shared = a.filter((cut) => b.includes(cut)).length;
    expect(shared).toBeGreaterThanOrEqual(a.length - 3);
  });
});

describe("a game's packs in one directory", () => {
  const out = join(tmp, "packs");
  const written = writePacks(out, [{ name: "street", file: file("street.pack", street) }, { name: "yards", file: file("yards.pack", yards) }], SMALL);

  test("each pack is its pieces one after another, and the manifest is named by its own bytes", () => {
    expect(written.manifest).toMatch(/^[0-9a-f]{16}\.packs$/);
    expect(written.text.split("\n")[0]).toBe(PACK_PIECES);
    expect(parseManifest(readFileSync(join(out, written.manifest), "utf8"))).toEqual(written.packs);
    expect(manifestText(written.packs)).toBe(written.text);
    for (const [bytes, listed] of [[street, written.packs[0]!], [yards, written.packs[1]!]] as const) {
      const joined = Buffer.concat(listed.pieces.map((piece) => readFileSync(join(out, `${piece.name}.bin`))));
      expect(joined.equals(Buffer.from(bytes))).toBe(true);
      expect(listed.bytes).toBe(bytes.length);
    }
    expect(checkPacks(out, written.manifest).pieces).toBe(piecesOf(written.packs).length);
  });

  test("a section two packs share is one piece, stored once", () => {
    const [a, b] = written.packs.map((each) => each.pieces.map((piece) => piece.name));
    expect(a!.at(-1)).toBe(b!.at(-1)!);
    expect(written.bytes).toBe(street.length + yards.length);
    expect(written.stored).toBe(written.bytes - figures.length);
    expect(readdirSync(out).filter((name) => name.endsWith(".bin")).length).toBe(piecesOf(written.packs).length);
  });

  test("a pack cooked again changes the pieces whose bytes changed, and no others", () => {
    // The world's middle changes and grows; the scene, the world's two ends and the figures are as they were.
    const world = noise(2, 300_000);
    const grown = new Uint8Array(world.length + 5000);
    grown.set(world.subarray(0, 150_000), 0);
    grown.set(noise(99, 5000), 150_000);
    grown.set(world.subarray(150_000), 155_000);
    const again = pack([["SCEN", noise(1, 200)], ["WRLD", grown], ["FIGS", figures]]);
    const next = writePacks(out, [{ name: "street", file: file("street2.pack", again) }, { name: "yards", file: join(tmp, "yards.pack") }], SMALL);
    const before = new Set(written.packs[0]!.pieces.map((piece) => piece.name));
    const fresh = next.packs[0]!.pieces.filter((piece) => !before.has(piece.name));
    // The table (a section's offset moved), and the pieces around the change.
    expect(fresh.length).toBeLessThanOrEqual(5);
    expect(next.written).toBe(fresh.reduce((sum, piece) => sum + piece.bytes, 0));
    expect(next.written).toBeLessThan(again.length / 4);
    expect(next.packs[1]).toEqual(written.packs[1]!);
  });

  test("a directory is brought up to date with the pieces it lacks, and the manifest last", () => {
    const to = join(tmp, "device");
    const first = bring(out, written.manifest, to);
    expect([first.sent, first.had, first.bytes]).toEqual([piecesOf(written.packs).length, 0, written.stored]);
    expect(readFileSync(join(to, PACKS_FILE), "utf8")).toBe(written.text);
    expect(checkPacks(to, PACKS_FILE).packs).toEqual(written.packs);
    // Again: nothing to send.
    expect(bring(out, written.manifest, to)).toEqual({ sent: 0, bytes: 0, had: first.sent, removed: 0 });
    // A piece that is short is sent again; a piece no manifest names goes with --prune.
    const one = written.packs[0]!.pieces[1]!;
    writeFileSync(join(to, `${one.name}.bin`), new Uint8Array(3));
    writeFileSync(join(to, "00000000000000000000.bin"), new Uint8Array(1));
    expect(lacking(to, written.packs)).toEqual([one]);
    expect(bring(out, written.manifest, to, { prune: true })).toEqual({ sent: 1, bytes: one.bytes, had: first.sent - 1, removed: 1 });
    expect(existsSync(join(to, "00000000000000000000.bin"))).toBe(false);
  });

  test("a directory with a piece that is not what its name says is refused", () => {
    const to = join(tmp, "spoiled");
    bring(out, written.manifest, to);
    const one = written.packs[1]!.pieces[0]!;
    const bytes = readFileSync(join(to, `${one.name}.bin`));
    bytes[0] = bytes[0]! ^ 1;
    writeFileSync(join(to, `${one.name}.bin`), bytes);
    expect(() => checkPacks(to, PACKS_FILE)).toThrow("is not the piece its name says");
  });

  test("a manifest the devices' reader would refuse is refused here", () => {
    const sha = "0".repeat(64);
    expect(() => parseManifest("pocket-pack-pieces/1\n")).toThrow("is not a");
    expect(() => parseManifest(`${PACK_PIECES}\n0000000000000000000a 4\n`)).toThrow("a piece of no pack");
    expect(() => parseManifest(`${PACK_PIECES}\npack street 5 ${sha}\n0000000000000000000a 4\n`)).toThrow("do not make up its size");
    expect(() => parseManifest(`${PACK_PIECES}\npack Street 4 ${sha}\n`)).toThrow("line 2");
    expect(() => writePacks(join(tmp, "x"), [{ name: "Bad Name", file: join(tmp, "yards.pack") }])).toThrow("is not a pack's name");
    expect(CUT_SIZES.max).toBeLessThanOrEqual(8 << 20);
  });
});
