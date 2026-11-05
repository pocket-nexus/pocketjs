import { createSignal } from "solid-js";
import { copyRect, fill, fillRect, i32, push, u8, type i32 as I32, type u8 as U8 } from "@pocketjs/framework/solid/std";
export const [result, setResult] = createSignal<I32[]>([]);
// A 6 x 4 screen and two 4 x 4 images, row-major.
let screen: U8[] = fill(24, u8(0));
let images: U8[][] = [[], []];
export function press(): void {
  const out: I32[] = [];
  images[0] = fill(16, u8(0));
  for (let i = 0; i < 16; i++) images[0][i] = u8(i % 5);
  images[1] = fill(16, u8(7));
  // Rectangles inside both arrays, with and without a skipped value.
  copyRect(screen, 7, 6, images[0], 1, 4, 3, 2);
  copyRect(screen, 0, 6, images[0], 0, 4, 4, 4, u8(0));
  for (const c of screen) push(out, i32(c));
  // Clipped at both ends, with a negative stride (a vertical flip), and empty.
  fillRect(screen, 0, 6, 6, 4, u8(9));
  copyRect(screen, -2, 6, images[0], 12, -4, 4, 3);
  copyRect(screen, 20, 6, images[1], 0, 4, 4, 3, u8(1));
  copyRect(screen, 0, 6, images[1], 0, 4, 0, 3);
  for (const c of screen) push(out, i32(c));
  // Rows copied between rows of one image read the source before writing.
  copyRect(images[0], 4, 4, images[0], 0, 4, 4, 3);
  for (const c of images[0]) push(out, i32(c));
  copyRect(images[1], 0, 4, images[0], 5, 4, 2, 2, u8(0));
  for (const c of images[1]) push(out, i32(c));
  // Fills inside, clipped, flipped and past the i32 range.
  fillRect(screen, 1, 6, 2, 3, u8(3));
  fillRect(screen, 22, -6, 4, 2, u8(4));
  fillRect(screen, -5, 6, 7, 2, u8(5));
  fillRect(screen, 2147483000, 2147483000, 10, 3, u8(6));
  fillRect(screen, 0, 1, -1, 5, u8(8));
  for (const c of screen) push(out, i32(c));
  // A loop that copies from an invariant row.
  for (let k = 0; k < 2; k++) copyRect(screen, k * 3, 6, images[1], k, 4, 2, 2, u8(7));
  for (const c of screen) push(out, i32(c));
  setResult(out);
}
