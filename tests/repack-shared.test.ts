import { describe, expect, test } from "bun:test";
import { crc32 } from "../tools/repack/shared/crc32.ts";
import { decodePng, deflateZlib, encodePng } from "../tools/repack/shared/png.ts";
import { flattenRgba, scaleRgba } from "../tools/repack/shared/scale.ts";
import { readRuntime, sha256Hex } from "../tools/repack/shared/runtime.ts";

function chunk(name: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** A PNG from already-filtered scanline bytes (each row led by its filter byte). */
async function png(
  header: { width: number; height: number; depth: number; type: number; interlace?: number },
  scanlines: number[],
  extra: Array<[string, number[]]> = [],
): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, header.width);
  view.setUint32(4, header.height);
  ihdr[8] = header.depth;
  ihdr[9] = header.type;
  ihdr[12] = header.interlace ?? 0;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extra.map(([name, body]) => chunk(name, new Uint8Array(body))),
    chunk("IDAT", await deflateZlib(new Uint8Array(scanlines))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("repack shared helpers", () => {
  test("CRC-32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("PNG round-trips RGBA and RGB with every row filter decoded", async () => {
    const rgba = new Uint8Array(5 * 3 * 4).map((_, index) => (index * 37) & 255);
    const decoded = await decodePng(await encodePng({ width: 5, height: 3, rgba }));
    expect(decoded).toEqual({ width: 5, height: 3, rgba });
    const opaque = await decodePng(await encodePng({ width: 5, height: 3, rgba }, { opaque: true }));
    expect(opaque.rgba.filter((_, index) => index % 4 === 3).every((alpha) => alpha === 255)).toBe(true);

    // Sub, Up, Average and Paeth rows over one RGB pixel pair.
    const filtered = await png({ width: 2, height: 4, depth: 8, type: 2 }, [
      1, 10, 20, 30, 5, 5, 5,
      2, 1, 1, 1, 1, 1, 1,
      3, 2, 2, 2, 2, 2, 2,
      4, 0, 0, 0, 0, 0, 0,
    ]);
    const image = await decodePng(filtered);
    expect(Array.from(image.rgba.subarray(0, 8))).toEqual([10, 20, 30, 255, 15, 25, 35, 255]);
    expect(Array.from(image.rgba.subarray(8, 16))).toEqual([11, 21, 31, 255, 16, 26, 36, 255]);
    // Average: left 0 + up 11 -> 5 (+2 = 7) for the first pixel.
    expect(image.rgba[16]).toBe(7);
    // Paeth with zero deltas repeats the row above.
    expect(Array.from(image.rgba.subarray(24, 32))).toEqual(Array.from(image.rgba.subarray(16, 24)));
  });

  test("PNG reads palettes with tRNS, low bit depths, 16-bit samples and Adam7", async () => {
    const palette = await png({ width: 4, height: 1, depth: 2, type: 3 }, [0, 0b00011011], [
      ["PLTE", [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]],
      ["tRNS", [255, 128]],
    ]);
    expect(Array.from((await decodePng(palette)).rgba)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 255,
    ]);
    const gray = await png({ width: 3, height: 1, depth: 1, type: 0 }, [0, 0b10100000]);
    expect(Array.from((await decodePng(gray)).rgba.filter((_, index) => index % 4 === 0))).toEqual([255, 0, 255]);
    const deep = await png({ width: 1, height: 1, depth: 16, type: 6 }, [0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xff, 0xff]);
    expect(Array.from((await decodePng(deep)).rgba)).toEqual([0x12, 0x56, 0x9a, 0xff]);

    // A 3x3 gray image in Adam7 order, pixel value 10 * (y * 3 + x): passes 2
    // and 3 start past the image and are empty.
    const interlaced = await png({ width: 3, height: 3, depth: 8, type: 0, interlace: 1 }, [
      0, 0, // pass 1: (0,0)
      // pass 2: x0 4 -> empty; pass 3: y0 4 -> empty
      0, 20, // pass 4: (2,0)
      0, 60, 80, // pass 5: (0,2), (2,2)
      0, 10, 0, 70, // pass 6: (1,0), (1,2)
      0, 30, 40, 50, // pass 7: row y=1
    ]);
    const pixels = (await decodePng(interlaced)).rgba.filter((_, index) => index % 4 === 0);
    expect(Array.from(pixels)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80]);
  });

  test("PNG refuses what is not a readable image", async () => {
    await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toThrow(/signature/);
    const good = await encodePng({ width: 1, height: 1, rgba: new Uint8Array(4) });
    const corrupt = good.slice();
    corrupt[20] ^= 1;
    await expect(decodePng(corrupt)).rejects.toThrow(/CRC mismatch/);
    await expect(decodePng(await png({ width: 1, height: 1, depth: 3, type: 0 }, [0, 0]))).rejects.toThrow(/not a PNG format/);
  });

  test("area scaling averages in premultiplied alpha and flattening composites", () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 0, 255, 0,
      255, 0, 0, 255, 0, 0, 255, 0,
    ]);
    const half = scaleRgba({ width: 2, height: 2, rgba }, 1, 1);
    // The transparent blue pixels lend no colour: the result is red at half alpha.
    expect(Array.from(half.rgba)).toEqual([255, 0, 0, 128]);
    const double = scaleRgba({ width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255]) }, 3, 3);
    expect(double.rgba.every((value, index) => value === [1, 2, 3, 255][index % 4])).toBe(true);
    expect(Array.from(flattenRgba(half, [0, 0, 255]).rgba)).toEqual([128, 0, 127, 255]);
  });

  test("a runtime directory must match its runtime.json", async () => {
    const program = new Uint8Array([1, 2, 3]);
    const manifest = (files: object) => new TextEncoder().encode(JSON.stringify({ target: "3ds-dev", hostAbi: 11, pocketjs: "x", profile: "3ds-dev", files }));
    const good = new Map([["runtime.json", manifest({ "a.bin": { bytes: 3, sha256: await sha256Hex(program) } })], ["a.bin", program]]);
    expect((await readRuntime(good, "3ds-dev")).hostAbi).toBe(11);
    await expect(readRuntime(new Map(), "3ds-dev")).rejects.toThrow(/no runtime.json/);
    await expect(readRuntime(good, "psp")).rejects.toThrow(/for "3ds-dev", not "psp"/);
    const missing = new Map([["runtime.json", manifest({ "a.bin": { bytes: 3, sha256: "00" } })]]);
    await expect(readRuntime(missing, "3ds-dev")).rejects.toThrow(/missing a.bin/);
  });
});
