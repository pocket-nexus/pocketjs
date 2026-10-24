// tests/camera-photo.test.ts — camera.photo (contracts/spec/camera.ts):
//
// - the hosts' shared photo code (engine/host-services/photos_image.c) and
//   the 3DS libjpeg codec, compiled natively by tests/fixtures/3ds-photos.c:
//   DCF names, a still encoded the way photos.c saves it and decoded back,
//   the thumbnail and the full view;
// - the C constants against the contract;
// - the sim's camera host (platforms/sim/camera.ts) through the framework's
//   camera module, the way an applet calls it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAMERA_OPEN,
  PHOTO_HEIGHT,
  PHOTO_KIND,
  PHOTO_MAX_QUEUE,
  PHOTO_NAME,
  PHOTO_PENDING,
  PHOTO_THUMB_SIZE,
  PHOTO_THUMB_TEXTURE,
  PHOTO_WIDTH,
} from "../contracts/spec/camera.ts";
import {
  capturePhoto,
  deletePhoto,
  freePhoto,
  listPhotos,
  loadPhoto,
  openCamera,
  photoEvents,
} from "../framework/src/camera.ts";
import { createSimCameraHost } from "../platforms/sim/camera.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "products/3ds/src");
const SHARED = join(ROOT, "engine/host-services");
let scratch = "";
let binary = "";

