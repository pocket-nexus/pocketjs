// @pocketjs/framework/camera — camera preview and QR decoding (camera.qr),
// and photos kept on the console's storage (camera.photo)
// (`globalThis.camera`, contracts/spec/camera.ts).

import {
  CAMERA_HEIGHT,
  CAMERA_OPEN,
  CAMERA_TEXTURE_HEIGHT,
  CAMERA_TEXTURE_WIDTH,
  CAMERA_WIDTH,
  PHOTO_HEIGHT,
  PHOTO_KIND,
  PHOTO_NAME,
  PHOTO_PENDING,
  PHOTO_THUMB_SIZE,
  PHOTO_THUMB_TEXTURE,
  PHOTO_WIDTH,
  type CameraInfo,
  type PhotoEntry,
  type PhotoEvent,
} from "../../contracts/spec/camera.ts";

export {
  CAMERA_HEIGHT,
  CAMERA_OPEN,
  CAMERA_TEXTURE_HEIGHT,
  CAMERA_TEXTURE_WIDTH,
  CAMERA_WIDTH,
  PHOTO_HEIGHT,
  PHOTO_KIND,
  PHOTO_NAME,
  PHOTO_PENDING,
  PHOTO_THUMB_SIZE,
  PHOTO_THUMB_TEXTURE,
  PHOTO_WIDTH,
};
export type { CameraInfo, PhotoEntry, PhotoEvent };

export interface CameraOps {
  open(flags?: number): number;
  close(): void;
  poll(): string | undefined;
  info(): string;
}

/** camera.photo's operations on the same namespace. */
export interface PhotoOps {
  capture(): number;
  photos(): string;
  load(name: string, kind: number): number;
  free(handle: number): void;
  remove(name: string): boolean;
  events(): string | undefined;
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
 * renderer's registerTexture(key, handle) and draw it as <Image src={key}>.
 * Without options: the outer camera with QR decoding. Opening again with
 * other options switches cameras behind the same handle. */
export function openCamera(options?: { inner?: boolean; scan?: boolean }): number {
  const host = cameraHost();
  if (!host) return -1;
  if (!options) return host.open();
  const flags = (options.inner ? CAMERA_OPEN.inner : 0) | (options.scan === false ? CAMERA_OPEN.noScan : 0);
  return host.open(flags);
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

// ---- camera.photo ---------------------------------------------------------------

export function photoHost(): PhotoOps | null {
  const ops = cameraHost() as (CameraOps & Partial<PhotoOps>) | null;
  return ops &&
      typeof ops.capture === "function" &&
      typeof ops.photos === "function" &&
      typeof ops.load === "function" &&
      typeof ops.free === "function" &&
      typeof ops.remove === "function" &&
      typeof ops.events === "function"
    ? (ops as PhotoOps)
    : null;
}

/** Take a still from the open camera and save it. The job id, or -1 while
 *  one is being taken; a "saved" or "error" PhotoEvent follows. */
export function capturePhoto(): number {
  return photoHost()?.capture() ?? -1;
}

/** The photos on the storage, newest first. */
export function listPhotos(): PhotoEntry[] {
  const ops = photoHost();
  if (!ops) return [];
  try {
    const list = JSON.parse(ops.photos()) as PhotoEntry[];
    return Array.isArray(list) ? list.filter((entry) => PHOTO_NAME.test(entry.name)) : [];
  } catch {
    return [];
  }
}

/** Queue a decode: PHOTO_PENDING, or -1 when refused. A "loaded" event
 *  carries the texture handle; free it with freePhoto when it is off screen. */
export function loadPhoto(name: string, kind: number): number {
  return photoHost()?.load(name, kind) ?? -1;
}

export function freePhoto(handle: number): void {
  photoHost()?.free(handle);
}

export function deletePhoto(name: string): boolean {
  return photoHost()?.remove(name) ?? false;
}

/** The PhotoEvents since the last call. */
export function photoEvents(): PhotoEvent[] {
  const raw = photoHost()?.events();
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as PhotoEvent[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
