import { rasterizeIconSvg as raster } from "../icon-raster.ts";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { artwork, variants } from "./artwork.ts";

export const output = resolve(import.meta.dir, "../../dist/icon-study");
mkdirSync(resolve(output, "assets"), { recursive: true });
const assets = resolve(output, "assets");
const receipt: Record<string, unknown>[] = [];

for (const v of variants) for (const [platform, sizes] of [["ios", [57, 114, 512]], ["3ds", [24, 48]]] as const) {
  for (const size of sizes) {
    const svg = artwork(v, platform, size);
    const name = `${v.id}-${platform}-${size}`;
    writeFileSync(resolve(assets, `${name}.svg`), svg);
    const canvas = await raster(svg, size, size, platform !== "ios");
    const png = canvas.toBuffer("image/png");
    writeFileSync(resolve(assets, `${name}.png`), png);
    receipt.push({ file: `${name}.png`, width: size, height: size, sha256: new Bun.CryptoHasher("sha256").update(png).digest("hex") });
  }
}
for (const name of ["current-ios-v4.png", "current-3ds.png"]) cpSync(resolve(import.meta.dir, "assets", name), resolve(assets, name));

// Package with the installed devkitPro tool, then decode its actual tiled
// RGB565 payload. The web gallery displays these readbacks, not an RGB mock.
const withSmdh = process.argv.includes("--smdh");
if (withSmdh) {
  const jobs = variants.map(v => [v.id, `${v.id}-3ds-48.png`, `${v.id}-3ds-24.png`]);
  jobs.push(["current", "current-3ds.png", ""]);
  for (const [id, large, small] of jobs) {
    const args = ["docker", "run", "--rm", "--network=none", "-v", `${assets}:/art`, "devkitpro/devkitarm:latest", "/opt/devkitpro/tools/bin/smdhtool", "--create", "PocketJS", "Icon design study", "PocketJS", `/art/${large}`, `/art/${id}.smdh`];
    if (small) args.push(`/art/${small}`);
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    const bytes = readFileSync(resolve(assets, `${id}.smdh`));
    if (bytes.length !== 0x36c0 || bytes.toString("ascii", 0, 4) !== "SMDH") throw new Error("Invalid SMDH");
    for (const size of [24, 48]) {
      const offset = size === 24 ? 0x2040 : 0x24c0;
      const canvas = createCanvas(size, size);
      const ctx = canvas.getContext("2d");
      const out = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const xx = x & 7, yy = y & 7;
        const morton = (xx & 1) | ((yy & 1) << 1) | ((xx & 2) << 1) | ((yy & 2) << 2) | ((xx & 4) << 2) | ((yy & 4) << 3);
        const tile = (Math.floor(y / 8) * (size / 8) + Math.floor(x / 8)) * 64;
        const pixel = bytes.readUInt16LE(offset + (tile + morton) * 2);
        const r = pixel >> 11, g = (pixel >> 5) & 63, b = pixel & 31;
        out.data.set([(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2), 255], (y * size + x) * 4);
      }
      ctx.putImageData(out, 0, 0);
      writeFileSync(resolve(assets, `${id}-smdh-${size}.png`), canvas.toBuffer("image/png"));
      // A transposed tile or incorrect offset cannot pass this comparison.
      if (id !== "current") {
        const src = await loadImage(resolve(assets, `${id}-3ds-${size}.png`));
        const reference = createCanvas(size, size);
        reference.getContext("2d").drawImage(src, 0, 0);
        const original = reference.getContext("2d").getImageData(0, 0, size, size).data;
        for (let i = 0; i < original.length; i += 4) {
          if (Math.abs(original[i] - out.data[i]) > 7 || Math.abs(original[i + 1] - out.data[i + 1]) > 3 || Math.abs(original[i + 2] - out.data[i + 2]) > 7) throw new Error(`${id} SMDH pixel mismatch at ${i / 4}`);
        }
      }
    }
    receipt.push({ file: `${id}.smdh`, bytes: bytes.length, rgb565Readback: "passed", sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
  }
}
writeFileSync(resolve(output, "manifest.json"), JSON.stringify({ variants, smdh: withSmdh, receipt }, null, 2));
cpSync(resolve(import.meta.dir, "index.html"), resolve(output, "index.html"));

// Native-size and enlarged baked-pixel contact sheet for offline inspection.
const sheet = createCanvas(1280, 660);
const ctx = sheet.getContext("2d");
ctx.fillStyle = "#f4f0e7"; ctx.fillRect(0, 0, 1280, 660);
ctx.fillStyle = "#241f2d"; ctx.font = "24px sans-serif"; ctx.fillText("POCKET / CLASSIC ICON STUDY", 32, 44);
for (const [i, v] of variants.entries()) {
  const x = 32 + i * 312;
  ctx.fillStyle = "#241f2d"; ctx.font = "20px sans-serif"; ctx.fillText(`${v.letter} / ${v.english}`, x, 90);
  const ios = await loadImage(resolve(assets, `${v.id}-ios-114.png`));
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, 114, 228, 228, 44); ctx.clip(); ctx.drawImage(ios, x, 114, 228, 228); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, 378, 57, 57, 11); ctx.clip(); ctx.drawImage(ios, x, 378, 57, 57); ctx.restore();
  for (const [j, size] of [48, 24].entries()) {
    const icon = await loadImage(resolve(assets, `${v.id}-${withSmdh ? "smdh" : "3ds"}-${size}.png`));
    ctx.drawImage(icon, x + 90 + j * 76, 384, size, size);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(icon, x + j * 140, 486, size * (j ? 4 : 2), size * (j ? 4 : 2)); ctx.imageSmoothingEnabled = true;
  }
  ctx.font = "13px sans-serif"; ctx.fillText("iOS 57pt      HBL 48px      24px", x, 466);
  ctx.fillText("Baked pixels / nearest-neighbour zoom", x, 618);
}
writeFileSync(resolve(output, "contact-sheet.png"), sheet.toBuffer("image/png"));
console.log(`Baked ${receipt.length} artifacts → ${output}`);
