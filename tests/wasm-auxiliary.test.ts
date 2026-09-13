import { expect, test } from "bun:test";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { PROP, abgr } from "../contracts/spec/spec.ts";

test("auxiliary raster and hit queries share resources without moving the primary viewport", async () => {
  const wasm = await createWasmUi(await Bun.file(new URL("../hosts/web/pocketjs.wasm", import.meta.url)).arrayBuffer(), { width: 400, height: 240 });
  const auxiliary = wasm.createAuxiliarySurface(320, 240), ops = wasm.ops;
  const rect = (root: number, color: number) => {
    const node = ops.createNode(0);
    ops.setProp(node, PROP.width, 40); ops.setProp(node, PROP.height, 30);
    ops.setProp(node, PROP.bgColor, color); ops.insertBefore(root, node, 0);
    return node;
  };
  const top = rect(1, abgr(255, 0, 0)), bottom = rect(auxiliary, abgr(0, 255, 0));
  wasm.tick();
  const first = wasm.render().slice(), lower = wasm.renderAuxiliary().slice();
  expect(first.length).toBe(400 * 240 * 4); expect(lower.length).toBe(320 * 240 * 4);
  expect([...first.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  expect([...lower.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  expect(ops.hitTest?.(10, 10)).toBe(top); expect(ops.hitTestAuxiliary?.(10, 10)).toBe(bottom);
  expect(wasm.render()).toEqual(first);
});
