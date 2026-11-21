import { createCanvas, loadImage } from "@napi-rs/canvas";

/** Rasterize vector artwork once, then average exact sample areas. */
export async function rasterizeIconSvg(svg: string, width: number, height = width, requireOpaque = true) {
  const scale = 4;
  const sized = svg.replace(/(<svg\b[^>]*\bwidth=")[^"]+("[^>]*\bheight=")[^"]+"/, `$1${width * scale}$2${height * scale}"`);
  if (sized === svg) throw new Error("Icon SVG must declare width and height");
  const image = await loadImage(Buffer.from(sized));
  if (image.width !== width * scale || image.height !== height * scale) throw new Error("Unexpected icon raster dimensions");
  const big = createCanvas(width * scale, height * scale);
  big.getContext("2d").drawImage(image, 0, 0);
  const pixels = big.getContext("2d").getImageData(0, 0, big.width, big.height).data;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const result = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sums = [0, 0, 0];
    let alpha = 0;
    for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) {
      const i = ((y * scale + yy) * big.width + x * scale + xx) * 4;
      const a = pixels[i + 3];
      alpha += a;
      for (let c = 0; c < 3; c++) sums[c] += pixels[i + c] * a;
    }
    const i = (y * width + x) * 4;
    // Average premultiplied samples, then return straight RGBA to Canvas.
    // Averaging transparent black into RGB leaves a dark halo at the mask.
    for (let c = 0; c < 3; c++) result.data[i + c] = alpha ? Math.round(sums[c] / alpha) : 0;
    result.data[i + 3] = Math.round(alpha / (scale * scale));
    if (requireOpaque && result.data[i + 3] !== 255) throw new Error("Icon artwork must be opaque");
  }
  ctx.putImageData(result, 0, 0);
  return canvas;
}
