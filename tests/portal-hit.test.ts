// Bounds hits vs overlay plumbing, on the REAL core (the class of bug mock
// hosts cannot see): a mounted Portal keeps a full-screen host box in the
// overlay layer, and that box must be hit-transparent — every touch on real
// hardware resolved to the TextField's portal host (constant node id across
// the whole screen) before hitPass covered portal plumbing.
//
// Run: bun test --conditions=browser tests/portal-hit.test.ts

import { afterEach, beforeEach, expect, test } from "bun:test";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) {
  throw new Error("solid-js resolved to its SSR build — run: bun test --conditions=browser");
}

import { createWasmUi } from "../platforms/web/wasm-ops.js";
import { installHost, detectHost, type HostOps } from "../framework/src/host.ts";
import { render as publicRender } from "../framework/src/index.ts";
import { resetRendererState, rootMirror, type NodeMirror } from "../framework/src/renderer.ts";
import { resetStyles } from "../framework/src/styles.ts";
import { resetInput } from "../framework/src/input.ts";
import { resetPack } from "../framework/src/pak.ts";
import { Focusable, Portal, Text } from "../framework/src/components.ts";
import { View } from "../framework/src/primitives.ts";

const WASM_PATH = new URL("../platforms/web/pocketjs.wasm", import.meta.url).pathname;
let wasmBytes: ArrayBuffer | null = null;

let dispose: (() => void) | null = null;
const g = globalThis as Record<string, unknown>;

beforeEach(() => {
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

test("a mounted Portal's full-screen host never swallows bounds hits", async () => {
  if (!wasmBytes) wasmBytes = await Bun.file(WASM_PATH).arrayBuffer();
  const wasm = await createWasmUi(wasmBytes);
  const ops = wasm.ops as HostOps & { hitTestBounds?: (x: number, y: number) => number };
  if (!ops.hitTestBounds) throw new Error("stale pocketjs.wasm — run: bun tools/wasm.ts");
  installHost(detectHost(ops));

  let button: NodeMirror | undefined;
  dispose = publicRender(
    () =>
      [
        Focusable({
          style: { width: 120, height: 40 },
          onPress: () => {},
          get children() {
            return Text({ children: "GO" });
          },
        }),
        // The regression shape: a portal whose CONTENT is empty chrome —
        // exactly what a closed TextField keeps mounted.
        Portal({
          children: () => View({ style: { width: 10, height: 10 } }),
        }),
      ] as unknown as NodeMirror,
    { ops, styles: {} },
  );
  button = rootMirror.children[0].children[0];

  (g.frame as (b: number) => void)(0);
  wasm.tick();

  // A point inside the button's box: the bounds hit must resolve INTO the
  // button's subtree, not the portal host covering the whole screen above it.
  const hit = ops.hitTestBounds(30, 15);
  const subtreeIds = new Set<number>();
  const collect = (n: NodeMirror): void => {
    subtreeIds.add(n.id);
    for (const c of n.children) collect(c);
  };
  collect(button!);
  expect(hit).toBeGreaterThan(0);
  expect(subtreeIds.has(hit)).toBe(true);
});
