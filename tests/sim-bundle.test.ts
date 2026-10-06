// tests/sim-bundle.test.ts — bootBundle (hosts/sim/sim.ts): a bundle built
// anywhere runs from its two files at the viewport its target has, a guest
// exception comes back as data, and the tree carries each node's box.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTN } from "../contracts/spec/spec.ts";
import { bootBundle, fnv1a, type SimNode } from "../hosts/sim/sim.ts";

const DIST = new URL("../dist/", import.meta.url).pathname;
const CAFE = { js: DIST + "cafe-main.js", pak: DIST + "cafe-main.pak" };
const scratch = mkdtempSync(join(tmpdir(), "pocketjs-sim-bundle-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function bundle(name: string, source: string): string {
  const path = join(scratch, `${name}.js`);
  writeFileSync(path, source);
  return path;
}

function flat(node: SimNode | null, out: SimNode[] = []): SimNode[] {
  if (!node) return out;
  out.push(node);
  for (const child of node.children) flat(child, out);
  return out;
}

/** The café journey of tests/sim.test.ts, as held input per frame. `probe` reads the tree after every frame. */
async function journey(probe = false): Promise<{ hashes: string[]; world: Awaited<ReturnType<typeof bootBundle>> }> {
  const world = await bootBundle(CAFE);
  const presses = new Map([[60, BTN.CIRCLE], [90, BTN.DOWN], [120, BTN.CIRCLE]]);
  const hashes: string[] = [];
  for (let frame = 0; frame < 150; frame++) {
    expect(world.step({ buttons: presses.get(frame) ?? 0 })).toBe(true);
    if (probe) world.tree();
    if (frame % 30 === 29) hashes.push(fnv1a(world.pixels().rgba));
  }
  return { hashes, world };
}

describe("bootBundle", () => {
  test("runs a built app from its files, the same way each time", async () => {
    const first = await journey();
    const second = await journey();
    expect(first.world.failure).toBeNull();
    expect(first.world.frames).toBe(150);
    expect(second.hashes).toEqual(first.hashes);
    // The journey changes what is on screen.
    expect(new Set(first.hashes).size).toBeGreaterThan(1);
    // Reading the tree runs no guest frame and leaves no highlight: the journey is the same with it.
    expect((await journey(true)).hashes).toEqual(first.hashes);
  }, 30000);

  test("pixels come at the raster density, as a copy", async () => {
    const world = await bootBundle({ ...CAFE, viewport: { width: 480, height: 272, rasterDensity: 2 } });
    for (let frame = 0; frame < 40; frame++) world.step();
    const before = world.pixels();
    expect([before.width, before.height, before.rgba.length]).toEqual([960, 544, 960 * 544 * 4]);
    const hash = fnv1a(before.rgba);
    world.step({ buttons: BTN.CIRCLE });
    for (let frame = 0; frame < 40; frame++) world.step();
    world.pixels();
    expect(fnv1a(before.rgba)).toBe(hash);
  }, 30000);

  test("the tree carries each painted node's box and each text, and reading it changes no pixel", async () => {
    const world = await bootBundle(CAFE);
    for (let frame = 0; frame < 60; frame++) world.step();
    const before = fnv1a(world.pixels().rgba);
    const nodes = flat(world.tree());
    expect(fnv1a(world.pixels().rgba)).toBe(before);

    expect(nodes[0]!.rect).toEqual([0, 0, 480, 272]);
    const texts = nodes.filter((node) => node.type === "text" && node.text !== "").map((node) => node.text);
    expect(texts.join("|")).toContain("ESPRESSO");
    // A <Text> element has the box; the run under it holds the characters.
    const element = nodes.find((node) => node.type === "text" && node.children.some((child) => child.text.includes("ESPRESSO")))!;
    const [x, y, w, h] = element.rect!;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(w).toBeGreaterThan(20);
    expect(h).toBeGreaterThan(8);
    expect(x + w).toBeLessThanOrEqual(480);
    // The pack's faces say how tall a line is, and a text box in one of them is that tall.
    expect(world.fonts.length).toBeGreaterThan(0);
    const faces = world.fonts.filter((font) => font.lineHeight === h);
    expect(faces.length).toBeGreaterThan(0);
    // The string measures no wider than the box it was laid out in, in either weight of that size.
    const said = element.children.map((child) => child.text).join("");
    for (const font of faces) {
      const measured = world.measureText(said, font.slot);
      expect(measured).toBeGreaterThan(20);
      expect(measured).toBeLessThanOrEqual(w);
    }
    expect(world.measureText(`${said} ${said} ${said}`, faces[0]!.slot)).toBeGreaterThan(w);
    // Colours are the core's 0xAABBGGRR: the text is opaque, and some view behind it has a background.
    expect(element.textColor >>> 24).toBe(0xff);
    expect(nodes.some((node) => node.type === "view" && node.bgColor >>> 24 === 0xff)).toBe(true);
    expect(world.tree("auxiliary")).toBeNull();
  }, 30000);

  test("a second screen has its own pixels and tree", async () => {
    const world = await bootBundle({
      js: bundle("two-screens", "globalThis.frame = function () {};"),
      viewport: { width: 400, height: 240, auxiliary: [320, 240] },
    });
    expect(world.viewport).toEqual({ width: 400, height: 240, rasterDensity: 1, auxiliary: [320, 240] });
    expect(world.step({ touches: [{ x: 160, y: 120 }], surface: "auxiliary" })).toBe(true);
    const top = world.pixels();
    const bottom = world.pixels("auxiliary");
    expect([top.width, top.height, bottom.width, bottom.height]).toEqual([400, 240, 320, 240]);
    expect(world.tree("auxiliary")!.rect).toEqual([0, 0, 320, 240]);
    expect(world.tree()!.rect).toEqual([0, 0, 400, 240]);
  });

  test("an exception inside a frame comes back with its frame and a stack that names the bundle", async () => {
    const world = await bootBundle({
      js: bundle(
        "lander",
        [
          "var fuel = { left: 3 };",
          "function burn() {",
          "  if (fuel.left === 0) fuel = undefined;",
          "  fuel.left -= 1;",
          "}",
          "globalThis.frame = function frame() { burn(); };",
        ].join("\n"),
      ),
    });
    expect(world.failure).toBeNull();
    let stepped = 0;
    while (world.step()) stepped++;
    expect(stepped).toBe(3);
    expect(world.frames).toBe(3);
    expect(world.failure!.phase).toBe("frame");
    expect(world.failure!.frame).toBe(3);
    expect(world.failure!.message).toContain("TypeError");
    expect(world.failure!.stack).toMatch(/at burn \(lander\.js:4:/);
    // A failed world stays where it stopped.
    expect(world.step()).toBe(false);
    expect(world.frames).toBe(3);
  });

  test("an exception while the bundle evaluates, and a bundle with no frame function, are boot failures", async () => {
    const thrown = await bootBundle({ js: bundle("broken", "function start() { throw new RangeError('no room'); }\nstart();") });
    expect(thrown.failure).toMatchObject({ phase: "boot", frame: 0, message: "RangeError: no room" });
    expect(thrown.failure!.stack).toMatch(/at start \(broken\.js:1:/);
    expect(thrown.step()).toBe(false);

    const idle = await bootBundle({ js: bundle("idle", "var nothing = 1;") });
    expect(idle.failure!.phase).toBe("boot");
    expect(idle.failure!.message).toContain("installed no frame function");
  });

  test("what the guest writes to console is kept with its frame and printed nowhere", async () => {
    const world = await bootBundle({
      js: bundle(
        "chatty",
        "console.log('boot', 1);\nvar n = 0;\nglobalThis.frame = function () { n++; if (n === 2) console.warn('second', { n: n }); };",
      ),
    });
    const printed: unknown[][] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void printed.push(args);
    try {
      world.step();
      world.step();
      world.step();
    } finally {
      console.log = log;
    }
    expect(printed).toEqual([]);
    expect(world.logs).toEqual([
      { frame: 0, level: "log", text: "boot 1" },
      { frame: 1, level: "warn", text: 'second {"n":2}' },
    ]);
    // The host's console is the host's again after each step.
    expect(console.log).toBe(log);
  });

  test("a missing bundle or wasm core is an error that names the path, and nothing is built", async () => {
    await expect(bootBundle({ js: join(scratch, "absent.js") })).rejects.toThrow(/the bundle is missing: .*absent\.js/);
    await expect(bootBundle({ js: bundle("any", "globalThis.frame = function () {};"), wasm: join(scratch, "absent.wasm") })).rejects.toThrow(
      /the wasm core is missing: .*absent\.wasm/,
    );
  });
});
