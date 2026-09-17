import { expect, test } from "bun:test";
import { decodeArchiveFace } from "../contracts/spec/font-archive.ts";
import {
  bakeFontArchive,
  glyphChecksum,
} from "../framework/compiler/font-archive.ts";

test("24 compact strike descriptors fit the offload payload and reject ambiguous slots", () => {
  const face = {
    generation: 0xffffffff,
    identity: "a".repeat(64),
    strikes: Array.from({ length: 24 }, (_, s) => [
      s,
      64,
      64,
      48,
      64,
      64,
      1,
      65535,
    ]),
  };
  const payload = JSON.stringify(face);
  expect(payload.length).toBeLessThanOrEqual(2500);
  expect(decodeArchiveFace(payload).strikes).toHaveLength(24);
  face.strikes[1][0] = 0;
  expect(() => decodeArchiveFace(JSON.stringify(face))).toThrow();
  for (const strikes of [
    [],
    [[0, 255, 255, 15, 20, 16, 1, 10]],
    [[0, 16, 20, 16, 20, 16, 2, 10]],
    [[24, 16, 20, 16, 20, 16, 1, 10]],
  ])
    expect(() =>
      decodeArchiveFace(JSON.stringify({ ...face, strikes })),
    ).toThrow();
});

test("archive cmap preserves distinct dynamic CJK coverage and checksums each packed cell", async () => {
  const bytes = await bakeFontArchive({
    font: "assets/fonts/NotoSansCJK-Demo.otf",
    slots: [2],
    codepoints: Array.from("你好気迫", (c) => c.codePointAt(0)!),
  });
  const v = new DataView(bytes.buffer),
    count = v.getUint32(72, true),
    index = v.getUint32(76, true),
    data = v.getUint32(80, true),
    packed = Math.ceil((bytes[65] * bytes[66]) / 4);
  let previous = -1;
  const present = new Set<number>();
  for (let i = 0; i < count; i++) {
    const at = index + i * 12,
      cp = v.getUint32(at, true),
      gid = v.getUint16(at + 4, true);
    expect(cp).toBeGreaterThan(previous);
    previous = cp;
    present.add(cp);
    expect(
      glyphChecksum(
        bytes.subarray(data + gid * packed, data + (gid + 1) * packed),
      ),
    ).toBe(v.getUint32(at + 8, true));
  }
  for (const c of "你好気迫") expect(present.has(c.codePointAt(0)!)).toBe(true);
  expect(data + packed * count).toBe(bytes.length);
});

// CFF paths can omit the last-to-first edge in their command list. An archive
// checksum can protect a malformed raster too: test geometry before transport.
test("CFF kanji and fullwidth archive cells match explicitly closed source contours", async () => {
  const { default: opentype } = await import("opentype.js");
  const { bakeSlot, DEFAULT_REGULAR, DEFAULT_BOLD } = await import("../framework/compiler/bake-font.ts");
  const { fontSlotInfo } = await import("../framework/compiler/tailwind.ts");
  const fallback = opentype.parse(await Bun.file("assets/fonts/NotoSansCJK-Demo.otf").arrayBuffer());
  let implicit = 0;
  for (let i = 0; i < fallback.glyphs.length; i++) {
    const glyph = fallback.glyphs.get(i), getPath = glyph.getPath.bind(glyph);
    glyph.getPath = (...args: Parameters<typeof getPath>) => {
      const path = getPath(...args), commands: typeof path.commands = [];
      let start: { x: number; y: number } | undefined;
      const close = () => { if (start) { commands.push({ type: "L", ...start }); start = undefined; implicit++; } };
      for (const command of path.commands) {
        if (command.type === "M") { close(); start = { x: command.x, y: command.y }; }
        if (command.type === "Z") start = undefined;
        commands.push(command);
      }
      close(); path.commands = commands; return path;
    };
  }
  const chars = Array.from("気迫Ａ１𠮷", c => c.codePointAt(0)!);
  const slots = [0, 1, 2, 5, 7];
  const bytes = await bakeFontArchive({ font: "assets/fonts/NotoSansCJK-Demo.otf", slots, codepoints: chars });
  const v = new DataView(bytes.buffer);
  for (const [s, slot] of slots.entries()) {
    const info = fontSlotInfo(slot);
    const primary = opentype.parse(await Bun.file(info.bold ? DEFAULT_BOLD : DEFAULT_REGULAR).arrayBuffer());
    const reference = bakeSlot(primary, slot, info.px, info.bold, chars, 1, [fallback]);
    const rv = new DataView(reference.bytes.buffer);
    const d = 64 + s * 32, w = bytes[d + 1], h = bytes[d + 2];
    const count = v.getUint32(d + 8, true), index = v.getUint32(d + 12, true), data = v.getUint32(d + 16, true);
    const stride = Math.ceil(w * h / 4);
    for (const cp of chars) {
      const entry = Array.from({ length: count }, (_, i) => index + i * 12).find(at => v.getUint32(at, true) === cp)!;
      expect(entry, `U+${cp.toString(16)} in slot ${slot}`).toBeDefined();
      const ridx = Array.from({ length: reference.glyphCount }, (_, i) => 16 + i * 8).find(at => rv.getUint32(at, true) === cp)!;
      expect(ridx).toBeDefined();
      const gid = v.getUint16(entry + 4, true), rgid = rv.getUint16(ridx + 4, true);
      const referenceStart = 16 + reference.glyphCount * 8 + rgid * reference.cellW * reference.cellH;
      const actual: number[] = [], expected: number[] = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x;
        actual.push(((bytes[data + gid * stride + (p >> 2)] >> (6 - 2 * (p % 4))) & 3) * 85);
        const sample = x < reference.cellW && y < reference.cellH ? reference.bytes[referenceStart + y * reference.cellW + x] : 0;
        expected.push(Math.round(sample / 85) * 85);
      }
      expect(actual, `slot ${slot}, U+${cp.toString(16)}`).toEqual(expected);
      expect(actual.some(value => value > 0)).toBe(true);
    }
  }
  expect(implicit).toBeGreaterThan(0);
});
