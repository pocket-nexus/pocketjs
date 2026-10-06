import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appPoint, contentRect, hitScreen, type ScreenBinding, type Vertex } from "../site/desk/geometry.ts";
import { DESK_APPS } from "../site/desk-apps.ts";

test("perspective hit testing recovers app UV rather than affine screen coordinates", () => {
  const a: Vertex = [0, 0, 1, 0, 0], b: Vertex = [.5, 0, 2, 1, 0];
  const c: Vertex = [.5, .5, 2, 1, 1], d: Vertex = [0, 1, 1, 0, 1];
  const screen = { vertices: [a, b, c, a, c, d] } as ScreenBinding;
  for (const [u, v] of [[.7, .2], [.2, .8], [.5, .5]]) {
    const uv = hitScreen(screen, u / (1 + u), v / (1 + u))!;
    expect(uv[0]).toBeCloseTo(u, 6); expect(uv[1]).toBeCloseTo(v, 6);
  }
  expect(hitScreen(screen, .8, .8)).toBeNull();
});

test("letterboxing rejects border input and maps bottom-left UV to top-left app pixels", () => {
  const rect = contentRect([1920, 1080], [320, 480]);
  expect(rect[2]).toBeCloseTo(.375);
  expect(appPoint([.1, .5], rect, [320, 480])).toBeNull();
  expect(appPoint([.5, 1], rect, [320, 480])).toEqual([160, 0]);
  expect(appPoint([.5, 0], rect, [320, 480])).toEqual([160, 479]);
  expect(contentRect([640, 960], [320, 480])).toEqual([0, 0, 1, 1]);
});

test("committed projection covers six independent apps and seven UV-complete screens", () => {
  const root = new URL("../assets/scenes/desk-scene/", import.meta.url);
  const projection = JSON.parse(readFileSync(new URL("web.json", root), "utf8"));
  const source = JSON.parse(readFileSync(new URL("scene.json", root), "utf8"));
  expect(projection.generator_sha256).toBe(source.generator_sha256);
  expect(projection.image_size).toEqual([2560, 1920]);
  expect(projection.screens).toHaveLength(7);
  expect(new Set(projection.screens.map((s: ScreenBinding) => s.device))).toEqual(new Set(DESK_APPS.map(a => a.device)));
  for (const screen of projection.screens as ScreenBinding[]) {
    expect(screen.vertices.length % 3).toBe(0);
    for (const [x, y, z, u, v] of screen.vertices) {
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(1);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(1); expect(z).toBeGreaterThan(0);
      expect(u).toBeGreaterThanOrEqual(-1e-6); expect(u).toBeLessThanOrEqual(1.000001);
      expect(v).toBeGreaterThanOrEqual(-1e-6); expect(v).toBeLessThanOrEqual(1.000001);
    }
  }
  expect(projection.screens.filter((s: ScreenBinding) => s.device === "3ds").map((s: ScreenBinding) => s.surface).sort())
    .toEqual(["auxiliary", "primary"]);
});
