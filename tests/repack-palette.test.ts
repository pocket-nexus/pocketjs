import { describe, expect, test } from "bun:test";
import { encodeIndexedPng, quantizeRgb } from "../tools/repack/shared/palette.ts";
import { decodePng } from "../tools/repack/shared/png.ts";

describe("palette", () => {
  test("reduces to at most the limit and writes an indexed PNG-8 that decodes to the palette colours", async () => {
    const width = 32, height = 32;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([x * 8, y * 8, (x + y) * 4, 255], (y * width + x) * 4);
    const { indices, palette } = quantizeRgb({ width, height, rgba }, 16);
    expect(palette.length).toBeLessThanOrEqual(48);
    expect(Math.max(...indices)).toBeLessThan(palette.length / 3);
    const png = await encodeIndexedPng(width, height, indices, palette);
    expect([...png.subarray(24, 29)]).toEqual([8, 3, 0, 0, 0]);
    const decoded = await decodePng(png);
    const first = indices[0]! * 3;
    expect([...decoded.rgba.subarray(0, 4)]).toEqual([palette[first], palette[first + 1], palette[first + 2], 255]);
    // An image with few colours keeps them exactly.
    const two = { width: 2, height: 1, rgba: Uint8Array.from([10, 20, 30, 255, 200, 100, 50, 255]) };
    const exact = quantizeRgb(two, 256);
    expect([...exact.palette].sort((a, b) => a - b)).toEqual([10, 20, 30, 50, 100, 200]);
  });
});
