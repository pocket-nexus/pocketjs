// The live Solid build is the oracle: bun test --conditions=browser tests/solid-viewport.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { Text, useViewport } from "../framework/src/components.ts";
import { onViewport, render, resizeViewport } from "../framework/src/index.ts";
import { resetRendererState, rootMirror, type NodeMirror } from "../framework/src/renderer-solid.ts";
import { resetInput } from "../framework/src/input.ts";
import { resetFrameHooks } from "../framework/src/frame.ts";
import { SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";
import type { HostOps } from "../framework/src/host.ts";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) throw new Error("Run Solid oracle tests with --conditions=browser");

let dispose: (() => void) | undefined;
beforeEach(() => { resetRendererState(); resetInput(); resetFrameHooks(); });
afterEach(() => { dispose?.(); dispose = undefined; });
function ops(viewport?: { w: number; h: number }): HostOps {
  let next = 2;
  const noop = () => {};
  return { createNode: () => next++, destroyNode: noop, insertBefore: noop, removeChild: noop,
    setStyle: noop, setProp: noop, setText: noop, replaceText: noop, uploadTexture: () => 0,
    setImage: noop, setSprite: noop, animate: () => 1, cancelAnim: noop, setFocus: noop, measureText: () => 0,
    ...(viewport ? { __viewport: viewport } : {}) } as HostOps;
}
function text(node: NodeMirror = rootMirror): string { return (node.text ?? "") + node.children.map(child => text(child)).join(""); }
/** Three columns of 200 px with a 20 px gap need 640; the count follows the width. */
const Columns = () => {
  const viewport = useViewport();
  return Text({ get children() { return `${Math.max(1, Math.floor((viewport().w + 20) / 220))} columns at ${viewport().w}x${viewport().h}`; } });
};

test("useViewport starts at the size the host published and follows each resize", () => {
  dispose = render(Columns, { ops: ops({ w: 900, h: 600 }), styles: {} });
  expect(text()).toBe("4 columns at 900x600");
  resizeViewport(640, 480);
  expect(text()).toBe("3 columns at 640x480");
  resizeViewport(300, 480);
  expect(text()).toBe("1 columns at 300x480");
});

test("a host that publishes no viewport gives the spec screen", () => {
  dispose = render(Columns, { ops: ops(), styles: {} });
  expect(text()).toBe(`${Math.floor((SCREEN_W + 20) / 220)} columns at ${SCREEN_W}x${SCREEN_H}`);
});

test("onViewport reports each resize until it is removed, and a disposed component stops listening", () => {
  const seen: string[] = [];
  let calls = 0;
  dispose = render(() => {
    const viewport = useViewport();
    return Text({ get children() { calls++; return String(viewport().w); } });
  }, { ops: ops({ w: 800, h: 600 }), styles: {} });
  const remove = onViewport((w, h) => seen.push(`${w}x${h}`));
  resizeViewport(700, 500);
  // The same size again is not a change for the signal; the listener still hears the host.
  const before = calls;
  resizeViewport(700, 500);
  expect(calls).toBe(before);
  remove();
  resizeViewport(600, 400);
  expect(seen).toEqual(["700x500", "700x500"]);
  expect(text()).toBe("600");
  dispose!(); dispose = undefined;
  const after = calls;
  createRoot(() => {});
  resizeViewport(500, 300);
  expect(calls).toBe(after);
});
