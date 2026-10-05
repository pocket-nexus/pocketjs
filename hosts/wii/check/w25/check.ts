import { readFileSync } from "node:fs";
import { decodePng } from "../../../../framework/compiler/pak.ts";

const [path, ...options] = process.argv.slice(2);
const cropOption = options.find((option) => option.startsWith("--crop="));
const crossPressed = options.includes("--cross");
if (!path || options.some((option) => option !== "--cross" && option !== cropOption)) {
  throw new Error(
    "usage: bun hosts/wii/check/w25/check.ts capture.png [--crop=x,y,w,h] [--cross]",
  );
}

const image = decodePng(new Uint8Array(readFileSync(path)));
const guestX = 80;
const guestY = 80;
const efbWidth = 640;
const efbHeight = 480;
const crop = cropOption
  ? cropOption.slice("--crop=".length).split(",").map(Number)
  : [0, 0, image.width, image.height];
if (
  crop.length !== 4 ||
  crop.some((value) => !Number.isInteger(value)) ||
  crop[0]! < 0 || crop[1]! < 0 || crop[2]! <= 0 || crop[3]! <= 0 ||
  crop[0]! + crop[2]! > image.width || crop[1]! + crop[3]! > image.height
) {
  throw new Error("--crop must be an in-bounds x,y,width,height rectangle in the PNG");
}
if (!cropOption && (image.width !== efbWidth || image.height !== efbHeight)) {
  throw new Error(
    `capture is ${image.width}x${image.height}; pass --crop=x,y,w,h for the full EFB render region`,
  );
}
const samples: [string, number, number, number, number, number][] = [
  ["outer rect", 32, 116, 0x20, 0x40, 0x60],
  ["nested clip", 52, 140, 0x20, 0x40, 0x60],
  ["red child", 64, 134, 0xe0, 0x30, 0x20],
  ["inner fill", 110, 164, 0x40, 0x60, 0x20],
  ["clip pop", 140, 145, 0xf0, 0xb0, 0x20],
  ["outer clip", 156, 145, 0x20, 0x28, 0x30],
  ["image origin", 198, 64, 0x00, 0x00, 0x80],
  ["alpha image", 238, 64, 0x40, 0x00, 0x60],
  ["glyph", 25, 22, 0xff, 0xff, 0xff],
  ["input", 376, 84, ...(crossPressed ? [0x20, 0xc0, 0x60] : [0xc0, 0x20, 0x20])],
];

function pixel(x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return Array.from(image.rgba.subarray(i, i + 3));
}

for (const [name, x, y, r, g, b] of samples) {
  const efbX = x + guestX;
  const efbY = y + guestY;
  const sx = crop[0]! + Math.floor((efbX + 0.5) * crop[2]! / efbWidth);
  const sy = crop[1]! + Math.floor((efbY + 0.5) * crop[3]! / efbHeight);
  if (sx >= image.width || sy >= image.height) {
    throw new Error(`capture is too small for ${name}: ${image.width}x${image.height}`);
  }
  const actual = pixel(sx, sy);
  const tolerance = name === "alpha image" ? 4 : name === "glyph" ? 8 : 0;
  if ([r, g, b].some((expected, channel) => Math.abs(actual[channel]! - expected) > tolerance)) {
    throw new Error(
      `${name} at screenshot (${sx},${sy}): got #${actual.map((v) => v.toString(16).padStart(2, "0")).join("")}, ` +
      `expected #${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")} ±${tolerance}`,
    );
  }
  console.log(`PASS ${name}: (${sx},${sy}) #${actual.map((v) => v.toString(16).padStart(2, "0")).join("")}`);
}
