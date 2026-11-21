import { afterEach, describe, expect, test } from "bun:test";
import type { HostOps } from "../framework/src/host.ts";
import { render, type OctaneRenderRoot } from "../framework/src/index-octane.ts";
import { getAuxiliarySurfaceRoots } from "../framework/src/display.ts";
import { resetInput, resolveTouchHit } from "../framework/src/input.ts";
import {
  createElement,
  insertNode,
  resetRendererState,
  resetSprites,
  resetTextures,
} from "../framework/src/native-tree.ts";
import {
  defineUniversalComponent,
  OCTANE_RENDERER_ID,
  universalPlan,
  universalValue,
} from "../framework/src/renderer-octane.ts";
import { resetPack } from "../framework/src/pak.ts";
import { resetStyles } from "../framework/src/styles.ts";

const globals = globalThis as { frame?: (buttons: number) => void };

function makeHost(): HostOps {
  let nextId = 2;
  const noop = () => {};
  return {
    __auxiliarySurface: { root: 90, w: 320, h: 240 },
    createNode: () => nextId++,
    destroyNode: noop,
    insertBefore: noop,
    removeChild: noop,
    setStyle: noop,
    setProp: noop,
    setText: noop,
    replaceText: noop,
    uploadTexture: () => 0,
    setImage: noop,
    setSprite: noop,
    animate: () => 1,
    cancelAnim: noop,
    setFocus: noop,
    loadStyles: noop,
    loadFontAtlas: noop,
    measureText: () => 0,
  };
}

afterEach(() => {
  globals.frame = undefined;
  resetPack();
  resetRendererState();
  resetSprites();
  resetTextures();
  resetStyles();
  resetInput();
});

describe("Octane auxiliary input", () => {
  test("registers and clears the auxiliary hit root", () => {
    const ops = makeHost();
    const plan = universalPlan(OCTANE_RENDERER_ID, {
      kind: "host",
      type: "view",
      propsSlot: 0,
      children: [],
    });
    const root = defineUniversalComponent(
      OCTANE_RENDERER_ID,
      () => universalValue(plan, [{}]),
      { module: "@pocketjs/framework/octane/renderer" },
    ) as OctaneRenderRoot;
    const dispose = render(root, { ops, styles: {} });
    const target = createElement("view");
    insertNode(getAuxiliarySurfaceRoots().app, target);
    expect(resolveTouchHit(10, 20, target.id, "auxiliary")).toBe(target);

    dispose();
    expect(resolveTouchHit(10, 20, target.id, "auxiliary")).toBeNull();
  });
});
