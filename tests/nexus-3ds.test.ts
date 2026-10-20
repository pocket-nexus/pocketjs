import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHYSICS_HANDLE_GEN_SHIFT,
  PHYSICS_HANDLE_KIND_SHIFT,
  PHYSICS_KIND,
  PHYSICS_MODE,
  PHYSICS_QUERY as Q,
} from "../contracts/spec/physics.ts";
import { bootConsole3ds, type Console3ds } from "../hosts/sim/console-3ds.ts";
import type { SimNode } from "../hosts/sim/sim.ts";
import { encodePNG } from "../tools/png.ts";
import { WORD_BOX } from "../apps/nexus/art.ts";
import { WORD } from "../apps/nexus/homepage.ts";
import { FLOOR_Y, POCKET_CX, POCKET_TIP_Y, POCKET_TOP_Y, W, WORD_TOP } from "../apps/nexus/scene.ts";

// apps/nexus in the 3DS console sim (hosts/sim/console-3ds.ts) with the agent
// namespace mounted: the scene draws on the 320x240 touch screen only, the
// top screen is the system's. A stylus tape opens the pocket, the spill must
// put every letter in its slot, a toy popped from the pocket can be grabbed
// and thrown, and the whole run must be a pure function of the tape.
//
// POCKET_NEXUS_SHOTS=<dir> writes bottom-screen PNGs of the sleeping pocket,
// the settled wordmark and a thrown toy.

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), "pocketjs-nexus-"));
const GUEST = join(OUT, "guest", "nexus-main");
const SHOTS = process.env.POCKET_NEXUS_SHOTS;
const GLOBALS = ["ui", "__pak", "__simHz", "frame", "link", "wifi", "camera", "net", "agent", "__pocketApp"] as const;
const saved = new Map(GLOBALS.map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
const POCKET: [number, number] = [POCKET_CX, (POCKET_TOP_Y + POCKET_TIP_Y) / 2];

beforeAll(() => {
  const build = Bun.spawnSync(
    [process.execPath, "tools/3ds.ts", "nexus", "--pocket-only", `--outdir=${join(OUT, "guest")}`, `--package-outdir=${OUT}`],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`nexus guest build failed\n${build.stdout}${build.stderr}`);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 120_000);

afterAll(() => {
  for (const [key, value] of saved) (globalThis as Record<string, unknown>)[key] = value;
  rmSync(OUT, { recursive: true, force: true });
});

function boot(): Promise<Console3ds> {
  return bootConsole3ds({ js: `${GUEST}.js`, pak: `${GUEST}.pak`, current: "nexus-main", link: null, wifi: null, camera: false, agent: {} });
}

function shot(nexus: Console3ds, name: string): void {
  if (!SHOTS) return;
  const { width, height, rgba } = nexus.world.pixels("auxiliary");
  writeFileSync(join(SHOTS, `nexus-${name}.png`), encodePNG(rgba, width, height));
}

/** A handle the core issued for the object in `slot`, first generation. */
const handle = (kind: number, slot: number) => (kind << PHYSICS_HANDLE_KIND_SHIFT) | (0 << PHYSICS_HANDLE_GEN_SHIFT) | slot;
const query = (q: number, ...args: number[]): number => (globalThis as any).ui.physicsQuery(q, ...args);
const bodies = () => Array.from({ length: 63 }, (_, i) => handle(PHYSICS_KIND.body, i + 1));

/** Image nodes in a tree. */
const images = (node: SimNode | null): number =>
  node ? (node.type === "image" ? 1 : 0) + node.children.reduce((sum, child) => sum + images(child), 0) : 0;

/** FNV-1a over the touch screen's pixels. */
function hash(nexus: Console3ds): number {
  const { rgba } = nexus.world.pixels("auxiliary");
  let h = 0x811c9dc5;
  for (let i = 0; i < rgba.length; i++) h = Math.imul(h ^ rgba[i], 0x01000193) >>> 0;
  return h;
}

test("the scene draws on the touch screen only; the spill puts POCKET NEXUS in its slots", async () => {
  const nexus = await boot();
  await nexus.run(40);
  // the top screen holds only the system's layers: no text, no image of the app's
  expect(nexus.texts("primary")).toEqual([]);
  expect(images(nexus.tree("primary"))).toBe(0);
  expect(images(nexus.tree("auxiliary"))).toBeGreaterThan(20);
  shot(nexus, "sleep");
  const before = hash(nexus);
  await nexus.tap(...POCKET);
  await nexus.run(260);
  expect(hash(nexus)).not.toBe(before);
  shot(nexus, "spilled");
  // the letters are the anchored bodies whose rest positions lie in the wordmark block
  const letters = bodies().filter((b) => {
    const y = query(Q.anchorY, b);
    return query(Q.mode, b) === PHYSICS_MODE.anchored && y > WORD_TOP && y < WORD_TOP + WORD_BOX.h;
  });
  expect(letters.length).toBe(WORD.length);
  for (const b of letters) {
    expect(query(Q.speed, b)).toBeLessThan(40); // settled, not flying
    expect(query(Q.airborne, b)).toBe(0);
    expect(Math.abs(query(Q.y, b) - query(Q.anchorY, b))).toBeLessThan(3); // resting on its flexbox slot
  }
  expect(query(Q.pick, handle(PHYSICS_KIND.world, 1), ...POCKET, 1, 0)).toBe(0); // the pocket is not pickable
  expect(images(nexus.tree("primary"))).toBe(0);
}, 60_000);

test("a toy popped from the pocket can be grabbed and thrown", async () => {
  const nexus = await boot();
  await nexus.run(40);
  await nexus.tap(...POCKET);
  await nexus.run(260);
  // an unused body slot reads as a free body at the origin
  const live = (b: number) => query(Q.x, b) !== 0 || query(Q.y, b) !== 0;
  const free = new Set(bodies().filter((b) => query(Q.mode, b) === PHYSICS_MODE.free && live(b)));
  await nexus.tap(...POCKET);
  await nexus.run(120);
  // a toy the pop added, resting on the floor
  const toy = bodies().find((b) => query(Q.mode, b) === PHYSICS_MODE.free && live(b) && !free.has(b) && query(Q.speed, b) < 30 && query(Q.y, b) > FLOOR_Y - 60);
  expect(toy).toBeDefined();
  const [x, y] = [query(Q.x, toy!), query(Q.y, toy!)];
  expect(y).toBeLessThan(FLOOR_Y);
  // grab it and fling it up and across the screen
  const toX = x < W / 2 ? x + 90 : x - 90;
  for (let f = 0; f < 4; f++) await nexus.step({ touches: [{ x, y }], surface: "auxiliary" });
  expect(query(Q.mode, toy!)).toBe(PHYSICS_MODE.grabbed);
  for (let f = 1; f <= 6; f++) await nexus.step({ touches: [{ x: x + ((toX - x) * f) / 6, y: y - 15 * f }], surface: "auxiliary" });
  await nexus.step({ touches: [], surface: "auxiliary" });
  expect(query(Q.mode, toy!)).toBe(PHYSICS_MODE.free);
  expect(query(Q.speed, toy!)).toBeGreaterThan(300);
  await nexus.run(8);
  shot(nexus, "thrown");
  expect(Math.abs(query(Q.x, toy!) - x)).toBeGreaterThan(60);
  // it comes down again inside the room
  await nexus.run(240);
  expect(query(Q.y, toy!)).toBeLessThan(FLOOR_Y);
  expect(query(Q.x, toy!)).toBeGreaterThan(0);
  expect(query(Q.x, toy!)).toBeLessThan(W);
}, 60_000);

test("the scene is a pure function of the stylus tape", async () => {
  const hashes: number[][] = [[], []];
  for (const k of [0, 1]) {
    const nexus = await boot();
    await nexus.run(40);
    await nexus.tap(...POCKET);
    for (let f = 0; f < 380; f++) {
      if (f === 216) await nexus.tap(...POCKET);
      else if (f === 256) await nexus.tap(POCKET[0], POCKET[1] - 5);
      else await nexus.step();
      if (f % 60 === 59) hashes[k].push(hash(nexus));
    }
  }
  expect(hashes[0]).toEqual(hashes[1]);
  expect(new Set(hashes[0]).size).toBeGreaterThan(3);
}, 60_000);
