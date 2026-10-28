// A QR code as a texture: one texel per module in a 64x64 RGBA texture, the
// code in its top-left corner. The view clips an image of the whole texture,
// scaled by a whole number, to the code's size, so every module covers the
// same number of panel pixels (the raster samples nearest).

import { getOps } from "@pocketjs/framework/host";
import { encodeQr } from "../../tools/companion/qr.ts";

export const QR_TEXTURE = 64;
const PSM_8888 = 3;

export interface QrTexture {
  handle: number;
  /** Modules per side. */
  size: number;
}

/** Upload `data` (ASCII: a URL or the pairing URI) as a QR texture. */
export function uploadQr(data: string): QrTexture | null {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0x7f;
  let code;
  try {
    code = encodeQr(bytes);
  } catch {
    return null;
  }
  if (code.size > QR_TEXTURE) return null;
  const rgba = new Uint8Array(QR_TEXTURE * QR_TEXTURE * 4).fill(255);
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y]![x]) continue;
      const at = (y * QR_TEXTURE + x) * 4;
      rgba[at] = rgba[at + 1] = rgba[at + 2] = 0;
    }
  }
  const handle = getOps().uploadTexture(rgba, QR_TEXTURE, QR_TEXTURE, PSM_8888);
  return handle < 0 ? null : { handle, size: code.size };
}

export function freeQr(texture: QrTexture | null): void {
  if (texture) getOps().freeTexture?.(texture.handle);
}
