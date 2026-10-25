import { expect, test } from "bun:test";
import { createWasmUi } from "../platforms/web/wasm-ops.js";
import { PROP, abgr } from "../contracts/spec/spec.ts";

const wasmBytes = () => Bun.file(new URL("../platforms/web/pocketjs.wasm", import.meta.url)).arrayBuffer();

test("nodeRect returns the root-space border box of a nested node", async () => {
  const wasm = await createWasmUi(await wasmBytes(), { width: 480, height: 272 });
  const ops = wasm.ops;
  const parent = ops.createNode(0);
  ops.setProp(parent, PROP.marginL, 20); ops.setProp(parent, PROP.marginT, 10);
  ops.setProp(parent, PROP.width, 100); ops.setProp(parent, PROP.height, 80);
  ops.setProp(parent, PROP.paddingL, 5); ops.setProp(parent, PROP.paddingT, 3);
  ops.setProp(parent, PROP.bgColor, abgr(0, 0, 255));
  ops.insertBefore(1, parent, 0);
  const child = ops.createNode(0);
  ops.setProp(child, PROP.width, 40); ops.setProp(child, PROP.height, 30);
  ops.setProp(child, PROP.bgColor, abgr(255, 0, 0));
  ops.insertBefore(parent, child, 0);
  wasm.tick();
  expect(ops.nodeRect).toBeFunction();
  expect(ops.nodeRect!(parent)).toEqual({ x: 20, y: 10, w: 100, h: 80 });
  expect(ops.nodeRect!(child)).toEqual({ x: 25, y: 13, w: 40, h: 30 });
});

test("nodeRect is null for the none id and for a destroyed node", async () => {
  const wasm = await createWasmUi(await wasmBytes(), { width: 480, height: 272 });
  const ops = wasm.ops;
  const node = ops.createNode(0);
  ops.insertBefore(1, node, 0);
  wasm.tick();
  expect(ops.nodeRect).toBeFunction();
  expect(ops.nodeRect!(0)).toBeNull();
  ops.destroyNode(node);
  expect(ops.nodeRect!(node)).toBeNull();
});

test("painted pixels line up with the reported box for an untransformed node", async () => {
  const wasm = await createWasmUi(await wasmBytes(), { width: 480, height: 272 });
  const ops = wasm.ops;
  const parent = ops.createNode(0);
  ops.setProp(parent, PROP.marginL, 20); ops.setProp(parent, PROP.marginT, 10);
  ops.setProp(parent, PROP.width, 100); ops.setProp(parent, PROP.height, 80);
  ops.setProp(parent, PROP.paddingL, 5); ops.setProp(parent, PROP.paddingT, 3);
  ops.setProp(parent, PROP.bgColor, abgr(0, 0, 255));
  ops.insertBefore(1, parent, 0);
  const child = ops.createNode(0);
  ops.setProp(child, PROP.width, 40); ops.setProp(child, PROP.height, 30);
  ops.setProp(child, PROP.bgColor, abgr(255, 0, 0));
  ops.insertBefore(parent, child, 0);
  wasm.tick();
  const pixels = wasm.render();
  const at = (x: number, y: number) => Array.from(pixels.slice((y * 480 + x) * 4, (y * 480 + x) * 4 + 4));
  const blue = [0, 0, 255, 255], red = [255, 0, 0, 255];
  const parentBox = ops.nodeRect!(parent)!, childBox = ops.nodeRect!(child)!;
  expect(at(parentBox.x, parentBox.y)).toEqual(blue);
  expect(at(parentBox.x + parentBox.w - 1, parentBox.y + parentBox.h - 1)).toEqual(blue);
  expect(at(parentBox.x + parentBox.w, parentBox.y + parentBox.h)).not.toEqual(blue);
  expect(at(parentBox.x - 1, parentBox.y)).not.toEqual(blue);
  expect(at(childBox.x, childBox.y)).toEqual(red);
  expect(at(childBox.x + childBox.w - 1, childBox.y + childBox.h - 1)).toEqual(red);
  expect(at(childBox.x + childBox.w, childBox.y)).toEqual(blue);
});
