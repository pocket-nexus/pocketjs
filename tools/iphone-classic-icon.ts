import { rasterizeIconSvg } from "./icon-raster.ts";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));

/** Precomposed classic iOS icons carry their own transparent corner mask. */
export const IPHONE_CLASSIC_ICON_SOURCE = resolve(REPOSITORY, "hosts/iphone2g/Icon.png");
export const IPHONE_CLASSIC_RETINA_SOURCE = resolve(REPOSITORY, "hosts/iphone4s/Icon.svg");
export const IPHONE_CLASSIC_ICON_FILE = "PocketClassic-v6.png";
export const IPHONE_CLASSIC_RETINA_ICON_FILE = "PocketClassic-v6@2x.png";
export const IPHONE_USER_ICON_FILE = "PocketClassic-User-v7.png";
export const IPHONE_USER_RETINA_ICON_FILE = "PocketClassic-User-v7@2x.png";

async function rasterizeRetinaArtwork(width: number, height: number, userApp = false): Promise<Canvas> {
  let svg = readFileSync(IPHONE_CLASSIC_RETINA_SOURCE, "utf8");
  if (userApp) {
    // MobileInstallation User icons receive the native mask and shadow. A
    // pre-masked inset face would expose a second dark rim underneath it.
    const face = 'id="user-app-face" display="none"';
    const frame = 'id="system-app-frame"';
    if (!svg.includes(face) || !svg.includes(frame)) throw new Error("Missing classic icon installation layers");
    svg = svg.replace(face, 'id="user-app-face"').replace(frame, `${frame} display="none"`);
  }
  return rasterizeIconSvg(svg, width, height, userApp);
}

function assertOpaque(canvas: Canvas): void {
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] !== 255) {
      throw new Error("pocket iphone artwork: launch image must be opaque");
    }
  }
}

/**
 * Write the classic icons and launch images into a bundle. `launch`, an
 * opaque 640x960 PNG (the app's first frame), replaces the generated launch
 * image; the 4-inch one repeats its bottom row below it.
 */
export async function bakeClassicIPhoneArtwork(
  outputDirectory: string,
  applicationType: "System" | "User" = "System",
  launch?: string,
): Promise<string[]> {
  mkdirSync(outputDirectory, { recursive: true });
  const userApp = applicationType === "User";
  const icon = resolve(outputDirectory, userApp ? IPHONE_USER_ICON_FILE : IPHONE_CLASSIC_ICON_FILE);
  const retinaIcon = resolve(outputDirectory, userApp ? IPHONE_USER_RETINA_ICON_FILE : IPHONE_CLASSIC_RETINA_ICON_FILE);
  writeFileSync(icon, (await rasterizeRetinaArtwork(57, 57, userApp)).toBuffer("image/png"));
  writeFileSync(retinaIcon, (await rasterizeRetinaArtwork(114, 114, userApp)).toBuffer("image/png"));

  const launchIcon = await rasterizeRetinaArtwork(228, 228);
  const launchFrame = launch ? await loadImage(readFileSync(launch)) : undefined;
  if (launchFrame && (launchFrame.width !== 640 || launchFrame.height !== 960)) {
    throw new Error(`pocket iphone artwork: launch image must be 640x960, got ${launchFrame.width}x${launchFrame.height}`);
  }
  const written = [icon, retinaIcon];
  for (const [name, height] of [["Default@2x.png", 960], ["Default-568h@2x.png", 1136]] as const) {
    const target = resolve(outputDirectory, name);
    const canvas = createCanvas(640, height);
    const context = canvas.getContext("2d");
    if (launchFrame) {
      context.drawImage(launchFrame, 0, 0);
      if (height > 960) context.drawImage(launchFrame, 0, 959, 640, 1, 0, 960, 640, height - 960);
      assertOpaque(canvas);
      writeFileSync(target, canvas.toBuffer("image/png"));
      written.push(target);
      continue;
    }
    context.fillStyle = "#020617";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const x = Math.floor((canvas.width - launchIcon.width) / 2);
    const y = Math.floor((canvas.height - launchIcon.height) / 2);
    context.save();
    context.beginPath();
    context.roundRect(x, y, launchIcon.width, launchIcon.height, 44);
    context.clip();
    context.drawImage(
      launchIcon,
      x,
      y,
    );
    context.restore();
    assertOpaque(canvas);
    writeFileSync(target, canvas.toBuffer("image/png"));
    written.push(target);
  }
  return written;
}
