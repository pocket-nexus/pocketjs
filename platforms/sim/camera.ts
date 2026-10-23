// platforms/sim/camera.ts — a deterministic camera (`globalThis.camera`,
// contracts/spec/camera.ts). open() uploads one synthetic preview frame (a
// laptop screen showing a QR code from the outer camera, a face from the
// inner one, drawn from integer arithmetic) through the wasm core's
// uploadTexture; poll() returns the payloads a test shows it.
//
// camera.photo keeps photos in memory: capture() adds one named the way
// photos.c names them, and its "saved" event is ready on the next events()
// call; load() answers PHOTO_PENDING and a "loaded" event with a texture of
// a picture derived from the name.

import {
  CAMERA_HEIGHT,
  CAMERA_OPEN,
  CAMERA_TEXTURE_HEIGHT,
  CAMERA_TEXTURE_WIDTH,
  CAMERA_WIDTH,
  PHOTO_KIND,
  PHOTO_NAME,
  PHOTO_PENDING,
  PHOTO_THUMB_SIZE,
  PHOTO_THUMB_TEXTURE,
  type CameraInfo,
  type PhotoEntry,
  type PhotoEvent,
} from "../../contracts/spec/camera.ts";
import type { CameraOps, PhotoOps } from "../../framework/src/camera.ts";

const PSM_8888 = 3; // contracts/spec/spec.ts PSM.PSM_8888, literal: this module stays host-side

export interface SimCameraHost {
  readonly ns: CameraOps & PhotoOps;
  /** The stored photos, newest first. */
  readonly photos: () => readonly string[];
  /** Whether the inner camera is the open one. */
  readonly inner: () => boolean;
  /** The decoder reads `payload` on the next poll() while the camera is open. */
  show(payload: string): void;
  readonly log: string[];
  readonly open: () => boolean;
}

/** The preview frame: RGBA8 at texture size, the image in the top-left 320x240. */
export function simCameraFrame(): Uint8Array {
  const w = CAMERA_TEXTURE_WIDTH;
  const rgba = new Uint8Array(w * CAMERA_TEXTURE_HEIGHT * 4);
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const o = (y * w + x) * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  };
  // A dim room: warm desk below, cool wall above.
  for (let y = 0; y < CAMERA_HEIGHT; y++) {
    for (let x = 0; x < CAMERA_WIDTH; x++) {
      const desk = y > 196;
      const shade = ((x * 7 + y * 13) % 5) - 2; // sensor grain, fixed
      if (desk) put(x, y, 92 + shade, 70 + shade, 52 + shade);
      else put(x, y, 46 + (y >> 3) + shade, 52 + (y >> 3) + shade, 64 + (y >> 3) + shade);
    }
  }
  // The laptop: aluminium bezel and a white window holding the code.
  for (let y = 34; y < 200; y++) for (let x = 52; x < 268; x++) put(x, y, 186, 190, 196);
  for (let y = 40; y < 192; y++) for (let x = 58; x < 262; x++) put(x, y, 236, 239, 244);
  // A 25x25 module code at 4 px per module, finder squares in three corners.
  const modules = 25;
  const size = 4;
  const left = 160 - (modules * size) / 2;
  const top = 116 - (modules * size) / 2;
  const finder = (mx: number, my: number, ox: number, oy: number) => {
    const dx = mx - ox;
    const dy = my - oy;
    if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return null;
    const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
    return ring === 3 || ring <= 1;
  };
  for (let my = 0; my < modules; my++) {
    for (let mx = 0; mx < modules; mx++) {
      const fixed = finder(mx, my, 0, 0) ?? finder(mx, my, modules - 7, 0) ?? finder(mx, my, 0, modules - 7);
      const dark = fixed ?? ((mx * 31 + my * 17 + mx * my) % 7) < 3;
      if (!dark) continue;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(left + mx * size + x, top + my * size + y, 24, 26, 30);
    }
  }
  return rgba;
}

