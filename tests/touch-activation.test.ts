// The default activation recognizer (docs/TOUCH.md §0): a bare Focusable is
// a button on touch hosts — tap presses it through the shared pressNode
// pipeline, the `active:` look holds from the down edge, and non-focusable
// space presses nothing. Driven through the real frame pump with hit facts.
//
// Run: bun test --conditions=browser tests/touch-activation.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) {
  throw new Error("solid-js resolved to its SSR build — run: bun test --conditions=browser");
}

import { installHost, type Host, type HostOps } from "../framework/src/host.ts";
import { render as publicRender } from "../framework/src/index.ts";
import { resetRendererState, rootMirror, type NodeMirror } from "../framework/src/renderer.ts";
import { resetStyles } from "../framework/src/styles.ts";
import { resetInput } from "../framework/src/input.ts";
import { resetPack } from "../framework/src/pak.ts";
import { AuxiliarySurface, Focusable, Text, View } from "../framework/src/components.ts";
import { getAuxiliarySurfaceRoots } from "../framework/src/display.ts";
import { __packTouch } from "../framework/src/touch.ts";
import { ROOT_ID } from "../contracts/spec/spec.ts";

let activeCalls: (number | null)[] = [];

function makeHost(): Host {
  let nextId = ROOT_ID + 1;
  const noop = () => {};
  const ops: HostOps = {
    createNode: () => nextId++,
    destroyNode: noop,
    insertBefore: noop,
    removeChild: noop,
    setStyle: noop,
    setProp: noop,
    setText: noop,
    replaceText: noop,
    uploadTexture: () => 900,
    setImage: noop,
    setSprite: noop,
    animate: () => 1,
    cancelAnim: noop,
    setFocus: noop,
    setActive: (id: number, on: number) => activeCalls.push(on ? id : -id),
    loadStyles: noop,
    loadFontAtlas: noop,
    measureText: () => 0,
  };
  return { kind: "injected", target: "test", strict: true, ops };
}

let host: Host;
let dispose: (() => void) | null = null;
const g = globalThis as Record<string, unknown>;

function frame(
  buttons = 0,
  touches?: readonly number[],
  hits?: readonly number[],
  surfaces?: readonly number[],
): void {
  (g.frame as (
    b: number,
    a?: number,
    t?: readonly number[],
    h?: readonly number[],
    s?: readonly number[],
  ) => void)(
    buttons,
    undefined,
    touches,
    hits,
    surfaces,
  );
}

beforeEach(() => {
  activeCalls = [];
  host = makeHost();
  installHost(host);
  resetRendererState();
  resetStyles();
  resetPack();
  resetInput();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  g.frame = undefined;
});

function buttonNode(): NodeMirror {
  return rootMirror.children[0].children[0];
}

function mountButton(): number[] {
  const pressed: number[] = [];
  dispose = publicRender(
    () =>
      Focusable({
        onPress: () => pressed.push(1),
        style: { width: 120, height: 40 },
        get children() {
          return Text({ children: "GO" });
        },
      }) as unknown as NodeMirror,
    { ops: host.ops, styles: {} },
  );
  return pressed;
}

describe("tap → press", () => {
  test("a tap's hit fact on a bare Focusable fires onPress", () => {
    const pressed = mountButton();
    frame(0);
    frame(0, [__packTouch(1, 50, 20)], [buttonNode().id]);
    frame(0); // release: within slop → tap → pressNode
    expect(pressed).toEqual([1]);
  });

  test("the fact resolves THROUGH children to the focusable ancestor", () => {
    const pressed = mountButton();
    frame(0);
    const label = buttonNode().children[0];
    frame(0, [__packTouch(1, 50, 20)], [label.id]);
    frame(0);
    expect(pressed).toEqual([1]);
  });

  test("non-focusable space presses nothing", () => {
    const pressed = mountButton();
    frame(0);
    frame(0, [__packTouch(1, 400, 200)], [rootMirror.id]);
    frame(0);
    expect(pressed).toEqual([]);
  });

  test("an auxiliary hit fact activates a Focusable on the auxiliary root", () => {
    host.ops.__auxiliarySurface = { root: 90, w: 320, h: 240 };
    const pressed: number[] = [];
    dispose = publicRender(
      () =>
        View({
          children: AuxiliarySurface({
            children: () =>
              Focusable({
                onPress: () => pressed.push(1),
                children: Text({ children: "BOTTOM" }),
              }),
          }),
        }) as unknown as NodeMirror,
      { ops: host.ops, styles: {} },
    );
    const button = getAuxiliarySurfaceRoots().app.children[0].children[0];
    frame(0, [__packTouch(1, 50, 20)], [button.id], [1]);
    frame(0);
    expect(pressed).toEqual([1]);
  });
});

describe("pressed look", () => {
  test("active holds from the down edge and clears on release", () => {
    mountButton();
    frame(0);
    const id = buttonNode().id;
    frame(0, [__packTouch(1, 50, 20)], [id]);
    expect(activeCalls).toContain(id); // held from the down edge
    frame(0); // release (the tap fires; the pressed look lifts)
    expect(activeCalls).toContain(-id); // cleared
  });
});
