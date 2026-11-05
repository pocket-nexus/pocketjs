import { expect, test } from "bun:test";
import { PROP, abgr } from "../contracts/spec/spec.ts";
import { createWasmUi } from "../platforms/web/wasm-ops.js";

const core = async (options: { width: number; height: number; rasterDensity?: number }) =>
  createWasmUi(await Bun.file(new URL("../platforms/web/pocketjs.wasm", import.meta.url)).arrayBuffer(), options);

test("the premultiplied render keeps coverage in one drawing and leaves the opaque render as it is", async () => {
  for (const density of [1, 2]) {
    const wasm = await core({ width: 64, height: 32, rasterDensity: density });
    const ops = wasm.ops;
    const box = (parent: number, props: Record<number, number>) => {
      const node = ops.createNode(0);
      for (const [prop, value] of Object.entries(props)) ops.setProp(node, Number(prop), value);
      ops.insertBefore(parent, node, 0);
      return node;
    };
    // An opaque square, a translucent one with rounded corners over part of it, and one inside that.
    box(1, { [PROP.width]: 20, [PROP.height]: 20, [PROP.bgColor]: abgr(255, 0, 0) });
    const glass = box(1, { [PROP.width]: 30, [PROP.height]: 24, [PROP.bgColor]: abgr(11, 15, 21, 176), [PROP.radius]: 6 });
    box(glass, { [PROP.width]: 10, [PROP.height]: 10, [PROP.bgColor]: abgr(255, 255, 255, 128) });
    wasm.tick();

    const opaque = wasm.renderScaled(density).slice();
    const over = wasm.renderPremultiplied!(density).slice();
    expect(over.length).toBe(opaque.length);
    // The colour bytes are the opaque render's over its black clear.
    let covered = 0, clear = 0, between = 0;
    for (let i = 0; i < over.length; i += 4) {
      expect([i, over[i], over[i + 1], over[i + 2]]).toEqual([i, opaque[i], opaque[i + 1], opaque[i + 2]]);
      expect(opaque[i + 3]).toBe(255);
      if (over[i + 3] === 255) covered++;
      else if (over[i + 3] === 0) clear++;
      else between++;
    }
    expect([covered > 0, clear > 0, between > 0]).toEqual([true, true, true]);

    // What two opaque drawings recover (the root black, then white) is the same coverage, within the
    // rounding of a blend: the way a host found it before this export.
    ops.setProp(1, PROP.bgColor, 0xff000000);
    const black = wasm.renderScaled(density).slice();
    ops.setProp(1, PROP.bgColor, 0xffffffff);
    const white = wasm.renderScaled(density).slice();
    ops.setProp(1, PROP.bgColor, 0);
    let worst = 0;
    for (let i = 0; i < over.length; i += 4) worst = Math.max(worst, Math.abs(255 - (white[i + 1]! - black[i + 1]!) - over[i + 3]!));
    expect(worst).toBeLessThanOrEqual(2);

    // The opaque buffer and its incremental repaint retain their pixels.
    expect(wasm.renderScaled(density)).toEqual(opaque);
    wasm.renderPremultiplied!(density);
    expect(wasm.renderScaledIncremental(density)).toEqual(opaque);
    expect(wasm.renderPremultiplied!(density)).toEqual(over);
  }
});
