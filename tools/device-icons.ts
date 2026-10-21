import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { rasterizeIconSvg } from "./icon-raster.ts";

// Committed host PNGs are generated inputs for the legacy and devkitPro
// build systems. Keep both 3DS optical sizes independent all the way to SMDH.
const root = resolve(import.meta.dir, "..");
const check = process.argv.includes("--check");
for (const [source, target, size] of [
  ["hosts/iphone4s/Icon.svg", "hosts/iphone2g/Icon.png", 57],
  ["programs/3ds/product/icon.svg", "programs/3ds/product/icon.png", 48],
  ["programs/3ds/product/icon-small.svg", "programs/3ds/product/icon-small.png", 24],
] as const) {
  const svg = readFileSync(resolve(root, source), "utf8");
  const canvas = await rasterizeIconSvg(svg, size, size, !target.includes("iphone2g"));
  const png = canvas.toBuffer("image/png");
  const path = resolve(root, target);
  if (check) {
    if (!png.equals(readFileSync(path))) throw new Error(`${target} is stale; run bun tools/device-icons.ts`);
  } else writeFileSync(path, png);
  console.log(`${check ? "verified" : "wrote"} ${target} (${size}×${size})`);
}
