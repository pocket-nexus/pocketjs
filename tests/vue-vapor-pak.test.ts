import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { IMG_FLAG_LINEAR, PAK_DTYPE, PROP, PSM } from "../contracts/spec/spec.ts";
import { encodeImageEntry, pack } from "../framework/compiler/pak.ts";
import type { HostOps } from "../framework/src/host.ts";
import { resetPack } from "../framework/src/pak.ts";
import {
  createElement,
  insertNode,
  resetRendererState,
  resetSprites,
  resetTextures,
  rootMirror,
} from "../framework/src/native-tree.ts";
import { resolveTouchHit, resetInput } from "../framework/src/input.ts";
import { getAuxiliarySurfaceRoots } from "../framework/src/display.ts";
import { resetStyles } from "../framework/src/styles.ts";
import { createVueVaporTestRuntime } from "./vue-vapor-test-runtime.ts";

mock.module("vue", createVueVaporTestRuntime);

const { mount } = await import("../framework/src/index-vue-vapor.ts");
const { createElement: createVaporElement } = await import(
  "../framework/src/renderer-vue-vapor.ts"
);

const globals = globalThis as {
  ui?: HostOps;
  __pak?: ArrayBuffer;
  frame?: (buttons: number) => void;
  __pocketResizeViewport?: (width: number, height: number) => void;
};

afterEach(() => {
  delete globals.ui;
  delete globals.__pak;
  delete globals.frame;
  delete globals.__pocketResizeViewport;
  resetPack();
  resetRendererState();
  resetSprites();
  resetTextures();
  resetStyles();
  resetInput();
});

function symbianHost(calls: string[], propCalls: unknown[][] = []): HostOps {
  let nextId = 2;
  const noop = () => {};
  return {
    __host: "symbian-e7-dev",
    __hostAbi: POCKET_BINDING_GENERATION,
    createNode: () => nextId++,
    destroyNode: noop,
    insertBefore: noop,
    removeChild: noop,
    setStyle: noop,
    setProp: (...args) => propCalls.push(args),
    setText: noop,
    replaceText: noop,
    uploadTexture: () => 0,
    uploadImgEntry: (blob) => {
      calls.push(`uploadImgEntry:${blob[5]}`);
      return 1;
    },
    setImage: noop,
    setSprite: noop,
    animate: () => 1,
    cancelAnim: noop,
    setFocus: noop,
    loadStyles: () => calls.push("loadStyles"),
    loadFontAtlas: () => calls.push("loadFontAtlas"),
    measureText: () => 0,
  };
}

describe("Vue Vapor native runtime", () => {
  test("registers and clears the auxiliary hit root", () => {
    const calls: string[] = [];
    const ops = symbianHost(calls);
    ops.__auxiliarySurface = { root: 90, w: 320, h: 240 };
    globals.ui = ops;

    const dispose = mount(() => null, { ops, styles: {} });
    const target = createElement("view");
    insertNode(getAuxiliarySurfaceRoots().app, target);
    expect(resolveTouchHit(10, 20, target.id, "auxiliary")).toBe(target);

    dispose();
    expect(resolveTouchHit(10, 20, target.id, "auxiliary")).toBeNull();
  });

  test("target-marked host without native resource tables consumes the portable pak", () => {
    const calls: string[] = [];
    const ops = symbianHost(calls);
    const encoded = pack([
      { key: "ui:styles", dtype: PAK_DTYPE.u8, data: new Uint8Array([1, 2, 3]) },
      { key: "ui:font.0", dtype: PAK_DTYPE.u8, data: new Uint8Array([4, 5, 6]) },
      {
        key: "ui:img.logo.png",
        dtype: PAK_DTYPE.u8,
        data: encodeImageEntry(
          { width: 1, height: 1, rgba: new Uint8Array([10, 20, 30, 255]) },
          PSM.PSM_8888,
          IMG_FLAG_LINEAR,
        ),
      },
    ]);
    globals.ui = ops;
    globals.__pak = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer;

    const dispose = mount(() => null, { ops, styles: {} });
    expect(calls).toEqual([
      `uploadImgEntry:${IMG_FLAG_LINEAR}`,
      "loadFontAtlas",
      "loadStyles",
    ]);
    dispose();
  });

  test("native resize hook reflows a live tree without remounting or losing state", () => {
    const calls: string[] = [];
    const propCalls: unknown[][] = [];
    const ops = symbianHost(calls, propCalls) as HostOps & {
      __viewport?: { w: number; h: number };
    };
    ops.__viewport = { w: 640, h: 360 };
    globals.ui = ops;
    let setupCalls = 0;
    let localState: { count: number } | undefined;
    let content: ReturnType<typeof createVaporElement> | undefined;

    const dispose = mount(() => {
      setupCalls++;
      localState = { count: 7 };
      content = createVaporElement("view");
      return content;
    }, { ops, styles: {} });
    const appLayer = rootMirror.children[0]!;
    const mountedState = localState!;
    const mountedContent = content!;
    expect(typeof globals.__pocketResizeViewport).toBe("function");
    expect(appLayer.children[0]).toBe(mountedContent);
    expect(setupCalls).toBe(1);
    mountedState.count = 8;
    propCalls.length = 0;

    globals.__pocketResizeViewport?.(360, 640);

    expect(ops.__viewport).toEqual({ w: 360, h: 640 });
    expect(appLayer.children[0]).toBe(mountedContent);
    expect(localState).toBe(mountedState);
    expect(localState?.count).toBe(8);
    expect(setupCalls).toBe(1);
    expect(propCalls.filter((call) => call[1] === PROP.width && call[2] === 360)).toHaveLength(2);
    expect(propCalls.filter((call) => call[1] === PROP.height && call[2] === 640)).toHaveLength(2);

    dispose();
    expect(globals.__pocketResizeViewport).toBeUndefined();
  });
});
