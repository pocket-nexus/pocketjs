// PocketJS camera spec — a live preview texture and an on-device QR decoder
// (`globalThis.camera`, capability "camera.qr"), and stills kept on the
// console's storage (capability "camera.photo", the same namespace).
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
// camera.photo adds:
//
//   open(flags) -> handle | -1
//                             CAMERA_OPEN bits: `inner` previews the inner
//                             camera (mirrored, as a mirror reads), `noScan`
//                             skips QR decoding; open() alone is the outer
//                             camera with decoding, as above
//   capture() -> job | -1     take a PHOTO_WIDTH x PHOTO_HEIGHT still from the
//                             open camera and save it; -1 while one is still
//                             being taken. A "saved" or "error" event follows
//   photos() -> string        JSON PhotoEntry[], newest first
//   load(name, kind) -> -2 | -1
//                             decode a photo for drawing: PHOTO_KIND.thumb is
//                             a PHOTO_THUMB_SIZE square cropped from the
//                             middle in a PHOTO_THUMB_TEXTURE texture,
//                             PHOTO_KIND.full the whole photo fitted into
//                             CAMERA_WIDTH x CAMERA_HEIGHT in a camera-sized
//                             texture. -2: queued, a "loaded" event carries
//                             the handle; -1: no such photo or a full queue
//   free(handle)              release a handle a "loaded" event gave
//   remove(name) -> boolean   delete the photo and its cached thumbnail
//   events() -> string | undefined
//                             JSON PhotoEvent[] since the last call
//
// Photos are JPEG files under the storage's DCIM folder, named the way
// cameras name them (DCF): the console's own camera application and a
// computer reading the card list them, and photos() lists theirs too.
// A name is the path below DCIM, "100POCKT/PKT_0001.JPG".
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

// ---- camera.photo -------------------------------------------------------------

export const CAMERA_OPEN = { inner: 1, noScan: 2 } as const;
export const PHOTO_WIDTH = 640;
export const PHOTO_HEIGHT = 480;
export const PHOTO_KIND = { thumb: 0, full: 1 } as const;
/** A thumbnail's side; four fill a 320 px row with 2 px between them. */
export const PHOTO_THUMB_SIZE = 78;
export const PHOTO_THUMB_TEXTURE = 128;
/** A queued load the host answers later. */
export const PHOTO_PENDING = -2;
/** load() queues at most this many decodes. */
export const PHOTO_MAX_QUEUE = 24;

export interface PhotoEntry {
  /** The path below DCIM, "100POCKT/PKT_0001.JPG". */
  name: string;
  bytes: number;
}

export type PhotoEvent =
  | { t: "saved"; job: number; name: string; ms: number }
  | { t: "loaded"; name: string; kind: number; handle: number; ms: number }
  | { t: "error"; job?: number; name?: string; kind?: number; message: string };

/** DCF names: a folder of three digits and five characters, a file of four
 *  characters and four digits, a JPEG or a multi-picture (3D) JPEG. */
export const PHOTO_NAME = /^[1-9][0-9]{2}[A-Z0-9_]{5}\/[A-Z0-9_]{4}[0-9]{4}\.(JPG|MPO)$/;
