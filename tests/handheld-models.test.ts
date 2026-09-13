import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Box3, Raycaster, Vector3 } from "three";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { NODE_TYPE, PROP, ROOT_ID } from "../contracts/spec/spec.ts";

const assets = new URL("../engine/pocket3d/examples/handheld/assets/", import.meta.url);
async function model(device: string) {
  const path = new URL(`${device}/`, assets);
  const profile = JSON.parse(readFileSync(new URL("profile.json", path), "utf8"));
  const data = readFileSync(new URL(profile.lods.orbit, path));
  const gltf = await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "");
  gltf.scene.rotation.x = Math.PI / 2;
  gltf.scene.updateMatrixWorld(true);
  expect(existsSync(new URL(`${device}.blend`, path))).toBe(true);
  return { ...gltf, profile };
}

test("authored screens retain physical dimensions and independent UV materials", async () => {
  for (const [device, sizes] of [
    ["new-nintendo-3ds", [[84.6, 50.76], [67.68, 50.76]]],
    ["ps-vita-2000", [[110.7, 62.75]]],
  ] as const) {
    const { scene, profile } = await model(device);
    const screens: any[] = [];
    scene.traverse((o: any) => {
      if (o.isMesh && o.material.userData.pocket3d_role?.startsWith("dynamic_screen")) screens.push(o);
    });
    expect(screens.length).toBe(sizes.length);
    for (const [w,h] of sizes) {
      const screen = screens.find((o) => Math.abs(o.userData.screen_size_mm[0]-w)<.01);
      expect(screen).toBeDefined();
      const box = new Box3().setFromBufferAttribute(screen.geometry.attributes.position);
      const size = box.getSize(new Vector3());
      // Blender XY planes become glTF XZ planes.
      expect(size.x).toBeCloseTo(w, 2);
      expect(size.z).toBeCloseTo(h, 2);
      const uv = screen.geometry.attributes.uv;
      expect(Math.min(...uv.array)).toBe(0);
      expect(Math.max(...uv.array)).toBe(1);
    }
    expect(profile.parts.some((p: any) => p.button === "left")).toBe(true);
  }
});

test("3DS exported hinge moves the upper display and clears the lower glass when closed", async () => {
  const { scene, animations } = await model("new-nintendo-3ds");
  const hinge = scene.getObjectByName("Lid_Hinge")!;
  const upper = scene.getObjectByName("Screen_Primary")!;
  const lower = scene.getObjectByName("Screen_Auxiliary")!;
  expect(hinge).toBeDefined();
  expect(upper.parent).toBe(hinge);
  expect(lower.parent).not.toBe(hinge);
  expect(animations.some((a) => a.name === "Lid_OpenClose" && a.tracks.length > 0)).toBe(true);
  hinge.rotation.x = Math.PI;
  scene.updateMatrixWorld(true);
  const a = new Box3().setFromObject(upper), b = new Box3().setFromObject(lower);
  expect(a.min.z - b.max.z).toBeGreaterThan(.5);
  expect(a.min.y).toBeLessThan(b.max.y);
  const closed = upper.getWorldPosition(new Vector3());
  const baseBefore = lower.getWorldPosition(new Vector3());
  hinge.rotation.x = Math.PI * 25 / 180;
  scene.updateMatrixWorld(true);
  expect(upper.getWorldPosition(new Vector3()).distanceTo(closed)).toBeGreaterThan(50);
  expect(lower.getWorldPosition(new Vector3()).distanceTo(baseBefore)).toBeLessThan(.0001);
});

test("Vita shoulder pockets sit below the front lip and lower strap passages stay open", async () => {
  const { scene } = await model("ps-vita-2000");
  const hits = (x: number, y: number) => new Raycaster(
    new Vector3(x, y, 100), new Vector3(0, 0, -1),
  ).intersectObject(scene, true);
  for (const side of [-1, 1]) {
    // Probe the interior of both corner openings, away from their bevels.
    for (const [x, y] of [[71, 36], [74, 35]]) {
      const shoulder = hits(side * x, y)[0];
      expect(shoulder).toBeDefined();
      expect(shoulder.object.name).toContain("shoulder_resin");
      expect(shoulder.point.z).toBeLessThan(6);
      // Neither the chassis nor its thin assembly-seam mesh may cap the hole.
      expect(hits(side * x, -y)).toHaveLength(0);
    }
    // The outer strap bridge must survive the through-cut.
    expect(hits(side * 71, -38).length).toBeGreaterThan(0);
  }
});

test("WASM auxiliary output has separate dimensions, raster, hit root and reset lifetime", async () => {
  const bytes = await Bun.file(new URL("../hosts/web/pocketjs.wasm", import.meta.url)).arrayBuffer();
  const wasm = await createWasmUi(bytes, { width: 400, height: 240, auxiliary: [320,240] });
  const ops = wasm.ops;
  function rect(root: number, color: number, width: number) {
    const id = ops.createNode(NODE_TYPE.view);
    ops.setProp(id, PROP.width, width);
    ops.setProp(id, PROP.height, 240);
    ops.setProp(id, PROP.bgColor, color);
    ops.insertBefore(root,id,0);
    return id;
  }
  const main = rect(ROOT_ID, 0xff0000ff, 400);
  const aux = rect(ops.__auxiliarySurface!.root, 0xff00ff00, 320);
  wasm.tick();
  const mainPixels = wasm.render().slice();
  const auxPixels = wasm.renderAuxiliary().slice();
  expect(mainPixels.length).toBe(400*240*4);
  expect(auxPixels.length).toBe(320*240*4);
  expect([...mainPixels.slice(0,4)]).toEqual([255,0,0,255]);
  expect([...auxPixels.slice(0,4)]).toEqual([0,255,0,255]);
  expect(ops.hitTestBounds!(20,20)).toBe(main);
  expect(ops.hitTestBoundsAuxiliary!(20,20)).toBe(aux);
  expect(wasm.render()).toEqual(mainPixels);
  const other = await createWasmUi(bytes);
  expect(other.ops.__auxiliarySurface).toBeUndefined();
  expect(() => other.renderAuxiliary()).toThrow("no auxiliary");
  wasm.init();
  expect(ops.__auxiliarySurface!.root).toBeGreaterThan(0);
  expect(ops.hitTestBoundsAuxiliary!(20,20)).not.toBe(aux);
});
