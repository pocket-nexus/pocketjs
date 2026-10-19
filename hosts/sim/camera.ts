// hosts/sim/camera.ts — a deterministic outer camera (`globalThis.camera`,
// contracts/spec/camera.ts). open() uploads one synthetic preview frame (a
// laptop screen showing a QR code, drawn from integer arithmetic) through the
// wasm core's uploadTexture; poll() returns the payloads a test shows it.

import {
  CAMERA_HEIGHT,
  CAMERA_TEXTURE_HEIGHT,
  CAMERA_TEXTURE_WIDTH,
  CAMERA_WIDTH,
  type CameraInfo,
} from "../../contracts/spec/camera.ts";
import type { CameraOps } from "../../framework/src/camera.ts";

const PSM_8888 = 3; // contracts/spec/spec.ts PSM.PSM_8888, literal: this module stays host-side

export interface SimCameraHost {
  readonly ns: CameraOps;
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

export function createSimCameraHost(): SimCameraHost {
  let open = false;
  let handle = -1;
  let frames = 0;
  let scans = 0;
  let next: string | undefined;
  const log: string[] = [];

  const ns: CameraOps = {
    open() {
      log.push("open");
      if (open) return handle;
      if (handle < 0) {
        const ui = (globalThis as { ui?: { uploadTexture?: (b: Uint8Array, w: number, h: number, psm: number) => number } }).ui;
        handle = ui?.uploadTexture?.(simCameraFrame(), CAMERA_TEXTURE_WIDTH, CAMERA_TEXTURE_HEIGHT, PSM_8888) ?? -1;
      }
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
  };

  return {
    ns,
    show(payload) {
      next = payload;
    },
    log,
    open: () => open,
  };
}
