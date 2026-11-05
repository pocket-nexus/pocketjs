import { beforeEach, expect, test } from "bun:test";
import { createLightMask } from "../framework/src/game2d/light.ts";

let uploads = 0;
const ops = { uploadImgEntry: () => ++uploads, freeTexture: () => {}, uploadTexture: () => ++uploads };
const mask = () => createLightMask({ screenW: 480, screenH: 272, ops });
const torch = (a?: number) => [{ x: 100, y: 100, r: 60, a }];

beforeEach(() => { uploads = 0; });

test("standing still keeps the texture", () => {
  const m = mask();
  m.update(torch(), 0);
  const first = uploads;
  for (let i = 0; i < 60; i++) m.update(torch(), 0);
  expect(uploads).toBe(first);
});

test("a change of ambient redraws", () => {
  const m = mask();
  m.update(torch(), 0);
  const first = uploads;
  for (let i = 0; i < 60; i++) m.update(torch(), 2);
  expect(uploads).toBeGreaterThan(first);
});

test("a change of one light's alpha redraws", () => {
  const m = mask();
  m.update(torch(1), 0);
  const first = uploads;
  for (let i = 0; i < 60; i++) m.update(torch(0.5), 0);
  expect(uploads).toBeGreaterThan(first);
});
