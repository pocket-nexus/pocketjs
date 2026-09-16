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
