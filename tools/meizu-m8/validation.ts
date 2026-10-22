const BMP_HEADER_BYTES = 54;
const BITMAP_INFO_HEADER_BYTES = 40;
const BGRA_BYTES_PER_PIXEL = 4;

export function validateMeizuM8FramebufferBmp(
  bytes: Buffer,
  expectedWidth: number,
  expectedHeight: number,
): void {
  if (bytes.length < BMP_HEADER_BYTES ||
      bytes.subarray(0, 2).toString("ascii") !== "BM") {
    throw new Error("PocketJS Meizu M8: device capture is not a BMP framebuffer");
  }

  const declaredSize = bytes.readUInt32LE(2);
  const pixelOffset = bytes.readUInt32LE(10);
  const dibSize = bytes.readUInt32LE(14);
  const width = bytes.readInt32LE(18);
  const signedHeight = bytes.readInt32LE(22);
  const planes = bytes.readUInt16LE(26);
  const bitsPerPixel = bytes.readUInt16LE(28);
  const compression = bytes.readUInt32LE(30);
  const declaredPixelBytes = bytes.readUInt32LE(34);
  const expectedPixelBytes = expectedWidth * expectedHeight * BGRA_BYTES_PER_PIXEL;
  const expectedSize = BMP_HEADER_BYTES + expectedPixelBytes;

  if (width !== expectedWidth || signedHeight !== -expectedHeight) {
    throw new Error(
      `PocketJS Meizu M8: device framebuffer is ${width}x${Math.abs(signedHeight)}, expected ${expectedWidth}x${expectedHeight} top-down`,
    );
  }
  if (pixelOffset !== BMP_HEADER_BYTES ||
      dibSize !== BITMAP_INFO_HEADER_BYTES ||
      planes !== 1 ||
      bitsPerPixel !== 32 ||
      compression !== 0) {
    throw new Error("PocketJS Meizu M8: device capture has an unsupported BMP layout");
  }
  if (declaredPixelBytes !== expectedPixelBytes ||
      declaredSize !== expectedSize ||
      bytes.length !== expectedSize) {
    throw new Error(
      `PocketJS Meizu M8: device capture payload is incomplete (${bytes.length}/${expectedSize} bytes)`,
    );
  }
}