/** A face filling the frame: what the inner camera sees. */
function simInnerFrame(): Uint8Array {
  const w = CAMERA_TEXTURE_WIDTH;
  const rgba = new Uint8Array(w * CAMERA_TEXTURE_HEIGHT * 4);
  for (let y = 0; y < CAMERA_HEIGHT; y++) {
    for (let x = 0; x < CAMERA_WIDTH; x++) {
      const o = (y * w + x) * 4;
      const dx = x - 160, dy = y - 130;
      const face = dx * dx * 4 + dy * dy * 3 < 90 * 90 * 4;
      const eye = (Math.abs(x - 130) < 8 || Math.abs(x - 190) < 8) && Math.abs(y - 112) < 8;
      const [r, g, b] = eye ? [40, 30, 28] : face ? [226, 182, 150] : [92 + (y >> 2), 120, 150];
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/** The file number of a "100POCKT/PKT_0001.JPG" name. */
function photoNumber(name: string): number {
  return Number(name.slice(13, 17));
}

/** A photo's picture, from its name: a sky, a horizon and a sun whose place
 *  and colours follow the file number, fitted into `w` x `h` of a texture
 *  `tw` x `th`. */
function simPhotoPixels(name: string, w: number, h: number, tw: number, th: number): Uint8Array {
  const n = photoNumber(name) || 1;
  const rgba = new Uint8Array(tw * th * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * tw + x) * 4;
      const horizon = h * (0.55 + ((n * 7) % 20) / 100);
      const sx = w * (((n * 37) % 80) + 10) / 100, sy = h * 0.3;
      const sun = (x - sx) ** 2 + (y - sy) ** 2 < (h * 0.12) ** 2;
      const [r, g, b] = sun
        ? [255, 214, 120]
        : y > horizon
          ? [40 + ((n * 53) % 90), 110 + ((n * 29) % 80), 60]
          : [90 + ((n * 17) % 100), 150 + y * 60 / h, 230];
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = Math.min(255, b);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

export interface SimCameraOptions {
  /** Photos on the fake storage at boot, any order. */
  photos?: string[];
}

export function createSimCameraHost(options: SimCameraOptions = {}): SimCameraHost {
  let open = false;
  let handle = -1;
  let frames = 0;
  let scans = 0;
  let next: string | undefined;
  let flags = 0;
  const log: string[] = [];
  const stored = (options.photos ?? []).filter((name) => PHOTO_NAME.test(name));
  const sorted = () => [...stored].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  let pending: PhotoEvent[] = [];
  let job = 0;
  const live = new Set<number>();
  type SimUi = {
    uploadTexture?: (b: Uint8Array, w: number, h: number, psm: number) => number;
    freeTexture?: (handle: number) => void;
  };
  const ui = () => (globalThis as { ui?: SimUi }).ui;
  const upload = (flagsNow: number) =>
    ui()?.uploadTexture?.(flagsNow & CAMERA_OPEN.inner ? simInnerFrame() : simCameraFrame(), CAMERA_TEXTURE_WIDTH, CAMERA_TEXTURE_HEIGHT, PSM_8888) ?? -1;

  const ns: CameraOps & PhotoOps = {
    open(requested?: number) {
      const wanted = (requested ?? 0) & (CAMERA_OPEN.inner | CAMERA_OPEN.noScan);
      log.push(requested === undefined ? "open" : `open ${wanted}`);
      if (open && wanted === flags) return handle;
      if (handle >= 0 && wanted !== flags) {
        ui()?.freeTexture?.(handle);
        handle = -1;
      }
      flags = wanted;
      if (handle < 0) handle = upload(flags);
      open = handle >= 0;
      frames = 0;
      scans = 0;
      return handle;
    },
    close() {
      log.push("close");
      open = false;
    },
    poll() {
      if (!open) return undefined;
      frames++;
      scans++;
      const payload = next;
      next = undefined;
      return payload;
    },
    info(): string {
      const info: CameraInfo = { open, frames, scans, error: open || handle >= 0 ? "" : "camera: no texture" };
      return JSON.stringify(info);
    },
    capture() {
      if (!open) return -1;
      job += 1;
      const highest = stored.filter((name) => name.startsWith("100POCKT/PKT_")).map(photoNumber);
      const name = `100POCKT/PKT_${String(Math.max(0, ...highest) + 1).padStart(4, "0")}.JPG`;
      stored.push(name);
      log.push(`capture ${name}`);
      pending.push({ t: "saved", job, name, ms: 0 });
      return job;
    },
    photos() {
      const list: PhotoEntry[] = sorted().map((name) => ({ name, bytes: 60_000 + (photoNumber(name) % 97) * 100 }));
      return JSON.stringify(list);
    },
    load(name: string, kind: number) {
      log.push(`load ${kind} ${name}`);
      if (!stored.includes(name) || (kind !== PHOTO_KIND.thumb && kind !== PHOTO_KIND.full)) return -1;
      const thumb = kind === PHOTO_KIND.thumb;
      const [w, h, tw, th] = thumb
        ? [PHOTO_THUMB_SIZE, PHOTO_THUMB_SIZE, PHOTO_THUMB_TEXTURE, PHOTO_THUMB_TEXTURE]
        : [CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_TEXTURE_WIDTH, CAMERA_TEXTURE_HEIGHT];
      const texture = ui()?.uploadTexture?.(simPhotoPixels(name, w, h, tw, th), tw, th, PSM_8888) ?? -1;
      if (texture < 0) return -1;
      live.add(texture);
      pending.push({ t: "loaded", name, kind, handle: texture, ms: 0 });
      return PHOTO_PENDING;
    },
    free(texture: number) {
      if (!live.delete(texture)) return;
      ui()?.freeTexture?.(texture);
    },
    remove(name: string) {
      const index = stored.indexOf(name);
      if (index < 0) return false;
      stored.splice(index, 1);
      log.push(`remove ${name}`);
      return true;
    },
    events() {
      if (pending.length === 0) return undefined;
      const out = JSON.stringify(pending);
      pending = [];
      return out;
    },
  };

  return {
    ns,
    photos: () => sorted(),
    inner: () => (flags & CAMERA_OPEN.inner) !== 0,
    show(payload) {
      next = payload;
    },
    log,
    open: () => open,
  };
}
