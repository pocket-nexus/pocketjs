import { expect, test } from "bun:test";
import { createLoop } from "../framework/src/game2d/loop.ts";
import { createDirector } from "../framework/src/game2d/scene.ts";
import { createTexturePool } from "../framework/src/game2d/textures.ts";

test("a frame runs the steps its time covers and carries the rest", () => {
  const loop = createLoop({ hz: 60 }), firsts: boolean[] = [];
  const run = (ms: number) => loop.frame((_, first) => firsts.push(first), ms);
  expect(run(1000 / 60)).toBe(1);
  expect(run(1000 / 30)).toBe(2); // a host at 30 fps keeps full speed
  expect(firsts).toEqual([true, true, false]);
  expect(run(1000 / 120)).toBe(0); // a 120 Hz display: every other frame
  expect(run(1000 / 120)).toBe(1);
  expect(run(10_000)).toBe(4); // a hitch is capped, not replayed
  expect(run(1000 / 60)).toBe(1);
});

test("without an override, the interval is the larger of the wall clock and the virtual frame", () => {
  let t = 0;
  const loop = createLoop({ hz: 60, now: () => t });
  const run = () => loop.frame(() => {});
  expect(run()).toBe(1); // first frame: one virtual frame
  t += 0; expect(run()).toBe(1); // stepped faster than real time: one step per frame
  t += 50; expect(run()).toBe(3); // a slow frame catches up
});

test("the director enters, leaves, steps, follows a name kept elsewhere, and resets", () => {
  const log: string[] = [];
  const scene = (n: string) => ({ enter: (from: string | null) => log.push(`enter ${n} from ${from}`), leave: (to: string) => log.push(`leave ${n} to ${to}`), reset: () => log.push(`reset ${n}`), step: () => log.push(`step ${n}`) });
  let state: "title" | "world" = "title";
  const d = createDirector({ scenes: { title: scene("title"), world: scene("world") }, initial: "title", follow: () => state });
  d.sync(); d.step(16);
  state = "world"; d.sync(); d.sync(); d.step(16);
  d.reset();
  expect(log).toEqual([
    "enter title from null", "step title",
    "leave title to world", "enter world from title", "step world",
    "leave world to title", "reset title", "reset world", "enter title from null",
  ]);
});

test("a pinned image survives eviction until unpinned; release drops it and changes the epoch", () => {
  const imgs = Array.from({ length: 3 }, (_, i) => ({ pack: "p", name: `i${i}`, off: 0, len: 8, tw: 64, th: 64, w: 64, h: 64, ox: 0, oy: 0, fw: 64, fh: 64, ax: 0, ay: 0, handle: -1, used: 0, fails: 0, retryAt: 0, pins: 0 }));
  let next = 1;
  const pool = createTexturePool({ loadImage: () => next++ } as any, 2 * (64 * 64 + 1024 + 32), () => {});
  const [pinned, other, late] = imgs;
  pool.beginFrame(); pool.get(pinned); pool.pin(pinned);
  pool.beginFrame(); pool.get(other);
  pool.beginFrame(); pool.get(late); // over budget: the unpinned older image goes
  expect(pinned.handle).toBeGreaterThan(0);
  expect(other.handle).toBe(-1);
  const epoch = pool.epoch();
  pool.release();
  expect(pinned.handle).toBe(-1);
  expect(pool.epoch()).not.toBe(epoch);
});

test("layers beginning one host frame mark one LRU frame", () => {
  const img = { pack: "p", name: "a", off: 0, len: 8, tw: 64, th: 64, w: 64, h: 64, ox: 0, oy: 0, fw: 64, fh: 64, ax: 0, ay: 0, handle: -1, used: 0, fails: 0, retryAt: 0, pins: 0 };
  const pool = createTexturePool({ loadImage: () => 1 } as any, 1 << 20, () => {});
  pool.beginFrame(7); pool.get(img);
  const used = img.used;
  pool.beginFrame(7); // a second layer, same host frame
  pool.get(img);
  expect(img.used).toBe(used);
  pool.beginFrame(8);
  pool.get(img);
  expect(img.used).toBe(used + 1);
});
