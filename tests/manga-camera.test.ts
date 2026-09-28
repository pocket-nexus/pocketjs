import { expect, test } from "bun:test";
import { createPageCamera } from "../apps/manga/camera.ts";
const options = { width: 400, height: 240, x: 128, y: 128, zoom: 10, minZoom: 1, maxZoom: 18 };
test("anchored zoom preserves the world point beneath the chosen viewport pixel", () => {
  const camera = createPageCamera(options), before = camera.view();
  const at = (v: typeof before) => ({ x: v.x + (50 - 200) / v.scale, y: v.y + (80 - 120) / v.scale });
  camera.zoomBy(1, 50, 80); for (let i = 0; i < 20; i++) camera.step(1 / 60);
  expect(camera.view().zoom).toBe(11); expect(at(camera.view()).x).toBeCloseTo(at(before).x, 10); expect(at(camera.view()).y).toBeCloseTo(at(before).y, 10);
});
test("pan and inertia are sampled consistently at 30 and 60 Hz and react before IO", () => {
  const replay = (hz: number) => { const c = createPageCamera(options); for (let i = 0; i < hz; i++) c.step(1 / hz, 300, -180); for (let i = 0; i < hz; i++) c.step(1 / hz); return c.view(); };
  expect(replay(30).x).toBeCloseTo(replay(60).x, 9); expect(replay(30).y).toBeCloseTo(replay(60).y, 9);
  const c = createPageCamera(options); c.beginDrag(); c.drag(20, 30); expect(c.view().x).toBeLessThan(options.x);
  c.endDrag(200, 0); const x = c.view().x; c.step(1 / 60); expect(c.view().x).toBeLessThan(x);
});
test("page edges and small pages clamp without losing zoom or admitting invalid input", () => {
  const c = createPageCamera({ ...options, bounds: { width: 256, height: 256 } });
  c.jump(257, -100, 1); expect(c.view().x).toBe(156); expect(c.view().y).toBe(60);
  c.jump(-1, 1000, 99); expect(c.view().x).toBeGreaterThan(0); expect(c.view().zoom).toBe(18); expect(c.view().y).toBeLessThan(256);
  expect(() => c.step(1)).toThrow(); expect(() => c.drag(NaN, 0)).toThrow();
  const small = createPageCamera({ ...options, zoom: 0, minZoom: -4, bounds: { width: 100, height: 100 } });
  small.beginDrag(); small.drag(1000, -1000); expect(small.view().x).toBe(50); expect(small.view().y).toBe(50);
});
