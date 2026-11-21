import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
export const IPODTOUCH_ICON_SOURCE = resolve(REPOSITORY, "programs/ipodtouch6/Icon.svg");

export const IPODTOUCH_ICON_OUTPUTS = {
  "Icon.png": 57,
  "Icon@2x.png": 114,
  "Icon-60@2x.png": 120,
  "Icon-60@3x.png": 180,
} as const;

const ICON_SUPERSAMPLE = 8;

function svgForRasterSize(size: number): Buffer {
  const source = readFileSync(IPODTOUCH_ICON_SOURCE, "utf8");
  const sized = source.replace(
    'width="1024" height="1024"',
    `width="${size}" height="${size}"`,
  );
  if (sized === source) {
    throw new Error("pocket ipodtouch: SVG canvas declaration changed");
  }
  return Buffer.from(sized);
}

function exactAreaDownsample(source: Canvas, targetSize: number): Canvas {
  const sourceContext = source.getContext("2d");
  const sourcePixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
  const output = createCanvas(targetSize, targetSize);
  const outputContext = output.getContext("2d");
  const outputPixels = outputContext.createImageData(targetSize, targetSize);
  const outputData = outputPixels.data;
  const samplesPerPixel = ICON_SUPERSAMPLE * ICON_SUPERSAMPLE;

  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sampleY = 0; sampleY < ICON_SUPERSAMPLE; sampleY += 1) {
        const sourceY = y * ICON_SUPERSAMPLE + sampleY;
        for (let sampleX = 0; sampleX < ICON_SUPERSAMPLE; sampleX += 1) {
          const sourceX = x * ICON_SUPERSAMPLE + sampleX;
          const sourceIndex = (sourceY * source.width + sourceX) * 4;
          totals[0] += sourcePixels[sourceIndex];
          totals[1] += sourcePixels[sourceIndex + 1];
          totals[2] += sourcePixels[sourceIndex + 2];
          totals[3] += sourcePixels[sourceIndex + 3];
        }
      }
      const outputIndex = (y * targetSize + x) * 4;
      outputData[outputIndex] = Math.round(totals[0] / samplesPerPixel);
      outputData[outputIndex + 1] = Math.round(totals[1] / samplesPerPixel);
      outputData[outputIndex + 2] = Math.round(totals[2] / samplesPerPixel);
      outputData[outputIndex + 3] = Math.round(totals[3] / samplesPerPixel);
    }
  }

  outputContext.putImageData(outputPixels, 0, 0);
  return output;
}

function assertOpaque(canvas: Canvas): void {
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 255) {
      throw new Error("pocket ipodtouch: baked iOS artwork must be fully opaque");
    }
  }
}

async function rasterizeIcon(size: number): Promise<Canvas> {
  const rasterSize = size * ICON_SUPERSAMPLE;
  const image = await loadImage(svgForRasterSize(rasterSize));
  if (image.width !== rasterSize || image.height !== rasterSize) {
    throw new Error(
      `pocket ipodtouch: SVG rasterized at ${image.width}x${image.height}, expected ${rasterSize}x${rasterSize}`,
    );
  }
  const source = createCanvas(rasterSize, rasterSize);
  source.getContext("2d").drawImage(image, 0, 0);
  const output = exactAreaDownsample(source, size);
  assertOpaque(output);
  return output;
}

export async function bakeIPodTouchArtwork(outputDirectory: string): Promise<string[]> {
  mkdirSync(outputDirectory, { recursive: true });
  const written: string[] = [];

  for (const [name, size] of Object.entries(IPODTOUCH_ICON_OUTPUTS)) {
    const target = resolve(outputDirectory, name);
    const icon = await rasterizeIcon(size);
    writeFileSync(target, icon.toBuffer("image/png"));
    written.push(target);
  }

  const launchIcon = await rasterizeIcon(224);
  for (const [name, height] of [["Default@2x.png", 960], ["Default-568h@2x.png", 1136]] as const) {
    const width = 640;
    const target = resolve(outputDirectory, name);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#020617";
    context.fillRect(0, 0, width, height);
    context.drawImage(launchIcon, (width - launchIcon.width) / 2, (height - launchIcon.height) / 2);
    assertOpaque(canvas);
    writeFileSync(target, canvas.toBuffer("image/png"));
    written.push(target);
  }

  return written;
}

async function main(): Promise<void> {
  const outputFlag = Bun.argv.find((arg) => arg.startsWith("--outdir="));
  const outputDirectory = resolve(outputFlag?.slice("--outdir=".length) ?? "dist/ipodtouch/artwork");
  const written = await bakeIPodTouchArtwork(outputDirectory);
  for (const path of written) console.log(`baked ${basename(path)}`);
}

if (import.meta.main) {
  await main();
}
