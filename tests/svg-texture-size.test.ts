import { describe, expect, test } from "bun:test";
import { bakeSvg } from "../framework/compiler/bake-svg.ts";
import { encodeImageEntry } from "../framework/compiler/pak.ts";

const coverageSvg = `<svg width="32" height="16" viewBox="0 0 32 16"><rect width="32" height="16" fill="#125689"/><circle cx="10.25" cy="8.125" r="6.25" fill="#fe9022"/><path d="M19 2 L30 3 Q23 9 30 14 L18 13 Z" fill="#89baef"/><circle cx="10" cy="8" r="2.5" fill="hole"/></svg>`;

describe("SVG texture storage dimensions", () => {

  test("3x rerasterizes the whole viewBox into encodable power-of-two storage", () => {
    const three = bakeSvg(coverageSvg, 3);
    const four = bakeSvg(coverageSvg, 4);
    expect([three.width, three.height]).toEqual([128, 64]);
    expect(three.rgba).toEqual(four.rgba);
    const entry = encodeImageEntry(three);
    const header = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    expect([header.getUint16(0, true), header.getUint16(2, true)]).toEqual([128, 64]);
    expect(entry.subarray(8)).toEqual(three.rgba);
  });

  test("different axis rounding preserves full content and a circle in logical coordinates", () => {
    // Logical aspect is 8:5; 3x requests 192x120, stored as 256x128 (2:1).
    // Full UV mapping reverses the separate storage scales on each axis.
    const image = bakeSvg(`<svg width="64" height="40" viewBox="10 20 64 40">
      <rect x="10" y="20" width="64" height="40" fill="#123456"/>
      <circle cx="42" cy="40" r="8" fill="#00ff00"/>
      <path d="M70 56 H74 V60 H70 Z" fill="#ff0000"/>
    </svg>`, 3);
    expect([image.width, image.height]).toEqual([256, 128]);
    const logicalPixel = (x: number, y: number) => {
      const px = Math.floor(x * image.width / 64);
      const py = Math.floor(y * image.height / 40);
      return Array.from(image.rgba.subarray((py * image.width + px) * 4, (py * image.width + px) * 4 + 4));
    };
    expect(logicalPixel(0, 0)).toEqual([0x12, 0x34, 0x56, 255]);
    expect(logicalPixel(63.9, 0)).toEqual([0x12, 0x34, 0x56, 255]);
    expect(logicalPixel(0, 39.9)).toEqual([0x12, 0x34, 0x56, 255]);
    expect(logicalPixel(63.9, 39.9)).toEqual([255, 0, 0, 255]);
    for (const [x, y] of [[39.5, 20], [32, 27.5], [24.5, 20], [32, 12.5]]) {
      expect(logicalPixel(x, y)).toEqual([0, 255, 0, 255]);
    }
    for (const [x, y] of [[40.5, 20], [32, 28.5], [23.5, 20], [32, 11.5]]) {
      expect(logicalPixel(x, y)).toEqual([0x12, 0x34, 0x56, 255]);
    }
    expect(() => encodeImageEntry(image)).not.toThrow();
  });

  test("keeps the 512-pixel limit and rejects requests that require downsampling", () => {
    const svg = `<svg width="128" height="64"><rect width="128" height="64" fill="#fff"/></svg>`;
    const image = bakeSvg(svg, 4);
    expect([image.width, image.height]).toEqual([512, 256]);
    expect(() => encodeImageEntry(image)).not.toThrow();
    expect(() => bakeSvg(svg, 5)).toThrow("requested raster 640x320 exceeds texture limit 512");
    expect(() => bakeSvg(`<svg width="1" height="513"><rect width="1" height="513" fill="#fff"/></svg>`))
      .toThrow("requested raster 1x513 exceeds texture limit 512");
  });
});
