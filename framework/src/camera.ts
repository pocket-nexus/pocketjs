// @pocketjs/framework/camera — outer-camera preview and QR decoding
// (`globalThis.camera`, contracts/spec/camera.ts).

import {
  CAMERA_HEIGHT,
  CAMERA_TEXTURE_HEIGHT,
  CAMERA_TEXTURE_WIDTH,
  CAMERA_WIDTH,
  type CameraInfo,
} from "../../contracts/spec/camera.ts";

export { CAMERA_HEIGHT, CAMERA_TEXTURE_HEIGHT, CAMERA_TEXTURE_WIDTH, CAMERA_WIDTH };
export type { CameraInfo };

export interface CameraOps {
  open(): number;
  close(): void;
  poll(): string | undefined;
  info(): string;
}

export function cameraHost(): CameraOps | null {
  const ns = (globalThis as { camera?: unknown }).camera;
  if (!ns || typeof ns !== "object") return null;
  const ops = ns as Partial<CameraOps>;
  return typeof ops.open === "function" &&
      typeof ops.close === "function" &&
      typeof ops.poll === "function" &&
      typeof ops.info === "function"
    ? (ops as CameraOps)
    : null;
}

/** Start capture. Returns the preview texture handle, or -1. Bind it with the
 * renderer's registerTexture(key, handle) and draw it as <Image src={key}>. */
export function openCamera(): number {
  return cameraHost()?.open() ?? -1;
}

export function closeCamera(): void {
  cameraHost()?.close();
}

/** The newest QR payload decoded since the last call. */
export function pollQrCode(): string | undefined {
  return cameraHost()?.poll();
}

export function cameraInfo(): CameraInfo | null {
  const ops = cameraHost();
  if (!ops) return null;
  try {
    return JSON.parse(ops.info()) as CameraInfo;
  } catch {
    return null;
  }
}
