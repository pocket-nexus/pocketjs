import { expect, test } from "bun:test";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { PROP, ENUMS, abgr } from "../contracts/spec/spec.ts";
import { PHYSICS_EVENT_WORDS, PHYSICS_KEY, PHYSICS_KIND } from "../contracts/spec/physics.ts";
import { installHost } from "../framework/src/host.ts";
import { createWorld, hasPhysics } from "../framework/src/physics.ts";
import { runServicePumps } from "../framework/src/services.ts";

const WASM = new URL("../hosts/web/pocketjs.wasm", import.meta.url);

async function dualScreen() {
  const wasm = await createWasmUi(await Bun.file(WASM).arrayBuffer(), { width: 400, height: 240 });
  const auxiliary = wasm.createAuxiliarySurface(320, 240);
  const ops = wasm.ops;
  const box = (root: number, x: number, y: number, w: number, h: number, color: number) => {
    const node = ops.createNode(0);
    ops.setProp(node, PROP.posType, ENUMS.PosType.Absolute);
    ops.setProp(node, PROP.insetL, x);
    ops.setProp(node, PROP.insetT, y);
    ops.setProp(node, PROP.width, w);
    ops.setProp(node, PROP.height, h);
    ops.setProp(node, PROP.bgColor, color);
    ops.insertBefore(root, node, 0);
    return node;
  };
  return { wasm, ops, auxiliary, box };
}

const pixel = (rgba: Uint8Array, width: number, x: number, y: number) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test("the wasm host exposes the physics ops and a body crosses from the bottom screen to the top", async () => {
  const { wasm, ops, auxiliary, box } = await dualScreen();
  expect(typeof ops.physicsCreate).toBe("function");
  const red = abgr(255, 0, 0);
  const top = box(1, 0, 0, 20, 20, red);
  const bottom = box(auxiliary, 0, 0, 20, 20, red);
  const kv = (...pairs: number[]) => new Float64Array(pairs).buffer;
  const world = ops.physicsCreate!(PHYSICS_KIND.world, kv(PHYSICS_KEY.gravityY, 0, PHYSICS_KEY.auxiliaryX, 40, PHYSICS_KEY.auxiliaryY, 296));
  const body = ops.physicsCreate!(
    PHYSICS_KIND.body,
    kv(PHYSICS_KEY.world, world, PHYSICS_KEY.view, top, PHYSICS_KEY.view, bottom, PHYSICS_KEY.shape, 1, PHYSICS_KEY.radius, 10,
      PHYSICS_KEY.x, 200, PHYSICS_KEY.y, 400, PHYSICS_KEY.vy, -1200, PHYSICS_KEY.linearDamping, 0),
  );
  expect(body).toBeGreaterThan(0);
  wasm.tick();
  // at y ≈ 380 it is on the bottom screen (origin 296) only
  let upper = wasm.render().slice(), lower = wasm.renderAuxiliary().slice();
  expect(pixel(lower, 320, 160, 84)).toEqual([255, 0, 0, 255]);
  expect(upper.some((v, i) => i % 4 === 0 && v === 255 && upper[i + 1] === 0)).toBe(false);
  for (let i = 0; i < 18; i++) wasm.tick(); // 0.3 s later: y ≈ 20, on the top screen
  upper = wasm.render().slice();
  lower = wasm.renderAuxiliary().slice();
  expect(pixel(upper, 400, 200, 20)).toEqual([255, 0, 0, 255]);
  expect(lower.some((v, i) => i % 4 === 0 && v === 255 && lower[i + 1] === 0)).toBe(false);
});

test("a skewed box renders as a parallelogram", async () => {
  const { wasm, ops, box } = await dualScreen();
  const node = box(1, 100, 100, 40, 40, abgr(0, 0, 255));
  ops.setProp(node, PROP.skewX, 30);
  wasm.tick();
  const rgba = wasm.render().slice();
  // shear about the centre: the top edge moves left, the bottom edge right
  expect(pixel(rgba, 400, 92, 102)).toEqual([0, 0, 255, 255]);
  expect(pixel(rgba, 400, 92, 137)[2]).not.toBe(255);
  expect(pixel(rgba, 400, 147, 137)).toEqual([0, 0, 255, 255]);
});

test("@pocketjs/framework/physics delivers landings through the service pump", async () => {
  const { wasm, ops, box } = await dualScreen();
  installHost({ ops, kind: "injected", target: "injected", strict: true });
  expect(hasPhysics()).toBe(true);
  const slot = box(1, 100, 40, 64, 64, abgr(0, 255, 0));
  const world = createWorld({ gravity: [0, 2500] });
  const letter = world.body({
    views: [slot],
    shape: { box: [20, 24], corner: 6 },
    asleep: true,
    position: [132, 400],
    anchor: { to: "layout", spring: { stiffness: 190, damping: 13 }, spin: { stiffness: 230, damping: 13 } },
    jelly: { squash: { stiffness: 540, damping: 12 }, land: { gain: 0.02, min: 1.4, max: 6.4, spin: 9 }, pivot: 21 },
  });
  const landings: number[] = [];
  letter.onLand((speed) => landings.push(speed));
  wasm.tick();
  letter.launch({ from: [132, 400], duration: 0.5, turn: 360, endOffset: 8, arrive: 300, grow: 0.3 });
  for (let frame = 0; frame < 40; frame++) {
    runServicePumps();
    wasm.tick();
  }
  runServicePumps();
  expect(landings).toEqual([300]);
  expect(letter.mode).toBe("anchored");
  expect(letter.home).toEqual([132, 72]); // the slot's layout centre
  expect(Math.abs(letter.y - 72)).toBeLessThan(4); // settling on the slot spring after the drop-in
  const raw = ops.physicsEvents!();
  expect(raw === undefined || new Float64Array(raw).length % PHYSICS_EVENT_WORDS === 0).toBe(true);
  world.destroy();
});
