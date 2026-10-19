// PocketJS camera spec — a live preview texture and an on-device QR decoder
// (`globalThis.camera`, capability "camera.qr").
//
// The host captures from the outer camera, copies each frame into one host
// texture (the guest draws it like any image handle) and runs the QR decoder
// on a worker. Frames never cross into the guest heap.
//
//   open() -> handle | -1     start capture; the preview texture handle
//   close()                   stop capture and free the texture
//   poll() -> string | undefined
//                             the payload of a QR code decoded since the last
//                             poll (the newest one), as text
//   info() -> string          JSON CameraInfo
//
// The texture is CAMERA_TEXTURE_WIDTH x CAMERA_TEXTURE_HEIGHT; the image
// occupies its top-left CAMERA_WIDTH x CAMERA_HEIGHT, unmirrored. Draw it at
// texture size inside a box of image size that clips its overflow.

export const CAMERA_WIDTH = 320;
export const CAMERA_HEIGHT = 240;
export const CAMERA_TEXTURE_WIDTH = 512;
export const CAMERA_TEXTURE_HEIGHT = 256;
/** The longest payload poll() returns; longer codes are dropped. */
export const CAMERA_QR_MAX_BYTES = 512;

export interface CameraInfo {
  open: boolean;
  /** Frames captured since open(). */
  frames: number;
  /** Decode passes run since open(). */
  scans: number;
  error: string;
}
