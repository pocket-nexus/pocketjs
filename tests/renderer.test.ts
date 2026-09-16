// Renderer contract tests — drive framework/src/renderer.ts against a MOCK HostOps that
// records every op call, using the real solid-js/universal reconciler under
// Bun. No JSX here (babel isn't in the loop for tests): we call the renderer
// exports exactly the way babel-preset-solid {generate:'universal'} compiled
// code does.
//
// Run: bun test --conditions=browser tests/renderer.test.ts
//
// The --conditions=browser flag is REQUIRED: without it Bun resolves solid-js
// via its "node" export condition to dist/server.js — the SSR build, whose
// createRenderEffect never re-runs, so every reactive update silently no-ops.
// (Same rule applies to Bun.build in tools/build.ts: conditions:["browser"].)

import { beforeEach, describe, expect, test } from "bun:test";
import { createSignal, For, Show } from "solid-js";

// Fail fast with a real message if the SSR build got resolved.
if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) {
  throw new Error(
    "solid-js resolved to its SSR build (dist/server.js) — reactive updates " +
      "would silently no-op. Run: bun test --conditions=browser",
  );
}

import {
  assertNativeHostContract,
  detectHost,
  installHost,
  parseHexColor,
  reportAppAction,
  type Host,
  type HostOps,
} from "../framework/src/host.ts";
import {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  missCounters,
  registerSprite,
  registerTexture,
  release,
  render,
  resetRendererState,
  resetSprites,
  resetTextures,
  retain,
  runSweep,
  setProp,
  setStyleResolver,
  type NodeMirror,
} from "../framework/src/renderer.ts";
import {
  registerStyles,
  resetStyles,
  resolveStyle,
} from "../framework/src/styles.ts";
import {
  getFocused,
  focusNode,
  handleFrame,
  pushFocusGrid,
  pushFocusScope,
  resetInput,
  setInputRoot,
} from "../framework/src/input.ts";
import {
  mount as publicMount,
  render as publicRender,
} from "../framework/src/index.ts";
import {
  pushButtonHandlerBlock,
  onButtonPress,
  onFrame,
} from "../framework/src/lifecycle.ts";
import { rootMirror } from "../framework/src/renderer.ts";
import {
  ActionBar,
  ActionHandler,
  AuxiliaryPortal,
  AuxiliarySurface,
  FocusGrid,
  Modal,
  Portal,
  Text,
  View,
} from "../framework/src/components.ts";
import { getAuxiliarySurfaceRoots } from "../framework/src/display.ts";
import { ClassicButton, ClassicSheet } from "../framework/src/classic.ts";
import { __runGestures, resetGestures, pushTouchBlock } from "../framework/src/gesture.ts";
import { __packTouch, __setTouches, __resetTouches } from "../framework/src/touch.ts";
import { __advanceClock, resetClock } from "../framework/src/clock.ts";
import {
  DeepZoom,
  type DeepZoomGesture,
  type DeepZoomView,
  type TileDoc,
} from "../framework/src/deepzoom.ts";
import { resetPack } from "../framework/src/pak.ts";
import { ResourceImage, pending, ready, failed, type ResourceState, type TextureResource } from "../framework/src/resource.ts";
import { encodeImageEntry, pack } from "../framework/compiler/pak.ts";
import {
  BTN,
  IMG_FLAG_LINEAR,
  PAK_DTYPE,
  NODE_TYPE,
  PSM,
  ROOT_ID,
  PROP,
  STYLE_ID_NONE,
} from "../contracts/spec/spec.ts";

// ---------------------------------------------------------------------------
// Mock host
// ---------------------------------------------------------------------------

type Call = [string, ...unknown[]];

// Solid's <For>/<Show> are typed against DOM JSX.Element; the renderer's node
// type here is NodeMirror. Runtime-identical — erase the type mismatch only.
const comp = createComponent as (fn: unknown, props: unknown) => NodeMirror;

interface MockHost extends Host {
  calls: Call[];
  /** calls filtered by op name(s) */
  of(...names: string[]): Call[];
  clear(): void;
  alive: Set<number>;
}

function makeMockHost(strict = true): MockHost {
  const calls: Call[] = [];
  let nextId = ROOT_ID + 1;
  const alive = new Set<number>([ROOT_ID]);
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ops: HostOps = {
    createNode(type: number): number {
      const id = nextId++;
      alive.add(id);
      calls.push(["createNode", type, id]);
      return id;
    },
    destroyNode(id: number): void {
      alive.delete(id);
      calls.push(["destroyNode", id]);
    },
    insertBefore: rec("insertBefore"),
    removeChild: rec("removeChild"),
    setStyle: rec("setStyle"),
    setProp: rec("setProp"),
    setText: rec("setText"),
    replaceText: rec("replaceText"),
    uploadTexture(_buf, _w, _h, _psm) {
      calls.push(["uploadTexture"]);
      return 900 + calls.length;
    },
    setImage: rec("setImage"),
    setSprite: rec("setSprite"),
    animate(...args: number[]) {
      calls.push(["animate", ...args]);
      return 1;
    },
    cancelAnim: rec("cancelAnim"),
    setFocus: rec("setFocus"),
    setActive: rec("setActive"),
    loadStyles: rec("loadStyles"),
    loadFontAtlas: rec("loadFontAtlas"),
    measureText: () => 0,
  };
  return {
    ops,
    kind: "injected",
    target: "test",
    strict,
    calls,
    alive,
    of(...names: string[]) {
      return calls.filter((c) => names.includes(c[0] as string));
    },
    clear() {
      calls.length = 0;
    },
  };
}

function freshRoot(): NodeMirror {
  return { id: ROOT_ID, type: NODE_TYPE.view, parent: null, children: [] };
}

/** Ids of a mirror node's children, in order. */
function childIds(node: NodeMirror): number[] {
  return node.children.map((c) => c.id);
}

let host: MockHost;
let root: NodeMirror;

test("classic buttons provide press, slide-out, disabled and cancelled feedback", () => {
  resetGestures(); __resetTouches(); resetClock();
  registerStyles({ "text-xs font-bold": 1 });
  let clicked = 0, hit = 0;
  host.ops.hitTestBounds = () => hit;
  const [disabled, setDisabled] = createSignal(false);
  const dispose = render(() => ClassicButton({ label: "Save", style: { width: 80, height: 24 },
    get disabled() { return disabled(); }, onPress() { clicked++; },
  }) as unknown as NodeMirror, root);
  setInputRoot(root);
  const button = root.children[0]; hit = button.id;
  const pump = (down: boolean) => { __advanceClock(); __setTouches(down ? [__packTouch(0, 10, 10)] : []); __runGestures(); };
  const changes = () => host.of("setProp").filter(call => call[1] === button.id && call[2] === PROP.gradFrom);
  host.clear(); pump(true); expect(changes()).toHaveLength(1); expect(clicked).toBe(0);
  pump(false); expect(changes()).toHaveLength(2); expect(clicked).toBe(1);
  pump(true); hit = 0;
  __advanceClock(); __setTouches([__packTouch(0, 100, 10)]); __runGestures();
  pump(false); expect(clicked).toBe(1); // release outside cancels
  hit = button.id; pump(true); setDisabled(true); pump(false); expect(clicked).toBe(1);
  setDisabled(false); pump(true); const unblock = pushTouchBlock(); pump(false); unblock(); expect(clicked).toBe(1);
  pump(true); pump(false); expect(clicked).toBe(2);
  dispose(); resetGestures(); __resetTouches();
});

