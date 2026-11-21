// Regenerate profile artwork: bun tools/generate-brand.ts [--check]
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const args = Bun.argv.slice(2);
if (args.some((arg) => arg !== "--check")) throw new Error("Unknown option");
const check = args.includes("--check");
const source = readFileSync(new URL("site/assets/favicon.svg", root), "utf8");
const mark = source.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/)?.[1];
if (!mark) throw new Error("Missing favicon SVG drawing");
const size = 1024;
const jobs = [
  { name: "white", background: "#ffffff", inset: 152, format: "jpg" },
  { name: "dark", background: "#171226", inset: 152, format: "jpg" },
  // Preserve existing filenames and framing for package consumers.
  { name: "white-minimal", background: "#ffffff", inset: 152, format: "png" },
  { name: "white-plate", background: "#ffffff", inset: 212, format: "png" },
  { name: "white-polished", background: "#ffffff", inset: 178, format: "png" },
] as const;

function output(name: string, data: string | Buffer) {
  const path = new URL(`assets/brand/${name}`, root);
  if (check) {
    if (!readFileSync(path).equals(Buffer.from(data))) throw new Error(`Stale asset: ${name}`);
  } else {
    writeFileSync(path, data);
  }
  console.log(`${check ? "Verified" : "Generated"} ${name}`);
}

for (const job of jobs) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="PocketJS avatar">
  <rect width="${size}" height="${size}" fill="${job.background}"/>
  <g transform="translate(${job.inset} ${job.inset}) scale(${(size - job.inset * 2) / 32})">${mark}  </g>
</svg>
`;
  const name = `pocketjs-avatar-${job.name}`;
  output(`${name}.svg`, svg);
  const canvas = createCanvas(size, size);
  canvas.getContext("2d").drawImage(await loadImage(Buffer.from(svg)), 0, 0);
  output(`${name}.${job.format}`, job.format === "jpg"
    ? canvas.toBuffer("image/jpeg", 95)
    : canvas.toBuffer("image/png"));
}
