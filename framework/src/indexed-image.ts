import { getOps, type HostOps } from "./host.ts";

/** A bounded, opaque 16-color image. Low nibble is the first pixel. */
export interface IndexedImage {
  width: number;
  height: number;
  pixels: string;
  /** Six RGB hex digits per entry, from one to sixteen entries. */
  palette: string;
}

/** Expands at most 4,096 pixels, including transparent power-of-two padding.
 * Call from a resource materializer with an explicit per-frame upload budget. */
export function uploadIndexedImage(image: IndexedImage, ops: Pick<HostOps, "uploadTexture"> = getOps()) {
  const { width, height, pixels, palette } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 128 || height > 64 || width * height > 4096 ||
      typeof palette !== "string" || !/^(?:[\da-fA-F]{6}){1,16}$/.test(palette) ||
      typeof pixels !== "string" || pixels.length !== Math.ceil(Math.ceil(width * height / 2) / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pixels))
    throw new Error("Invalid indexed image");
  let w = 8, h = 8;
  while (w < width) w *= 2;
  while (h < height) h *= 2;
  const rgba = new Uint8Array(w * h * 4), colors: number[] = [];
  for (let i = 0; i < palette.length; i += 6) colors.push(parseInt(palette.slice(i, i + 6), 16));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let accumulator = 0, bits = 0, pixel = 0, bytes = 0;
  for (let i = 0; i < pixels.length && pixels[i] !== "="; i++) {
    accumulator = (accumulator << 6) | alphabet.indexOf(pixels[i]); bits += 6;
    if (bits < 8) continue;
    bits -= 8; const packed = (accumulator >> bits) & 255; bytes++;
    for (let shift = 0; shift <= 4 && pixel < width * height; shift += 4) {
      const index = (packed >> shift) & 15;
      if (index >= colors.length) throw new Error("Indexed image palette overflow");
      const color = colors[index], at = (Math.floor(pixel / width) * w + pixel % width) * 4;
      rgba[at] = color >> 16; rgba[at + 1] = color >> 8; rgba[at + 2] = color; rgba[at + 3] = 255;
      pixel++;
    }
  }
  if (bytes !== Math.ceil(width * height / 2)) throw new Error("Invalid indexed image length");
  const handle = ops.uploadTexture(rgba, w, h, 3);
  if (handle < 0) throw new Error("Indexed image upload failed");
  return { handle, width: w, height: h };
}
