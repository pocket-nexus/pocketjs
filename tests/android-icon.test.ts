import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  ANDROID_DEFAULT_ICON,
  ANDROID_ICON_MIN_SOURCE,
  ANDROID_LAUNCHER_DENSITIES,
  bakeAndroidLauncherIcons,
  downsampleSquare,
} from "../tools/android-icon.ts";

const work = join(tmpdir(), `pocketjs-android-icon-${process.pid}`);
mkdirSync(work, { recursive: true });
afterAll(() => rmSync(work, { recursive: true, force: true }));

function square(side: number, paint: (x: number, y: number) => [number, number, number, number]): string {
  const canvas = createCanvas(side, side);
  const context = canvas.getContext("2d");
  const image = context.createImageData(side, side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) image.data.set(paint(x, y), (y * side + x) * 4);
  context.putImageData(image, 0, 0);
  const path = join(work, `source-${side}-${Math.random().toString(36).slice(2)}.png`);
  writeFileSync(path, canvas.toBuffer("image/png"));
  return path;
}

async function pixels(path: string): Promise<{ side: number; data: Uint8ClampedArray }> {
  const image = await loadImage(readFileSync(path));
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return { side: image.width, data: canvas.getContext("2d").getImageData(0, 0, image.width, image.height).data };
}

test("the launcher icon is one file a density, 48 to 192 pixels", async () => {
  expect(ANDROID_LAUNCHER_DENSITIES.map(([density, size]) => `${density}:${size}`)).toEqual([
    "mdpi:48", "hdpi:72", "xhdpi:96", "xxhdpi:144", "xxxhdpi:192",
  ]);
  const resources = join(work, "default");
  const icons = await bakeAndroidLauncherIcons(ANDROID_DEFAULT_ICON, resources);
  for (const [density, size] of ANDROID_LAUNCHER_DENSITIES) {
    const file = await pixels(join(resources, `mipmap-${density}`, "icon.png"));
    expect(file.side).toBe(size);
    // PocketJS's mark stands on its plum ground, opaque to the corners.
    expect([...file.data.slice(0, 4)]).toEqual([0x17, 0x12, 0x26, 255]);
  }
  expect(icons.files.map((file) => file.size)).toEqual([48, 72, 96, 144, 192]);
  // The same source gives the same bytes: a package is the same on every build.
  const again = await bakeAndroidLauncherIcons(ANDROID_DEFAULT_ICON, join(work, "default-again"));
  expect(again).toMatchObject({ sourceSha256: icons.sourceSha256 });
  expect(again.files.map((file) => file.sha256)).toEqual(icons.files.map((file) => file.sha256));
});

test("a bitmap source is averaged down once and keeps a hard edge within one pixel", async () => {
  // Left half black, right half white, 768 pixels: every density divides it without a remainder at the edge.
  const source = square(768, (x) => (x < 384 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const resources = join(work, "edge");
  await bakeAndroidLauncherIcons(source, resources);
  for (const [density, size] of ANDROID_LAUNCHER_DENSITIES) {
    const file = await pixels(join(resources, `mipmap-${density}`, "icon.png"));
    const row = (size >> 1) * size * 4;
    expect(file.data[row + (size / 2 - 1) * 4]).toBe(0);
    expect(file.data[row + (size / 2) * 4]).toBe(255);
  }
});

test("colour is averaged premultiplied: a transparent pixel adds none to an edge", () => {
  // Two source pixels to one: opaque red beside transparent green.
  const out = downsampleSquare(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0]), 2, 1);
  expect([...out]).toEqual([255, 0, 0, 128]);
});

test("a source is never scaled up, and is square", async () => {
  expect(ANDROID_ICON_MIN_SOURCE).toBe(192);
  const small = square(64, () => [255, 210, 63, 255]);
  await expect(bakeAndroidLauncherIcons(small, join(work, "small"))).rejects.toThrow(/never scaled up: .* is 64 pixels a side/);
  const canvas = createCanvas(512, 256);
  const wide = join(work, "wide.png");
  writeFileSync(wide, canvas.toBuffer("image/png"));
  await expect(bakeAndroidLauncherIcons(wide, join(work, "wide"))).rejects.toThrow(/is square: .* is 512 by 256/);
  expect(() => downsampleSquare(new Uint8Array(4), 1, 2)).toThrow(/never scaled up/);
});

test("the Android manifest names the density-qualified launcher icon", () => {
  const manifest = readFileSync("hosts/android/app/AndroidManifest.xml", "utf8");
  expect(manifest).toContain('android:icon="@mipmap/icon"');
  expect(manifest).not.toContain("@drawable/icon");
});