test("classic sheets animate natively and retain modality through close and reopen", () => {
  resetGestures(); resetClock(); registerStyles({ "text-xs font-bold": 1, "text-xs": 2, "text-sm font-bold": 3 });
  const [open, setOpen] = createSignal(false);
  const modal: boolean[] = [];
  const dispose = render(() => ClassicSheet({ get open() { return open(); }, title: "Discard?", actions: [],
    onCancel() {}, onModalChange(value) { modal.push(value); },
  }) as unknown as NodeMirror, root);
  const frame = root.children[0], body = frame.children[1];
  host.clear(); setOpen(true);
  expect(modal).toEqual([true]);
  expect(host.of("animate").some(c => c[1] === body.id && c[2] === PROP.translateY && c[3] === 0)).toBe(true);
  setOpen(false); for (let i = 0; i < 4; i++) __advanceClock();
  expect(modal).toEqual([true]);
  setOpen(true); for (let i = 0; i < 15; i++) __advanceClock();
  expect(modal).toEqual([true]); // stale closing deadline cannot hide a reopened sheet
  setOpen(false); for (let i = 0; i < 12; i++) __advanceClock();
  expect(modal).toEqual([true, false]);
  setOpen(true); dispose();
  expect(modal.at(-1)).toBe(false);
  resetGestures(); resetClock();
});

test("resource images retain their layout through fallback, retry and borrowed texture replacement", () => {
  const [state, setState] = createSignal<ResourceState<TextureResource>>(pending());
  let skeletons = 0, frees = 0;
  host.ops.freeTexture = () => { frees++; };
  const dispose = render(() => ResourceImage({
    state, style: { width: 256, height: 16, overflow: 1 },
    fallback: () => { skeletons++; return Text({ children: "Skeleton" }); },
    errorFallback: () => Text({ children: "Retry" }),
  }) as unknown as NodeMirror, root);
  const frame = root.children[0];
  expect(skeletons).toBe(1);
  expect(host.of("setImage")).toHaveLength(0);
  host.clear();
  setState(pending());
  expect(skeletons).toBe(1);
  // Handle zero is valid. The component never uploads or frees borrowed images.
  setState(ready({ handle: 0, width: 256, height: 16 })); runSweep();
  const image = frame.children[0];
  expect(host.of("setImage")).toEqual([["setImage", image.id, 0]]);
  host.clear();
  setState(ready({ handle: 7, width: 256, height: 16 }));
  expect(frame.children[0]).toBe(image);
  expect(host.of("setImage")).toEqual([["setImage", image.id, 7]]);
  host.clear();
  setState(ready({ handle: 7, width: 256, height: 16 }));
  expect(host.of("setImage")).toHaveLength(0);
  setState(failed("offline")); runSweep();
  expect(host.of("setText").some(call => call[2] === "Retry")).toBe(true);
  setState(pending()); runSweep();
  expect(skeletons).toBe(2);
  expect(root.children[0]).toBe(frame);
  expect(host.of("setProp").filter(call => call[1] === frame.id)).toHaveLength(0);
  expect(host.of("uploadTexture")).toHaveLength(0);
  dispose(); runSweep(); expect(frees).toBe(0);
});

beforeEach(() => {
  host = makeMockHost();
  installHost(host);
  resetRendererState();
  resetStyles();
  resetSprites();
  resetTextures();
  resetPack();
  resetInput();
  setStyleResolver(resolveStyle);
  root = freshRoot();
  const g = globalThis as {
    ui?: HostOps;
    __pak?: ArrayBuffer;
    frame?: (buttons: number) => void;
  };
  delete g.ui;
  delete g.__pak;
  delete g.frame;
});

// ---------------------------------------------------------------------------

describe("pak image formats", () => {
  test("PSM 5650 packs opaque RGBA as little-endian B5:G6:R5", () => {
    const image = encodeImageEntry(
      {
        width: 2,
        height: 1,
        rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
      },
      PSM.PSM_5650,
    );
    expect(Array.from(image)).toEqual([
      2,
      0,
      1,
      0,
      PSM.PSM_5650,
      0,
      0,
      0,
      0x1f,
      0x00,
      0x00,
      0xf8,
    ]);

    expect(() =>
      encodeImageEntry(
        {
          width: 1,
          height: 1,
          rgba: new Uint8Array([255, 255, 255, 254]),
        },
        PSM.PSM_5650,
      ),
    ).toThrow(/fully opaque/);
  });
});

describe("basic mount", () => {
  test("static view with text child produces create/setText/insert ops", () => {
    const dispose = render(() => {
      const el = createElement("view");
      const t = createTextNode("hello");
      insertNode(el, t);
      return el;
    }, root);

    expect(host.of("createNode").map((c) => c[1])).toEqual([
      NODE_TYPE.view,
      NODE_TYPE.text,
    ]);
    expect(host.of("setText")).toEqual([["setText", 3, "hello"]]);
    // text into view (anchor 0 append), then view into root
    expect(host.of("insertBefore")).toEqual([
      ["insertBefore", 2, 3, 0],
      ["insertBefore", ROOT_ID, 2, 0],
    ]);
    expect(childIds(root)).toEqual([2]);
    dispose();
  });

  test("unknown tag throws", () => {
    expect(() => createElement("div")).toThrow(/unknown element/);
  });
});

describe("<For> reorder — DOM move semantics [R]", () => {
  test("rejects a foreign anchor before mutating either tree", () => {
    const parent = createElement("view");
    const other = createElement("view");
    const node = createElement("view");
    const anchor = createElement("view");
    insertNode(root, parent);
    insertNode(root, other);
    insertNode(parent, node);
    insertNode(other, anchor);
    host.clear();

    expect(() => insertNode(parent, node, anchor)).toThrow(
      "PocketJS: insert anchor is not a child of parent",
    );
    expect(node.parent).toBe(parent);
    expect(childIds(parent)).toEqual([node.id]);
    expect(host.of("insertBefore", "removeChild")).toEqual([]);
  });

  test("pure reverse never anchors a node on itself (DOM pre-insertion)", () => {
    interface Row {
      id: number;
    }
    const first: Row[] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
    const [rows, setRows] = createSignal(first);
    const byId = new Map<number, NodeMirror>();
    const dispose = render(
      () =>
        comp(For, {
          get each() {
            return rows();
          },
          children: (row: Row) => {
            const el = createElement("view");
            byId.set(row.id, el);
            return el;
          },
        }),
      root,
    );
    runSweep();
    host.clear();

    setRows([...first].reverse());
    runSweep();
    expect(childIds(root)).toEqual(
      [6, 5, 4, 3, 2, 1].map((id) => byId.get(id)!.id),
    );
    for (const call of host.of("insertBefore")) {
      expect(call[2]).not.toBe(call[3]);
    }
    expect(host.of("createNode")).toEqual([]);
    expect(host.of("destroyNode")).toEqual([]);

    // Exercise the update-then-reverse shape used by the external benchmark.
    const second = first.map((row, i) => (i === 2 ? { id: 99 } : row));
    setRows(second);
    runSweep();
    setRows([...second].reverse());
    runSweep();
    expect(childIds(root)).toEqual(
      [...second].reverse().map((row) => byId.get(row.id)!.id),
    );
    dispose();
  });

  test("reorder moves nodes without duplicates and without destroys", () => {
    const [items, setItems] = createSignal(["a", "b", "c"]);
    const byLabel = new Map<string, NodeMirror>();

    const dispose = render(
      () =>
        comp(For, {
          get each() {
            return items();
          },
          children: (item: string) => {
            const el = createElement("view");
            byLabel.set(item, el);
            return el;
          },
        }),
      root,
    );

    const [a, b, c] = [byLabel.get("a")!, byLabel.get("b")!, byLabel.get("c")!];
    expect(childIds(root)).toEqual([a.id, b.id, c.id]);
    host.clear();

    setItems(["c", "a", "b"]);

    // mirror order matches, no duplicate children
    expect(childIds(root)).toEqual([c.id, a.id, b.id]);
    expect(new Set(childIds(root)).size).toBe(3);
    // pure move: no node creation/destruction/removal, only insertBefore
    expect(host.of("createNode")).toEqual([]);
    expect(host.of("destroyNode")).toEqual([]);
    // every insertBefore targeted the root with an existing child (a move)
    for (const call of host.of("insertBefore")) {
      expect(call[1]).toBe(ROOT_ID);
      expect([a.id, b.id, c.id]).toContain(call[2] as number);
    }
    // sweep at frame end: nothing was left detached, so nothing is destroyed
    runSweep();
    expect(host.of("destroyNode")).toEqual([]);

    dispose();
  });

  test("an adjacent swap is a move too (insertBefore(node, node) is a no-op)", () => {
    // Solid's reconcileArrays swaps [a, b] by inserting b before a.nextSibling
    // — which is b itself. The DOM leaves the node in place; so must we,
    // instead of unlinking b and then failing to find it as the anchor.
    const [items, setItems] = createSignal(["a", "b", "c"]);
    const byLabel = new Map<string, NodeMirror>();

    const dispose = render(
      () =>
        comp(For, {
          get each() {
            return items();
          },
          children: (item: string) => {
            const el = createElement("view");
            byLabel.set(item, el);
            return el;
          },
        }),
      root,
    );

    const [a, b, c] = [byLabel.get("a")!, byLabel.get("b")!, byLabel.get("c")!];
    host.clear();
    setItems(["b", "a", "c"]);
    expect(childIds(root)).toEqual([b.id, a.id, c.id]);
    expect(new Set(childIds(root)).size).toBe(3);
    expect(host.of("createNode")).toEqual([]);
    expect(host.of("destroyNode")).toEqual([]);
    setItems(["b", "c", "a"]);
    expect(childIds(root)).toEqual([b.id, c.id, a.id]);
    runSweep();
    expect(host.of("destroyNode")).toEqual([]);

    dispose();
  });

  test("row removal detaches, then the frame-end sweep destroys", () => {
    const [items, setItems] = createSignal(["a", "b"]);
    const byLabel = new Map<string, NodeMirror>();

    const dispose = render(
      () =>
        comp(For, {
          get each() {
            return items();
          },
          children: (item: string) => {
            const el = createElement("view");
            byLabel.set(item, el);
            return el;
          },
        }),
      root,
    );
    const b = byLabel.get("b")!;
    host.clear();

    setItems(["a"]);
    // detached but NOT yet destroyed (Solid may re-insert within the frame)
    expect(host.of("removeChild")).toEqual([["removeChild", ROOT_ID, b.id]]);
    expect(host.of("destroyNode")).toEqual([]);
    expect(childIds(root)).toEqual([byLabel.get("a")!.id]);

    runSweep(); // frame end
    expect(host.of("destroyNode")).toEqual([["destroyNode", b.id]]);

    dispose();
  });

  test("retain() exempts a removed subtree from the sweep; release() re-arms it", () => {
    const [items, setItems] = createSignal(["a", "b"]);
    const byLabel = new Map<string, NodeMirror>();
    const dispose = render(
      () =>
        comp(For, {
          get each() {
            return items();
          },
          children: (item: string) => {
            const el = createElement("view");
            byLabel.set(item, el);
            return el;
          },
        }),
      root,
    );
    const b = byLabel.get("b")!;
    retain(b);
    host.clear();

    setItems(["a"]);
    runSweep();
    expect(host.of("destroyNode")).toEqual([]); // retained: survives detached

    release(b);
    runSweep();
    expect(host.of("destroyNode")).toEqual([["destroyNode", b.id]]);

    dispose();
  });
});

