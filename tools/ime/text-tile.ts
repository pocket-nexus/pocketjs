import { createCanvas } from "@napi-rs/canvas";

/** One bounded canvas per connection worker; every tile uses the same baseline. */
export function createTextTileRenderer(font = "Pocket CJK") {
  const canvas = createCanvas(320, 64), context = canvas.getContext("2d");
  return (payload: string) => {
    const { text, width, size, row, bold, column = 0 } = JSON.parse(payload);
    if (typeof text !== "string" || text.length > 256 || !Number.isInteger(width) || width < 4 || width > 320 || width % 4 ||
      ![16, 20, 32, 40].includes(size) || ![0, 1, 2, 3].includes(row) || ![0, 1].includes(column) || typeof bold !== "boolean") throw new Error("Invalid text tile");
    context.clearRect(0, 0, 320, 64);
    context.font = `${bold ? "bold " : ""}${size}px "${font}"`;
    context.fillStyle = "white";
    // Canvas's `top` baseline can put CJK ink above y=0. Use font ascent
    // with leading in the guest's complete line box.
    context.textBaseline = "alphabetic";
    const metrics = context.measureText(text);
    const leading = Math.max(2, (size + 16 - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2);
    const baseline = Math.ceil(Math.max(metrics.fontBoundingBoxAscent, metrics.actualBoundingBoxAscent) + leading);
    context.fillText(text, -column * 320, baseline);
    const pixels = context.getImageData(0, row * 16, width, 16).data;
    const mask = Buffer.alloc(width * 4);
    for (let i = 0; i < width * 16; i++) mask[i >> 2] |= Math.round(pixels[i * 4 + 3] / 85) << ((i & 3) * 2);
    return mask.toString("base64");
  };
}