function run(...args: string[]): string {
  const result = Bun.spawnSync([binary, ...args]);
  if (result.exitCode !== 0) throw new Error(`harness ${args[0]} exited ${result.exitCode}: ${result.stderr}`);
  return result.stdout.toString().replace(/\n$/, "");
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pocket-3ds-photos-"));
  binary = join(scratch, "harness");
  // The console links devkitPro's libjpeg; the harness links the computer's
  // (brew install jpeg-turbo, apt install libjpeg-turbo8-dev).
  const pkg = Bun.spawnSync(["pkg-config", "--cflags", "--libs", "libjpeg"]);
  expect(pkg.exitCode, "libjpeg not found by pkg-config: brew install jpeg-turbo or apt install libjpeg-turbo8-dev").toBe(0);
  const compile = Bun.spawnSync([
    "cc", "-std=gnu11", "-O1", "-Wall", "-Wextra", "-fsanitize=address,undefined",
    join(ROOT, "tests/fixtures/3ds-photos.c"), join(SHARED, "photos_image.c"), join(SRC, "photos_jpeg.c"), "-I", SHARED,
    ...pkg.stdout.toString().trim().split(/\s+/), "-lm", "-o", binary,
  ]);
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("the 3DS host's photo code", () => {
  test("DCF names match PHOTO_NAME, and nothing else passes", () => {
    const names = ["100POCKT/PKT_0001.JPG", "100NIN03/HNI_0042.MPO", "999ABCDE/ZZZZ9999.JPG", "099POCKT/PKT_0001.JPG",
      "100POCKT/PKT_001.JPG", "100pockt/PKT_0001.JPG", "100POCKT/PKT_0001.PNG", "../etc/passwd", "100POCKT\\PKT_0001.JPG"];
    const lines = run("names", ...names).split("\n");
    for (const [index, name] of names.entries()) {
      expect(lines[index]).toBe(`${name} ${PHOTO_NAME.test(name) ? 1 : 0}`);
    }
    expect(lines.filter((line) => line.endsWith(" 1"))).toHaveLength(3);
  });

  test("a still survives the JPEG round trip; the thumbnail crops the middle, the full view fits the screen", () => {
    const facts = JSON.parse(run("roundtrip", String(PHOTO_WIDTH), String(PHOTO_HEIGHT)));
    expect(facts.written).toBe(1);
    expect(facts.soi).toBe(1);
    expect([facts.width, facts.height]).toEqual([PHOTO_WIDTH, PHOTO_HEIGHT]);
    expect(facts.meanError).toBeLessThan(3);
    // A thumbnail decodes at 1/4 scale and the full view at 1/2.
    expect(facts.thumbDecode).toEqual([PHOTO_WIDTH / 4, PHOTO_HEIGHT / 4]);
    expect(facts.screenDecode).toEqual([PHOTO_WIDTH / 2, PHOTO_HEIGHT / 2]);
    expect(facts.garbage).toBe(1);
    // The camera's red-high RGB565 arrives as red in the core's red-low PSM_5650.
    expect(facts.thumbCentre[0]).toBeGreaterThan(230);
    expect(facts.thumbCentre[1]).toBeGreaterThan(230);
    expect(facts.thumbLeft).toEqual([248, 0, 0]);
    expect(facts.thumbOutside).toEqual([0, 0, 0]);
    expect(facts.fullTopLeft).toEqual([248, 0, 0]);
    expect(facts.fullTopRight).toEqual([0, 0, 248]);
    expect(facts.fullBelow).toEqual([0, 0, 0]);
  });

  test("the C constants are the contract's", () => {
    const image = readFileSync(join(SHARED, "photos_image.h"), "utf8");
    expect(image).toContain(`#define PHOTO_THUMB_SIZE ${PHOTO_THUMB_SIZE}u`);
    expect(image).toContain(`#define PHOTO_THUMB_TEXTURE ${PHOTO_THUMB_TEXTURE}u`);
    const photos = readFileSync(join(SRC, "photos.c"), "utf8");
    expect(photos).toContain(`#define PHOTO_MAX_QUEUE ${PHOTO_MAX_QUEUE}`);
    expect(photos).toContain(`#define PHOTO_PENDING (${PHOTO_PENDING})`);
    expect(photos).toContain(`#define PHOTO_KIND_FULL ${PHOTO_KIND.full}`);
    const camera = readFileSync(join(SRC, "camera.c"), "utf8");
    expect(camera).toContain(`#define CAMERA_OPEN_INNER ${CAMERA_OPEN.inner}`);
    expect(camera).toContain(`#define CAMERA_OPEN_NO_SCAN ${CAMERA_OPEN.noScan}`);
    expect(camera).toContain(`#define PHOTO_WIDTH ${PHOTO_WIDTH}u`);
    expect(camera).toContain(`#define PHOTO_HEIGHT ${PHOTO_HEIGHT}u`);
  });
});

describe("camera.photo through the framework, on the sim's camera", () => {
  const saved = (globalThis as Record<string, unknown>).camera;
  const savedUi = (globalThis as Record<string, unknown>).ui;
  let textures = 0;
  const freed: number[] = [];

  beforeAll(() => {
    (globalThis as Record<string, unknown>).ui = {
      uploadTexture: () => ++textures,
      freeTexture: (handle: number) => freed.push(handle),
    };
  });
  afterAll(() => {
    (globalThis as Record<string, unknown>).camera = saved;
    (globalThis as Record<string, unknown>).ui = savedUi;
  });

  test("capture names the next own photo; the list is newest first; load answers through events", () => {
    const host = createSimCameraHost({ photos: ["100NIN03/HNI_0003.JPG", "100POCKT/PKT_0007.JPG"] });
    (globalThis as Record<string, unknown>).camera = host.ns;
    expect(capturePhoto()).toBe(-1); // nothing open
    const preview = openCamera({ scan: false });
    expect(preview).toBeGreaterThan(0);
    const job = capturePhoto();
    expect(job).toBeGreaterThan(0);
    expect(photoEvents()).toEqual([{ t: "saved", job, name: "100POCKT/PKT_0008.JPG", ms: 0 }]);
    expect(photoEvents()).toEqual([]);
    expect(listPhotos().map((entry) => entry.name)).toEqual(["100POCKT/PKT_0008.JPG", "100POCKT/PKT_0007.JPG", "100NIN03/HNI_0003.JPG"]);

    expect(loadPhoto("100POCKT/PKT_0008.JPG", PHOTO_KIND.thumb)).toBe(PHOTO_PENDING);
    expect(loadPhoto("100POCKT/PKT_9999.JPG", PHOTO_KIND.full)).toBe(-1);
    const [loaded] = photoEvents();
    expect(loaded).toMatchObject({ t: "loaded", name: "100POCKT/PKT_0008.JPG", kind: PHOTO_KIND.thumb });
    const handle = (loaded as { handle: number }).handle;
    freePhoto(handle);
    freePhoto(handle);
    expect(freed.filter((h) => h === handle)).toHaveLength(1);

    expect(deletePhoto("100POCKT/PKT_0007.JPG")).toBe(true);
    expect(deletePhoto("100POCKT/PKT_0007.JPG")).toBe(false);
    expect(host.photos()).toEqual(["100POCKT/PKT_0008.JPG", "100NIN03/HNI_0003.JPG"]);
  });

  test("opening with the inner camera switches the preview; open() alone keeps QR decoding", () => {
    const host = createSimCameraHost();
    (globalThis as Record<string, unknown>).camera = host.ns;
    openCamera();
    expect(host.inner()).toBe(false);
    openCamera({ inner: true, scan: false });
    expect(host.inner()).toBe(true);
    expect(host.log).toEqual(["open", `open ${CAMERA_OPEN.inner | CAMERA_OPEN.noScan}`]);
  });
});