describe("<Show> toggle", () => {
  test("toggle removes then sweep destroys; re-show creates fresh nodes", () => {
    const [show, setShow] = createSignal(true);
    let shown: NodeMirror | null = null;

    const dispose = render(
      () =>
        comp(Show, {
          get when() {
            return show();
          },
          get children() {
            const el = createElement("view");
            shown = el;
            return el;
          },
        }),
      root,
    );

    const first = shown! as NodeMirror;
    expect(childIds(root)).toEqual([first.id]);
    host.clear();

    setShow(false);
    expect(host.of("removeChild").length).toBe(1);
    expect(childIds(root)).toEqual([]);
    runSweep();
    expect(host.of("destroyNode")).toEqual([["destroyNode", first.id]]);
    host.clear();

    setShow(true);
    const second = shown! as NodeMirror;
    expect(second.id).not.toBe(first.id); // fresh native node
    expect(childIds(root)).toEqual([second.id]);
    runSweep();
    expect(host.of("destroyNode")).toEqual([]);

    dispose();
  });

  test("remove-then-reinsert within one frame is NOT destroyed by the sweep", () => {
    // Simulates a move that Solid expresses as remove + insert before the
    // frame ends: the sweep must leave the re-attached node alone.
    const dispose = render(() => {
      const el = createElement("view");
      return el;
    }, root);
    const el = root.children[0];
    host.clear();

    // hand-drive the reconciler ops the way cleanChildren/reconcile would
    // (removeNode is not exported — go through Solid: insert an array where
    // the node moves behind a new sibling)
    const other = createElement("view");
    insertNode(root, other);
    // move el after other: remove + reinsert with no anchor
    // (renderer semantics: insertNode on an attached node unlinks first)
    insertNode(root, el);
    expect(childIds(root)).toEqual([other.id, el.id]);
    runSweep();
    expect(host.of("destroyNode")).toEqual([]);
    expect(host.alive.has(el.id)).toBe(true);

    dispose();
  });
});

describe("mixed text — 'Count: {n()} items'", () => {
  test("dynamic segment updates via replaceText on the SAME text node", () => {
    const [n, setN] = createSignal(1);

    // babel-universal output shape for <text>Count: {n()} items</text>:
    //   const el = createElement("text");
    //   insert(el, () => `Count: ${n()} items`);   // single template child
    // …and for multi-part children it inserts static text nodes + a dynamic
    // insert with a marker. Exercise the multi-part form (the harder one).
    const dispose = render(() => {
      const el = createElement("text");
      const head = createTextNode("Count: ");
      insertNode(el, head);
      const tail = createTextNode(" items");
      insertNode(el, tail);
      insert(el, () => String(n()), tail); // dynamic, anchored before tail
      return el;
    }, root);

    // creates: the <text> ELEMENT + 3 text nodes ('Count: ', ' items', '1')
    const textCreates = host
      .of("createNode")
      .filter((c) => c[1] === NODE_TYPE.text);
    expect(textCreates.length).toBe(4);
    const dynSet = host.of("setText").find((c) => c[2] === "1")!;
    expect(dynSet).toBeDefined();
    const dynId = dynSet[1] as number;

    // mirror: text element children are [head, dyn, tail]
    const textEl = root.children[0];
    expect(textEl.children.length).toBe(3);
    expect(textEl.children[1].id).toBe(dynId);
    host.clear();

    setN(42);
    // updates replace text in place — no new nodes, no re-insert
    expect(host.of("replaceText")).toEqual([["replaceText", dynId, "42"]]);
    expect(host.of("createNode")).toEqual([]);
    expect(host.of("insertBefore")).toEqual([]);
    expect(textEl.children[1].text).toBe("42");

    dispose();
  });
});

