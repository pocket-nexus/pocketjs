import { expect, test } from "bun:test";
import { uploadIndexedImage } from "../framework/src/indexed-image.ts";

test("indexed images preserve palette colors, odd rows and transparent padding", () => {
  let bytes: Uint8Array = new Uint8Array();
  const image = { width: 3, height: 2, pixels: Buffer.from([0x10, 0x01, 0x10]).toString("base64"), palette: "ff00330080ff" };
  const value = uploadIndexedImage(image, { uploadTexture(b, w, h, psm) { bytes = b; expect([w, h, psm]).toEqual([8, 8, 3]); return 7; } });
  expect(value).toEqual({ handle: 7, width: 8, height: 8 });
  expect([...bytes.slice(0, 8)]).toEqual([255, 0, 51, 255, 0, 128, 255, 255]);
  expect([...bytes.slice(32, 36)]).toEqual([255, 0, 51, 255]);
  expect(bytes[3 * 4 + 3]).toBe(0);
  expect(bytes[2 * 8 * 4 + 3]).toBe(0);
});

test("malformed images and allocation failures never publish a texture", () => {
  let uploads = 0;
  const ops = { uploadTexture() { uploads++; return -1; } };
  const image = { width: 2, height: 1, pixels: "AA==", palette: "ffffff" };
  for (const invalid of [{ width: 1000 }, { height: 0 }, { pixels: "AAAA" }, { pixels: "!A==" }, { pixels: "AQ==" }, { palette: "xxx" }])
    expect(() => uploadIndexedImage({ ...image, ...invalid }, ops)).toThrow();
  expect(uploads).toBe(0);
  expect(() => uploadIndexedImage(image, ops)).toThrow("upload failed");
});
