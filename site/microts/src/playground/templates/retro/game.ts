// A Pocket Retro game: setup() runs once, then update() and draw() run every frame.
// The same file builds a Game Boy Advance ROM with `bun tools/build.ts` in pocket-retro.
import { system, screen, input, sound, math } from "retro";
import { imod, type i32 } from "@pocketjs/framework/solid/std";

let x: i32 = 72;
let y: i32 = 52;
let color: i32 = 8;

export function setup(): void {
  system.init(160, 120);
  // notes, tones (p = pulse), volumes, effects (f = fade out), speed
  sound.set(0, "c3e3g3c4", "p", "6", "f", 6);
}

export function update(): void {
  if (input.btn(input.key.LEFT)) x--;
  if (input.btn(input.key.RIGHT)) x++;
  if (input.btn(input.key.UP)) y--;
  if (input.btn(input.key.DOWN)) y++;
  x = math.clamp(x, 0, 144);
  y = math.clamp(y, 12, 104);
  if (input.btnp(input.key.Z)) {
    color = imod(color, 15) + 1;
    sound.play(0, 0);
  }
}

export function draw(): void {
  screen.cls(1);
  screen.text(4, 4, "ARROWS MOVE  Z CHANGES COLOR", 7);
  screen.rect(x, y, 16, 16, color);
  screen.rectb(x, y, 16, 16, 7);
}