describe("setProperty dispatch table [R]", () => {
  test("signal-driven class swap emits setStyle per change", () => {
    registerStyles({ "bg-red p-2": 7, "bg-blue p-2": 8 });
    const [hot, setHot] = createSignal(false);

    const dispose = render(() => {
      const el = createElement("view");
      effect<string | undefined>((prev) =>
        setProp(el, "class", hot() ? "bg-blue p-2" : "bg-red p-2", prev),
      );
      return el;
    }, root);

    const el = root.children[0];
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, 7]]);
    host.clear();

    setHot(true);
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, 8]]);
    host.clear();

    setHot(false);
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, 7]]);

    dispose();
  });

  test("token-sorted alias: 'p-2 bg-red' resolves the 'bg-red p-2' style", () => {
    registerStyles({ "bg-red p-2": 7 });
    const el = createElement("view");
    setProp(el, "class", "p-2  bg-red", undefined); // extra spaces + reorder
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, 7]]);
  });

  test("order-sensitive alias collision is poisoned, not resolved arbitrarily", () => {
    // "m-1 px-4 p-2" and "p-2 px-4 m-1" share a token multiset but compile to
    // DIFFERENT records (dedupe is last-wins). A third ordering must MISS
    // (strict throw) rather than silently pick whichever registered later.
    registerStyles({ "m-1 px-4 p-2": 1, "p-2 px-4 m-1": 2 });
    expect(resolveStyle("m-1 px-4 p-2")).toBe(1); // verbatim always wins
    expect(resolveStyle("p-2 px-4 m-1")).toBe(2);
    expect(resolveStyle("px-4 m-1 p-2")).toBeUndefined();
    const el = createElement("view");
    expect(() => setProp(el, "class", "px-4 m-1 p-2", undefined)).toThrow(
      /unknown class/,
    );
    // Commutative anagrams (same record => same id) keep aliasing.
    registerStyles({ "bg-red p-2": 7, "p-2 bg-red": 7 });
    expect(resolveStyle("p-2 bg-red")).toBe(7);
  });

  test("unknown class throws on a strict host, counts on native hosts", () => {
    const el = createElement("view");
    expect(() => setProp(el, "class", "not-compiled", undefined)).toThrow(
      /unknown class/,
    );

    const native = makeMockHost(false);
    native.kind = "native";
    native.target = "psp";
    installHost(native);
    const before = missCounters.unknownClass;
    const el2 = createElement("view");
    setProp(el2, "class", "not-compiled", undefined); // silent
    expect(missCounters.unknownClass).toBe(before + 1);
    expect(native.of("setStyle")).toEqual([]);
  });

  test("null class clears back to the default style", () => {
    const el = createElement("view");
    setProp(el, "class", null, "bg-red p-2");
    expect(host.of("setStyle")).toEqual([["setStyle", el.id, STYLE_ID_NONE]]);
  });

  test("style object diffs per key and encodes per VALUE_KIND", () => {
    const el = createElement("view");
    setProp(el, "style", { width: 120, bgColor: "#ff0000" }, undefined);
    expect(host.of("setProp")).toEqual([
      ["setProp", el.id, PROP.width, 120],
      ["setProp", el.id, PROP.bgColor, 0xff0000ff], // ABGR: opaque red
    ]);
    host.clear();

    // prev-diff: only the changed key crosses the FFI
    setProp(
      el,
      "style",
      { width: 120, bgColor: "#00ff00" },
      { width: 120, bgColor: "#ff0000" },
    );
    expect(host.of("setProp")).toEqual([
      ["setProp", el.id, PROP.bgColor, 0xff00ff00],
    ]);
  });

  test("unknown style key throws", () => {
    const el = createElement("view");
    expect(() => setProp(el, "style", { widht: 1 }, undefined)).toThrow(
      /unknown style prop/,
    );
  });

  test("src looks up the texture registry", () => {
    registerTexture("logo.png", 77);
    const el = createElement("image");
    setProp(el, "src", "logo.png", undefined);
    expect(host.of("setImage")).toEqual([["setImage", el.id, 77]]);
    expect(() => setProp(el, "src", "nope.png", "logo.png")).toThrow(
      /unknown image src/,
    );
  });

  test("clearing src sends setImage(-1) — 0 is a real (first) texture handle", () => {
    registerTexture("logo.png", 0); // first upload => handle 0
    const el = createElement("image");
    setProp(el, "src", "logo.png", undefined);
    expect(host.of("setImage")).toEqual([["setImage", el.id, 0]]);
    host.clear();
    setProp(el, "src", "", "logo.png");
    expect(host.of("setImage")).toEqual([["setImage", el.id, -1]]);
    host.clear();
    setProp(el, "src", null, "");
    expect(host.of("setImage")).toEqual([["setImage", el.id, -1]]);
  });

  test("sprite frameStep overrides the manifest and can be updated at runtime", () => {
    registerSprite("spinner-atlas.svg", { handle: 41, frames: 8, cols: 4, step: 3 });
    const overridden = createElement("image");
    setProp(overridden, "frameStep", 6, undefined);
    setProp(overridden, "sprite", "spinner-atlas.svg", undefined);
    expect(host.of("setSprite")).toEqual([
      ["setSprite", overridden.id, 41, 8, 4, 6],
    ]);

    host.clear();
    setProp(overridden, "frameStep", 2.9, 6);
    expect(host.of("setSprite")).toEqual([
      ["setSprite", overridden.id, 41, 8, 4, 2],
    ]);

    host.clear();
    setProp(overridden, "frameStep", undefined, 2.9);
    expect(host.of("setSprite")).toEqual([
      ["setSprite", overridden.id, 41, 8, 4, 3],
    ]);

    host.clear();
    const fromManifest = createElement("image");
    setProp(fromManifest, "sprite", "spinner-atlas.svg", undefined);
    expect(host.of("setSprite")).toEqual([
      ["setSprite", fromManifest.id, 41, 8, 4, 3],
    ]);
  });

  test("classList / bool: / prop: / unknown props are loud errors", () => {
    const el = createElement("view");
    expect(() => setProp(el, "classList", { a: true }, undefined)).toThrow(
      /classList/,
    );
    expect(() => setProp(el, "bool:x", true, undefined)).toThrow(/bool:x/);
    expect(() => setProp(el, "prop:x", 1, undefined)).toThrow(/prop:x/);
    expect(() => setProp(el, "onClick", () => {}, undefined)).toThrow(
      /unknown property 'onClick'/,
    );
  });
});

