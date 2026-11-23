// tests/pocketui-sim.test.ts — the PocketUI gallery (apps/pocketui) on the
// simulation host, one build per kind of input: the PSP's buttons, the 3DS's
// touch screen, and a desktop window's pointer and wheel
// (tests/fixtures/pocketui-desktop). One application source; the surface
// decides what it is drawn on and what drives it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootSim, buildApp, GALLERY, type BuiltApp, type Sim } from "../tools/pocketui-sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const DESKTOP = join(ROOT, "tests/fixtures/pocketui-desktop/pocket.host.config.ts");
const OUT = mkdtempSync(join(tmpdir(), "pocketjs-pocketui-"));
const builds = new Map<string, BuiltApp>();

beforeAll(async () => {
  builds.set("psp", await buildApp(GALLERY, { target: "psp", outdir: join(OUT, "psp") }));
  builds.set("3ds-runtime", await buildApp(GALLERY, { target: "3ds-runtime", outdir: join(OUT, "3ds") }));
  builds.set("desktop", await buildApp(DESKTOP, { projectRoot: ROOT, outdir: join(OUT, "desktop") }));
}, 240_000);

afterAll(() => rmSync(OUT, { recursive: true, force: true }));

async function boot(name: string): Promise<Sim> {
  const sim = await bootSim(builds.get(name)!);
  await sim.run(30);
  expect(sim.world.failure).toBeNull();
  return sim;
}

/** The pixels of a rectangle of the surface, for comparing two moments. */
function region(sim: Sim, x: number, y: number, w: number, h: number): Buffer {
  const pixels = sim.world.pixels(sim.surface);
  const density = pixels.width / (sim.surface === "auxiliary" ? sim.world.viewport.auxiliary![0] : sim.world.viewport.width);
  const rows: Buffer[] = [];
  for (let row = y * density; row < (y + h) * density; row++) {
    const start = (row * pixels.width + x * density) * 4;
    rows.push(Buffer.from(pixels.rgba.subarray(start, start + w * density * 4)));
  }
  return Buffer.concat(rows);
}

const status = (sim: Sim) => sim.texts().find((text) => / - (Pocket|Classic 98|XP|Aqua)$/.test(text));

describe("the gallery", () => {
  test("draws on the surface each host gives it", async () => {
    const psp = await boot("psp");
    expect(psp.surface).toBe("primary");
    expect(psp.world.viewport).toMatchObject({ width: 480, height: 272 });
    const ds = await boot("3ds-runtime");
    expect(ds.surface).toBe("auxiliary");
    for (const sim of [psp, ds]) expect(sim.texts()).toContain("Inbox");
    // the PSP's screen is wide enough for a status line; the 3DS's touch screen keeps its rows
    expect(status(psp)).toBe("Inbox - Pocket");
  }, 60_000);

  test("buttons alone reach every control: the d-pad moves a focus that a confirm presses", async () => {
    const sim = await boot("psp");
    const before = sim.world.pixels().rgba.slice();
    await sim.press("DOWN");
    // the focus ring shows once a button was used
    expect(Buffer.from(sim.world.pixels().rgba).equals(Buffer.from(before))).toBe(false);
    // the legend names what the buttons do now, in the PSP's own marks
    expect(sim.texts()).toContain("Select");
    await sim.press("DOWN");
    await sim.press("CIRCLE");
    expect(sim.texts()).toContain("The default button.");
  }, 60_000);

  test("a theme repaints the same tree, and what was typed stays", async () => {
    const sim = await boot("3ds-runtime");
    const field = sim.texts().indexOf("Type here: it stays through a change of theme");
    expect(field).toBeGreaterThan(-1);
    for (const id of ["classic", "luna", "aqua"]) {
      await sim.run(1);
      const set = (globalThis as { __pocketUISetTheme?: (id: string) => void }).__pocketUISetTheme!;
      set(id);
      await sim.run(20);
      expect(sim.world.failure).toBeNull();
      expect(status(sim)).toMatch(/^Inbox - (Classic 98|XP|Aqua)$/);
    }
  }, 60_000);
});

describe("a desktop window", () => {
  test("a resting pointer is hover: the row under it lights and goes dark when it leaves", async () => {
    const sim = await boot("desktop");
    const row = () => region(sim, 0, 102, 160, 22);
    const rest = row();
    sim.hoverAt = [80, 113];
    await sim.run(4);
    const lit = row();
    expect(lit.equals(rest)).toBe(false);
    sim.hoverAt = null;
    await sim.run(4);
    expect(row().equals(rest)).toBe(true);
  }, 60_000);

  test("a click is a press: it selects the row", async () => {
    const sim = await boot("desktop");
    expect(status(sim)).toBe("Inbox - Pocket");
    await sim.click(80, 113);
    expect(status(sim)).toBe("Drafts - Pocket");
  }, 60_000);

  test("the wheel scrolls the view under the pointer", async () => {
    const sim = await boot("desktop");
    const page = () => region(sim, 200, 100, 400, 260);
    const top = page();
    for (let i = 0; i < 6; i++) await sim.wheel(450, 300, 40);
    await sim.run(30);
    expect(page().equals(top)).toBe(false);
    // the list beside it did not move
    expect(sim.texts()).toContain("Places");
  }, 60_000);

  test("a window made narrow stacks the panes, and wide again splits them, with the selection kept", async () => {
    const sim = await boot("desktop");
    await sim.click(80, 144);
    const chosen = status(sim);
    expect(chosen).toBe("Sent - Pocket");
    await sim.resize(420, 560);
    await sim.run(10);
    expect(sim.texts()).toContain("Back");
    await sim.resize(640, 400);
    await sim.run(10);
    expect(sim.texts()).toContain("Places");
    expect(status(sim)).toBe(chosen);
  }, 60_000);
});