describe("focus + onPress (input.ts)", () => {
  test("d-pad traversal in document order, CIRCLE fires focused handler", () => {
    setInputRoot(root);
    let pressedA = 0;
    let pressedB = 0;

    const dispose = render(() => {
      const list = createElement("view");
      const a = createElement("view");
      setProp(a, "focusable", true, undefined);
      setProp(a, "onPress", () => pressedA++, undefined);
      insertNode(list, a);
      const b = createElement("view");
      setProp(b, "focusable", true, undefined);
      setProp(b, "onPress", () => pressedB++, undefined);
      insertNode(list, b);
      return list;
    }, root);

    handleFrame(BTN.DOWN); // focus first
    const a = root.children[0].children[0];
    const b = root.children[0].children[1];
    expect(host.of("setFocus").at(-1)).toEqual(["setFocus", a.id]);

    handleFrame(0); // release
    handleFrame(BTN.DOWN); // next
    expect(host.of("setFocus").at(-1)).toEqual(["setFocus", b.id]);

    handleFrame(BTN.DOWN); // held: edge-detected, no repeat
    const focusCalls = host.of("setFocus").length;
    handleFrame(BTN.DOWN);
    expect(host.of("setFocus").length).toBe(focusCalls);

    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    expect(pressedB).toBe(1);
    expect(pressedA).toBe(0);

    handleFrame(0);
    handleFrame(BTN.UP); // back to a
    expect(getFocused()).toBe(a);
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    expect(pressedA).toBe(1);

    dispose();
  });

  test("CIRCLE hold applies active: on the focused node, release clears", () => {
    setInputRoot(root);
    const dispose = render(() => {
      const list = createElement("view");
      const a = createElement("view");
      setProp(a, "focusable", true, undefined);
      insertNode(list, a);
      const b = createElement("view");
      setProp(b, "focusable", true, undefined);
      insertNode(list, b);
      return list;
    }, root);

    const a = root.children[0].children[0];
    const b = root.children[0].children[1];

    handleFrame(BTN.DOWN); // focus a
    handleFrame(BTN.DOWN | BTN.CIRCLE); // press while holding DOWN's frame
    expect(host.of("setActive").at(-1)).toEqual(["setActive", a.id, 1]);

    handleFrame(BTN.CIRCLE); // still held: no repeat
    const activeCalls = host.of("setActive").length;
    handleFrame(BTN.CIRCLE);
    expect(host.of("setActive").length).toBe(activeCalls);

    handleFrame(0); // release
    expect(host.of("setActive").at(-1)).toEqual(["setActive", a.id, 0]);

    // d-pad move WHILE held: active follows off the old node (clears), the
    // newly focused node is not pressed (press is an edge, not a state).
    handleFrame(BTN.CIRCLE); // press on a again
    expect(host.of("setActive").at(-1)).toEqual(["setActive", a.id, 1]);
    handleFrame(BTN.CIRCLE | BTN.DOWN); // move to b with CIRCLE still down
    expect(getFocused()).toBe(b);
    expect(host.of("setActive").at(-1)).toEqual(["setActive", a.id, 0]);

    // CIRCLE with nothing focused: no active call.
    handleFrame(0);
    setInputRoot(root);
    const before = host.of("setActive").length;
    handleFrame(BTN.CIRCLE);
    expect(host.of("setActive").length).toBe(before);

    dispose();
  });

  test("focus repair on removal: next sibling, else prev, else ancestor [R]", () => {
    setInputRoot(root);
    const [items, setItems] = createSignal(["a", "b", "c"]);
    const byLabel = new Map<string, NodeMirror>();

    const dispose = render(
      () =>
        comp(For, {
          get each() {
            return items();
          },
          children: (item: string) => {
            const el = createElement("view");
            setProp(el, "focusable", true, undefined);
            byLabel.set(item, el);
            return el;
          },
        }),
      root,
    );

    handleFrame(BTN.DOWN);
    handleFrame(0);
    handleFrame(BTN.DOWN); // focus 'b'
    expect(getFocused()).toBe(byLabel.get("b")!);

    setItems(["a", "c"]); // remove focused 'b' → next sibling 'c'
    expect(getFocused()).toBe(byLabel.get("c")!);

    setItems(["a"]); // remove focused 'c' → no next → prev sibling 'a'
    expect(getFocused()).toBe(byLabel.get("a")!);

    setItems([]); // remove focused 'a' → nothing focusable left
    expect(getFocused()).toBe(null);
    expect(host.of("setFocus").at(-1)).toEqual(["setFocus", 0]);

    dispose();
  });

  test("focus scope traps traversal/press and restores previous focus", () => {
    setInputRoot(root);
    let backgroundPresses = 0;
    let modalPresses = 0;
    let background!: NodeMirror;
    let modalRoot!: NodeMirror;
    let modalItem!: NodeMirror;

    const dispose = render(() => {
      const page = createElement("view");
      background = createElement("view");
      setProp(background, "focusable", true, undefined);
      setProp(background, "onPress", () => backgroundPresses++, undefined);
      insertNode(page, background);

      modalRoot = createElement("view");
      modalItem = createElement("view");
      setProp(modalItem, "focusable", true, undefined);
      setProp(modalItem, "onPress", () => modalPresses++, undefined);
      insertNode(modalRoot, modalItem);
      insertNode(page, modalRoot);
      return page;
    }, root);

    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(background);

    const releaseScope = pushFocusScope(modalRoot);
    expect(getFocused()).toBe(modalItem);

    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    expect(modalPresses).toBe(1);
    expect(backgroundPresses).toBe(0);

    handleFrame(0);
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(modalItem);

    releaseScope();
    expect(getFocused()).toBe(background);
    handleFrame(0);
    handleFrame(BTN.CIRCLE);
    expect(backgroundPresses).toBe(1);

    dispose();
  });

  test("focus grid maps d-pad directions by row and column", () => {
    setInputRoot(root);
    const grid = createElement("view");
    const cells = ["a", "b", "c", "d", "e"].map(() => {
      const cell = createElement("view");
      setProp(cell, "focusable", true, undefined);
      insertNode(grid, cell);
      return cell;
    });
    insertNode(root, grid);
    const releaseGrid = pushFocusGrid(grid, { columns: 2 });

    focusNode(cells[0]);
    handleFrame(BTN.RIGHT);
    expect(getFocused()).toBe(cells[1]);
    handleFrame(0);
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(cells[3]);
    handleFrame(0);
    handleFrame(BTN.LEFT);
    expect(getFocused()).toBe(cells[2]);
    handleFrame(0);
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(cells[4]);
    handleFrame(0);
    handleFrame(BTN.RIGHT);
    expect(getFocused()).toBe(cells[4]);

    releaseGrid();
  });
});

describe("host detection (host.ts)", () => {
  test("reports completed app actions only when the host provides an acceptance sink", () => {
    const reports: Array<[string, number]> = [];
    host.ops.__reportAppAction = (name, value) => reports.push([name, value]);

    reportAppAction("hero_tap", 1);
    expect(reports).toEqual([["hero_tap", 1]]);

    delete host.ops.__reportAppAction;
    expect(() => reportAppAction("hero_tap", 2)).not.toThrow();
    expect(() => reportAppAction("Hero tap", 3)).toThrow(/app action names/);
    expect(() => reportAppAction("hero_tap", 0x80000000)).toThrow(
      /signed 32-bit/,
    );
  });

  test("resolved build contract rejects the wrong native target or ABI", () => {
    const ops = makeMockHost().ops;
    ops.__host = "vita";
    ops.__hostAbi = 1;

    expect(() =>
      assertNativeHostContract(ops, {
        target: "vita",
        hostAbi: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertNativeHostContract(ops, {
        target: "psp",
        hostAbi: 1,
      }),
    ).toThrow(/target mismatch/);
    expect(() =>
      assertNativeHostContract(ops, {
        target: "vita",
        hostAbi: 2,
      }),
    ).toThrow(/ABI mismatch/);
  });

  test("tick-rate pairing: bundle-baked hz must match the host's declared rate", () => {
    const ops = makeMockHost().ops;

    // A 60-baked bundle accepts hosts that predate __tickHz (they only ever
    // ran 60) and hosts that declare 60 — with or without a plan contract.
    expect(() => assertNativeHostContract(ops, null)).not.toThrow();
    ops.__tickHz = 60;
    expect(() => assertNativeHostContract(ops, null)).not.toThrow();

    // A host driving another rate is refused even when the plan matches.
    ops.__host = "vita";
    ops.__hostAbi = 1;
    ops.__tickHz = 120;
    expect(() =>
      assertNativeHostContract(ops, { target: "vita", hostAbi: 1 }),
    ).toThrow(/tick-rate mismatch/);

    // A non-60 bundle (the define is read at call time — see host.ts) needs
    // the host to declare that exact rate; silence means the 60 default.
    const globals = globalThis as { __POCKET_TICK_HZ__?: number };
    try {
      globals.__POCKET_TICK_HZ__ = 120;
      expect(() => assertNativeHostContract(ops, null)).not.toThrow();
      delete ops.__tickHz;
      expect(() => assertNativeHostContract(ops, null)).toThrow(
        /declares no ui\.__tickHz/,
      );
      ops.__tickHz = 60;
      expect(() => assertNativeHostContract(ops, null)).toThrow(
        /tick-rate mismatch/,
      );
    } finally {
      delete globals.__POCKET_TICK_HZ__;
    }
  });

  test("native namespace passed explicitly stays native / non-strict", () => {
    // Demo entries pass globalThis.ui to render(); object identity must keep
    // the namespace native instead of turning it into an
    // injected/strict host (crash-on-miss on hardware + double asset feed).
    const psp = makeMockHost();
    psp.ops.__host = "psp";
    (psp.ops as HostOps & { __textures?: Record<string, number> }).__textures =
      {
        "logo.png": 0,
      };
    const g = globalThis as { ui?: HostOps };
    g.ui = psp.ops;
    try {
      const detected = detectHost(psp.ops);
      expect(detected.kind).toBe("native");
      expect(detected.target).toBe("psp");
      expect(detected.strict).toBe(false);
      // render() then takes the PSP branch: native handles bound, NO
      // loadStyles/loadFontAtlas re-feed through the FFI.
      const dispose = publicRender(() => createElement("view"), {
        ops: psp.ops,
        styles: { "p-2": 0 },
      });
      expect(psp.of("loadStyles", "loadFontAtlas", "uploadTexture")).toEqual(
        [],
      );
      dispose();
    } finally {
      delete g.ui;
    }
  });

  test("target-marked native host without resource tables uses portable pak feed", () => {
    const symbian = makeMockHost();
    symbian.ops.__host = "symbian-e7-dev";
    symbian.ops.__hostAbi = 4;
    const g = globalThis as { ui?: HostOps; __pak?: ArrayBuffer };
    const pak = pack([
      {
        key: "ui:styles",
        dtype: PAK_DTYPE.u8,
        data: new Uint8Array([1, 2, 3]),
      },
      {
        key: "ui:font.0",
        dtype: PAK_DTYPE.u8,
        data: new Uint8Array([4, 5, 6]),
      },
    ]);
    g.ui = symbian.ops;
    g.__pak = pak.buffer.slice(
      pak.byteOffset,
      pak.byteOffset + pak.byteLength,
    ) as ArrayBuffer;
    try {
      const dispose = publicRender(() => createElement("view"), {
        ops: symbian.ops,
        styles: {},
      });
      expect(detectHost(symbian.ops).kind).toBe("native");
      expect(
        symbian.of("loadStyles", "loadFontAtlas").map(([name]) => name),
      ).toEqual(["loadFontAtlas", "loadStyles"]);
      dispose();
    } finally {
      delete g.ui;
      delete g.__pak;
    }
  });

  test("a real injected host stays strict even when globalThis.ui exists", () => {
    const psp = makeMockHost();
    (psp.ops as HostOps & { __textures?: unknown }).__textures = {};
    const g = globalThis as { ui?: HostOps };
    g.ui = psp.ops;
    try {
      const injected = makeMockHost();
      const detected = detectHost(injected.ops); // different ops object
      expect(detected.kind).toBe("injected");
      expect(detected.strict).toBe(true);
    } finally {
      delete g.ui;
    }
  });

  test("a global web/wasm namespace without native identity stays injected", () => {
    const wasm = makeMockHost();
    const g = globalThis as { ui?: HostOps };
    g.ui = wasm.ops;
    try {
      const detected = detectHost(wasm.ops);
      expect(detected.kind).toBe("injected");
      expect(detected.target).toBe("injected");
      expect(detected.strict).toBe(true);
    } finally {
      delete g.ui;
    }
  });

  test("injected ops stay strict (web/wasm/test hosts)", () => {
    const injected = makeMockHost();
    const detected = detectHost(injected.ops);
    expect(detected.kind).toBe("injected");
    expect(detected.strict).toBe(true);
  });
});

describe("parseHexColor (host.ts)", () => {
  test("valid forms produce ABGR", () => {
    expect(parseHexColor("#ff0000")).toBe(0xff0000ff);
    expect(parseHexColor("#f00")).toBe(0xff0000ff);
    expect(parseHexColor("#00ff0080")).toBe(0x8000ff00);
  });
  test("garbage hex throws instead of parsing a prefix", () => {
    expect(() => parseHexColor("#ff00zz")).toThrow(/bad color/); // pre-fix: 0xff00 prefix
    expect(() => parseHexColor("#1x2y3z")).toThrow(/bad color/);
    expect(() => parseHexColor("#0x1234")).toThrow(/bad color/);
    expect(() => parseHexColor("#12345")).toThrow(/bad color/);
  });
});

describe("public render() (index.ts)", () => {
  test("mounts into the shared root, installs frame(), dispose destroys", () => {
    // index.render always uses the renderer's shared rootMirror (native id 1)
    const dispose = publicRender(
      () => {
        const el = createElement("view");
        insertNode(el, createTextNode("bye"));
        return el;
      },
      { ops: host.ops, styles: { "p-2": 0 } },
    );

    expect(rootMirror.children.length).toBe(2);
    const appLayer = rootMirror.children[0];
    const overlayLayer = rootMirror.children[1];
    const el = appLayer.children[0];
    expect(overlayLayer.children.length).toBe(0);
    expect(typeof (globalThis as { frame?: unknown }).frame).toBe("function");
    host.clear();

    dispose();
    expect(rootMirror.children.length).toBe(0);
    // layer roots are destroyed once each (native destroy recurses).
    expect(host.of("destroyNode").map((c) => c[1])).toEqual([
      appLayer.id,
      overlayLayer.id,
    ]);
  });

  test("native resize hook reflows a live tree without remounting or losing state", () => {
    const ops = host.ops as HostOps & { __viewport?: { w: number; h: number } };
    const globals = globalThis as typeof globalThis & {
      __pocketResizeViewport?: (width: number, height: number) => void;
    };
    ops.__viewport = { w: 640, h: 360 };
    const [count, setCount] = createSignal(7);

    const dispose = publicRender(
      () => {
        const content = createElement("view");
        const label = createElement("text");
        insert(label, () => `count:${count()}`);
        insertNode(content, label);
        return content;
      },
      { ops },
    );
    const [appLayer, overlayLayer] = rootMirror.children;
    const content = appLayer.children[0];
    const label = content.children[0];
    const dynamicText = label.children[0];
    expect(typeof globals.__pocketResizeViewport).toBe("function");
    expect(dynamicText.text).toBe("count:7");
    host.clear();

    globals.__pocketResizeViewport?.(360, 640);

    expect(ops.__viewport).toEqual({ w: 360, h: 640 });
    expect(appLayer.children[0]).toBe(content);
    expect(content.children[0]).toBe(label);
    expect(label.children[0]).toBe(dynamicText);
    expect(dynamicText.text).toBe("count:7");
    expect(host.of("setProp")).toEqual(
      expect.arrayContaining([
        ["setProp", appLayer.id, PROP.width, 360],
        ["setProp", appLayer.id, PROP.height, 640],
        ["setProp", overlayLayer.id, PROP.width, 360],
        ["setProp", overlayLayer.id, PROP.height, 640],
      ]),
    );
    expect(
      host.of("createNode", "destroyNode", "insertBefore", "removeChild"),
    ).toEqual([]);

    host.clear();
    setCount(8);
    expect(label.children[0]).toBe(dynamicText);
    expect(dynamicText.text).toBe("count:8");
    expect(host.of("replaceText")).toEqual([
      ["replaceText", dynamicText.id, "count:8"],
    ]);
    expect(
      host.of("createNode", "destroyNode", "insertBefore", "removeChild"),
    ).toEqual([]);

    dispose();
    expect(globals.__pocketResizeViewport).toBeUndefined();
  });

  test("DeepZoom follows the live viewport while preserving a non-fit view", () => {
    const ops = host.ops as HostOps & { __viewport?: { w: number; h: number } };
    const frame = () =>
      (globalThis as { frame?: (buttons: number) => void }).frame?.(0);
    const doc: TileDoc = {
      name: "live viewport",
      w: 1000,
      h: 500,
      bg: 0xff202020,
      tile: 100,
      levels: [
        {
          scale: 1,
          cols: 10,
          rows: 5,
          key: "ui:tile.live-viewport",
          grid: Array<string>(5).fill("aaaaaaaaaa"),
          solids: [0xff808080],
        },
      ],
    };
    const views: DeepZoomView[] = [];
    let gesture: DeepZoomGesture | null = null;
    ops.__viewport = { w: 640, h: 360 };

    const dispose = publicRender(
      () =>
        DeepZoom({
          doc,
          prefetch: 0,
          gestureSource: () => gesture,
          onView: (view) => views.push({ ...view }),
        }) as unknown as NodeMirror,
      { ops },
    );
    const container = rootMirror.children[0].children[0];
    const activeWorld = container.children[1];

    frame();
    expect(views.at(-1)?.minZoom).toBeCloseTo(0.64);
    expect(views.at(-1)?.zoom).toBeCloseTo(0.64);
    expect(activeWorld.children).toHaveLength(50);

    host.clear();
    ops.__viewport = { w: 360, h: 640 };
    frame();
    expect(views.at(-1)?.minZoom).toBeCloseTo(0.36);
    expect(views.at(-1)?.zoom).toBeCloseTo(0.36);
    expect(host.of("setProp")).toEqual(
      expect.arrayContaining([
        ["setProp", container.id, PROP.width, 360],
        ["setProp", container.id, PROP.height, 640],
      ]),
    );
    expect(rootMirror.children[0].children[0]).toBe(container);
    expect(container.children[1]).toBe(activeWorld);

    gesture = { panX: -36, panY: 0, zoomFactor: 2 };
    frame();
    gesture = null;
    expect(views.at(-1)?.zoom).toBeCloseTo(0.72);
    expect(views.at(-1)?.centerX).toBeCloseTo(600);
    expect(activeWorld.children).toHaveLength(30);

    host.clear();
    ops.__viewport = { w: 640, h: 360 };
    frame();
    expect(views.at(-1)?.minZoom).toBeCloseTo(0.64);
    expect(views.at(-1)?.zoom).toBeCloseTo(0.72);
    expect(views.at(-1)?.centerX).toBeCloseTo(1000 - 320 / 0.72);
    expect(views.at(-1)?.centerX).not.toBeCloseTo(doc.w / 2);
    expect(activeWorld.children).toHaveLength(45);
    expect(rootMirror.children[0].children[0]).toBe(container);
    expect(container.children[1]).toBe(activeWorld);

    dispose();
  });

  test("DeepZoom keeps an explicit viewport fixed", () => {
    const ops = host.ops as HostOps & { __viewport?: { w: number; h: number } };
    const views: DeepZoomView[] = [];
    const doc: TileDoc = {
      name: "fixed viewport",
      w: 1000,
      h: 500,
      bg: 0xff202020,
      tile: 100,
      levels: [
        {
          scale: 1,
          cols: 10,
          rows: 5,
          key: "ui:tile.fixed-viewport",
          grid: Array<string>(5).fill("aaaaaaaaaa"),
          solids: [0xff808080],
        },
      ],
    };
    ops.__viewport = { w: 640, h: 360 };

    const dispose = publicRender(
      () =>
        DeepZoom({
          doc,
          width: 480,
          height: 272,
          prefetch: 0,
          onView: (view) => views.push({ ...view }),
        }) as unknown as NodeMirror,
      { ops },
    );
    const container = rootMirror.children[0].children[0];
    const frame = () =>
      (globalThis as { frame?: (buttons: number) => void }).frame?.(0);
    frame();
    expect(views.at(-1)?.minZoom).toBeCloseTo(0.48);
    expect(views.at(-1)?.zoom).toBeCloseTo(0.48);

    host.clear();
    ops.__viewport = { w: 360, h: 640 };
    frame();
    expect(views.at(-1)?.minZoom).toBeCloseTo(0.48);
    expect(views.at(-1)?.zoom).toBeCloseTo(0.48);
    expect(
      host
        .of("setProp")
        .filter(
          (call) =>
            call[1] === container.id &&
            (call[2] === PROP.width || call[2] === PROP.height),
        ),
    ).toEqual([]);

    dispose();
  });

  test("Portal mounts overlay content outside the app layer", () => {
    const dispose = publicRender(
      () =>
        View({
          children: [
            Text({ children: "app" }),
            Portal({ children: () => Text({ children: "overlay" }) }),
          ],
        }),
      { ops: host.ops },
    );

    const [appLayer, overlayLayer] = rootMirror.children;
    expect(appLayer.children.length).toBe(1);
    expect(overlayLayer.children.length).toBe(1);
    expect(appLayer.children[0].children.length).toBe(1);
    expect(overlayLayer.children[0].children.length).toBe(1);

    dispose();
  });

  test("AuxiliarySurface mounts under a host-owned independent root", () => {
    host.ops.__auxiliarySurface = { root: 99, w: 320, h: 240 };
    host.alive.add(99);
    const dispose = publicRender(
      () =>
        View({
          children: [
            Text({ children: "primary" }),
            AuxiliarySurface({ children: () => Text({ children: "auxiliary" }) }),
          ],
        }),
      { ops: host.ops },
    );

    const surface = getAuxiliarySurfaceRoots();
    expect(surface.native.id).toBe(99);
    expect(surface.native.parent).toBeNull();
    expect(surface.viewport).toEqual({ width: 320, height: 240 });
    expect(surface.app.children).toHaveLength(1);
    expect(surface.app.children[0].children).toHaveLength(1);
    expect(rootMirror.children).toHaveLength(2);

    host.clear();
    dispose();
    expect(host.of("destroyNode").some((call) => call[1] === 99)).toBe(false);
  });

  test("AuxiliaryPortal mounts above the independent auxiliary app layer", () => {
    host.ops.__auxiliarySurface = { root: 99, w: 320, h: 240 };
    host.alive.add(99);
    const dispose = publicRender(
      () =>
        View({
          children: [
            AuxiliarySurface({ children: () => Text({ children: "app" }) }),
            AuxiliaryPortal({ children: () => Text({ children: "overlay" }) }),
          ],
        }),
      { ops: host.ops },
    );

    const surface = getAuxiliarySurfaceRoots();
    expect(surface.app.children[0].children[0].children[0].text).toBe("app");
    expect(surface.overlay.children[0].children[0].children[0].text).toBe("overlay");
    dispose();
  });

  test("ActionBar uses the overlay layer instead of app layout", () => {
    const dispose = publicRender(
      () =>
        View({
          children: [
            View({ class: "w-full h-full" }),
            ActionBar({ children: Text({ children: "SELECT" }) }),
          ],
        }),
      {
        ops: host.ops,
        styles: {
          "w-full h-full": 1,
          "absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200": 2,
        },
      },
    );

    const [appLayer, overlayLayer] = rootMirror.children;
    expect(appLayer.children[0].children.length).toBe(1);
    expect(overlayLayer.children.length).toBe(1);

    dispose();
  });

  test("Modal stays mounted while open state toggles overlay props without animation", () => {
    const [open, setOpen] = createSignal(true);
    const dispose = publicRender(
      () =>
        View({
          children: Modal({
            open,
            class: "modal-frame",
            panelClass: "modal-panel",
            children: Text({ children: "dialog" }),
          }),
        }),
      {
        ops: host.ops,
        styles: {
          "modal-frame": 1,
          "modal-panel": 2,
          "absolute inset-0 bg-slate-950": 3,
        },
      },
    );

    const overlayLayer = rootMirror.children[1];
    expect(overlayLayer.children.length).toBe(1);
    const portalHost = overlayLayer.children[0];
    const modalFrame = portalHost.children[0];
    const [backdrop, panel] = modalFrame.children;
    host.clear();

    setOpen(false);
    expect(overlayLayer.children).toEqual([portalHost]);
    expect(portalHost.children).toEqual([modalFrame]);
    expect(modalFrame.children).toEqual([backdrop, panel]);
    expect(host.of("removeChild")).toEqual([]);
    expect(host.of("destroyNode")).toEqual([]);
    expect(host.of("animate")).toEqual([]);
    expect(
      host.of("setProp").map((call) => [call[1], call[2], call[3]]),
    ).toEqual(
      expect.arrayContaining([
        [backdrop.id, PROP.opacity, 0],
        [panel.id, PROP.opacity, 0],
        [panel.id, PROP.translateY, 0],
        [panel.id, PROP.scale, 1],
      ]),
    );

    host.clear();
    setOpen(true);
    expect(overlayLayer.children).toEqual([portalHost]);
    expect(host.of("removeChild")).toEqual([]);
    expect(host.of("destroyNode")).toEqual([]);
    expect(host.of("animate")).toEqual([]);
    expect(
      host.of("setProp").map((call) => [call[1], call[2], call[3]]),
    ).toEqual(
      expect.arrayContaining([
        [backdrop.id, PROP.opacity, 0.62],
        [panel.id, PROP.opacity, 1],
        [panel.id, PROP.translateY, 0],
        [panel.id, PROP.scale, 1],
      ]),
    );

    dispose();
  });

  test("closed modal content is excluded from default app focus traversal", () => {
    let background!: NodeMirror;
    let hiddenModalItem!: NodeMirror;

    const dispose = publicRender(
      () =>
        View({
          children: [
            View({ ref: (node) => (background = node), focusable: true }),
            Modal({
              open: false,
              class: "modal-frame",
              panelClass: "modal-panel",
              children: View({
                ref: (node) => (hiddenModalItem = node),
                focusable: true,
              }),
            }),
          ],
        }),
      {
        ops: host.ops,
        styles: {
          "modal-frame": 1,
          "modal-panel": 2,
          "absolute inset-0 bg-slate-950": 3,
        },
      },
    );

    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(background);
    handleFrame(0);
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(background);
    expect(getFocused()).not.toBe(hiddenModalItem);

    dispose();
  });

  test("FocusGrid component registers row and column traversal", () => {
    let first!: NodeMirror;
    let second!: NodeMirror;
    let third!: NodeMirror;

    const dispose = publicRender(
      () =>
        FocusGrid({
          columns: 2,
          children: [
            View({ ref: (node) => (first = node), focusable: true }),
            View({ ref: (node) => (second = node), focusable: true }),
            View({ ref: (node) => (third = node), focusable: true }),
          ],
        }),
      { ops: host.ops },
    );

    focusNode(first);
    handleFrame(BTN.RIGHT);
    expect(getFocused()).toBe(second);
    handleFrame(0);
    handleFrame(BTN.LEFT);
    expect(getFocused()).toBe(first);
    handleFrame(0);
    handleFrame(BTN.DOWN);
    expect(getFocused()).toBe(third);

    dispose();
  });

  test("mount() hides host, pak image, and frame boilerplate", () => {
    const g = globalThis as {
      ui?: HostOps;
      __pak?: ArrayBuffer;
      frame?: (buttons: number) => void;
    };
    g.ui = host.ops;
    const image = encodeImageEntry(
      { width: 1, height: 1, rgba: new Uint8Array([10, 20, 30, 255]) },
      PSM.PSM_8888,
    );
    const pak = pack([
      { key: "ui:img.logo.png", dtype: PAK_DTYPE.u8, data: image },
    ]);
    g.__pak = pak.buffer.slice(
      pak.byteOffset,
      pak.byteOffset + pak.byteLength,
    ) as ArrayBuffer;

    const before: number[] = [];
    const dispose = publicMount(() => {
      onFrame((buttons) => before.push(buttons));
      const img = createElement("image");
      setProp(img, "src", "logo.png", undefined);
      return img;
    });

    expect(host.of("uploadTexture")).toEqual([["uploadTexture"]]);
    expect(host.of("setImage").length).toBe(1);
    expect(typeof g.frame).toBe("function");
    g.frame?.(BTN.CIRCLE);
    expect(before).toEqual([BTN.CIRCLE]);

    dispose();
  });

  test("mount() preserves IMG flags through uploadImgEntry when the host supports it", () => {
    const g = globalThis as { ui?: HostOps; __pak?: ArrayBuffer };
    g.ui = host.ops;
    host.ops.uploadImgEntry = (blob) => {
      host.calls.push(["uploadImgEntry", blob[5], blob.length]);
      return 901;
    };
    const image = encodeImageEntry(
      { width: 1, height: 1, rgba: new Uint8Array([10, 20, 30, 255]) },
      PSM.PSM_8888,
      IMG_FLAG_LINEAR,
    );
    const pak = pack([
      { key: "ui:img.logo.png", dtype: PAK_DTYPE.u8, data: image },
    ]);
    g.__pak = pak.buffer.slice(
      pak.byteOffset,
      pak.byteOffset + pak.byteLength,
    ) as ArrayBuffer;

    const dispose = publicMount(() => createElement("view"));

    expect(host.of("uploadImgEntry")).toEqual([
      ["uploadImgEntry", IMG_FLAG_LINEAR, image.length],
    ]);
    expect(host.of("uploadTexture")).toEqual([]);

    dispose();
  });

  test("button handler blocks suppress background actions but not frame ticks", () => {
    const g = globalThis as { ui?: HostOps; frame?: (buttons: number) => void };
    g.ui = host.ops;
    let frames = 0;
    let backgroundPresses = 0;
    let systemPresses = 0;

    const dispose = publicMount(() => {
      onFrame(() => frames++);
      onButtonPress(BTN.SELECT, () => backgroundPresses++);
      onButtonPress(BTN.SELECT, () => systemPresses++, {
        allowWhenBlocked: true,
      });
      return createElement("view");
    });
    const unblock = pushButtonHandlerBlock();

    g.frame?.(BTN.SELECT);
    expect(frames).toBe(1);
    expect(backgroundPresses).toBe(0);
    expect(systemPresses).toBe(1);

    g.frame?.(0);
    unblock();
    g.frame?.(BTN.SELECT);
    expect(frames).toBe(3);
    expect(backgroundPresses).toBe(1);
    expect(systemPresses).toBe(2);

    dispose();
  });

  test("ActionHandler active=false tracks held buttons without firing later", () => {
    const g = globalThis as { ui?: HostOps; frame?: (buttons: number) => void };
    const [enabled, setEnabled] = createSignal(false);
    g.ui = host.ops;
    let presses = 0;

    const dispose = publicMount(() =>
      View({
        children: ActionHandler({
          button: BTN.SELECT,
          active: enabled,
          onPress: () => presses++,
        }),
      }),
    );

    g.frame?.(BTN.SELECT);
    expect(presses).toBe(0);

    setEnabled(true);
    g.frame?.(BTN.SELECT);
    expect(presses).toBe(0);

    g.frame?.(0);
    g.frame?.(BTN.SELECT);
    expect(presses).toBe(1);

    dispose();
  });

  test("ActionHandler forwards latched so a held opener must release before firing", () => {
    const g = globalThis as { ui?: HostOps; frame?: (buttons: number) => void };
    g.ui = host.ops;
    let presses = 0;

    const dispose = publicMount(() =>
      View({
        children: ActionHandler({
          button: BTN.SELECT,
          latched: true,
          onPress: () => presses++,
        }),
      }),
    );

    g.frame?.(BTN.SELECT);
    expect(presses).toBe(0);
    g.frame?.(0);
    g.frame?.(BTN.SELECT);
    expect(presses).toBe(1);

    dispose();
  });
});

test("Text resource swaps one complete value and unsubscribes from superseded batches", () => {
  function resource() {
    let state: ResourceState<{ text: string; slot: number }> = pending();
    const listeners = new Set<() => void>();
    return { state: () => state, listeners, dispose() {},
      subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
      publish(next: typeof state) { state = next; for (const fn of listeners) fn(); },
    };
  }
  const first = resource(), second = resource(), [selected, setSelected] = createSignal(first);
  const dispose = render(() => Text({ get resource() { return selected(); },
    children: "must not leak unprepared children", style: { fontSlot: 0 },
    fallback: () => Text({ children: "Loading" }), errorFallback: () => Text({ children: "Error" }),
  }) as unknown as NodeMirror, root);
  expect(host.of("setText").some(c => c[2] === "Loading")).toBe(true);
  expect(host.of("setText").some(c => String(c[2]).includes("unprepared"))).toBe(false);
  first.publish(ready({ text: "你好𠮷野", slot: 2 })); runSweep();
  expect(host.of("setText").some(c => c[2] === "你好𠮷野")).toBe(true);
  expect(host.of("setProp").some(c => c[2] === PROP.fontSlot && c[3] === 2)).toBe(true);
  setSelected(second); runSweep(); host.clear();
  expect(first.listeners.size).toBe(0);
  first.publish(ready({ text: "stale", slot: 2 }));
  expect(host.of("setText")).toHaveLength(0);
  second.publish(ready({ text: "new", slot: 4 }));
  expect(host.of("setText").some(c => c[2] === "new")).toBe(true);
  second.publish(failed("offline")); runSweep();
  expect(host.of("setText").some(c => c[2] === "Error")).toBe(true);
  dispose(); expect(second.listeners.size).toBe(0);
});
