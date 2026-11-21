// VirtualList renderer-level tests: mount through the public render() with a
// mock HostOps (the devtools.test.ts pattern) and drive the real frame pump —
// windowing math, reference stability, d-pad focus-follow, touch tap/pan
// through the gesture layer, rebase, and the data-flow invariants.
//
// Run: bun test --conditions=browser tests/virtual-list.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) {
  throw new Error("solid-js resolved to its SSR build — run: bun test --conditions=browser");
}

import { createEffect, createSignal } from "solid-js";
import { installHost, type Host, type HostOps } from "../framework/src/host.ts";
import { render as publicRender } from "../framework/src/index.ts";
import { resetRendererState, rootMirror, type NodeMirror } from "../framework/src/renderer.ts";
import { resetStyles } from "../framework/src/styles.ts";
import { resetInput, getFocused } from "../framework/src/input.ts";
import { resetPack } from "../framework/src/pak.ts";
import { AuxiliarySurface, View } from "../framework/src/components.ts";
import { getAuxiliarySurfaceRoots, type SurfaceId } from "../framework/src/display.ts";
import { Text } from "../framework/src/primitives.ts";
import { VirtualList, type VirtualListHandle } from "../framework/src/virtual-list.ts";
import { __packTouch } from "../framework/src/touch.ts";
import { BTN, ROOT_ID } from "../contracts/spec/spec.ts";

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
    setActive: noop,
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

/** rootMirror -> appRoot -> viewport -> canvas */
function canvasNode(): NodeMirror {
  return rootMirror.children[0].children[0].children[0];
}

function viewportNode(): NodeMirror {
  return rootMirror.children[0].children[0];
}

/** auxiliary native root -> app layer -> portal host -> viewport -> canvas */
function auxiliaryCanvasNode(): NodeMirror {
  return getAuxiliarySurfaceRoots().app.children[0].children[0].children[0];
}

function auxiliaryViewportNode(): NodeMirror {
  return getAuxiliarySurfaceRoots().app.children[0].children[0];
}

/** The hit FACT for a contact inside the viewport (frame() arg 4): tests are
 *  hosts too, and this host resolves hits by construction. */
function vpHit(): number[] {
  return [viewportNode().id];
}

interface MountOpts {
  count?: () => number;
  onRowPress?: (i: number) => void;
  focusRows?: boolean;
  stickToBottom?: boolean;
  onNearEnd?: () => void;
  surface?: SurfaceId;
}

function mountList(opts: MountOpts = {}): VirtualListHandle {
  let handle: VirtualListHandle | undefined;
  const list = () =>
    VirtualList({
      get count() {
        return opts.count ? opts.count() : 100;
      },
      rowHeight: 10,
      height: 50,
      overscan: 20,
      focusRows: opts.focusRows,
      onRowPress: opts.onRowPress,
      stickToBottom: opts.stickToBottom,
      onNearEnd: opts.onNearEnd,
      surface: opts.surface,
      renderRow: (i) => Text({ children: `ROW ${i}` }),
      ref: (h) => {
        handle = h;
      },
    });
  dispose = publicRender(
    () =>
      opts.surface === "auxiliary"
        ? (View({ children: AuxiliarySurface({ children: list }) }) as unknown as NodeMirror)
        : list(),
    { ops: host.ops, styles: {} },
  );
  if (!handle) throw new Error("VirtualList ref not called");
  return handle;
}

describe("windowing", () => {
  test("mounts only the visible slice ± overscan", () => {
    mountList();
    // offset 0: first = 0, last = floor((0+50+20-1)/10) = 6 → 7 rows of 100.
    expect(canvasNode().children.length).toBe(7);
  });

  test("scrolling re-windows in O(window) rows at absolute offsets", () => {
    const h = mountList();
    h.scroller.scrollTo(500, { immediate: true });
    // first = floor(480/10) = 48, last = floor(569/10) = 56 → 9 rows.
    const kids = canvasNode().children;
    expect(kids.length).toBe(9);
  });

  test("sub-row scrolls keep the same window (reference-stable <For> input)", () => {
    const h = mountList();
    h.scroller.scrollTo(500, { immediate: true });
    const before = canvasNode().children.slice();
    h.scroller.scrollTo(500.5, { immediate: true });
    const after = canvasNode().children;
    expect(after.length).toBe(before.length);
    for (let i = 0; i < after.length; i++) expect(after[i]).toBe(before[i]);
  });

  test("a shrinking count clamps the window", () => {
    const [count, setCount] = createSignal(100);
    mountList({ count });
    setCount(3);
    expect(canvasNode().children.length).toBe(3);
  });
});

describe("d-pad focus", () => {
  test("DOWN enters the list, then the controller walks rows with keep-in-view", () => {
    const h = mountList();
    frame(BTN.DOWN); // linear traversal focuses the first row
    frame(0);
    expect(getFocused()).toBe(canvasNode().children[0]);
    // Walk down 6 rows: row 6's bottom (70) exceeds the viewport (50) → the
    // scroller chases; run frames for the chase to settle.
    for (let i = 0; i < 6; i++) {
      frame(BTN.DOWN);
      frame(0);
    }
    expect(h.focusedIndex()).toBe(6);
    for (let i = 0; i < 40; i++) frame(0);
    expect(h.scroller.offset()).toBe(20); // row 6 bottom-aligned: 70 - 50
  });

  test("CIRCLE presses the focused row through onRowPress", () => {
    const pressed: number[] = [];
    mountList({ onRowPress: (i) => pressed.push(i) });
    frame(BTN.DOWN);
    frame(0);
    frame(BTN.CIRCLE);
    expect(pressed).toEqual([0]);
  });

  test("focus keeps its index when the target row mounts after the chase", () => {
    const h = mountList();
    frame(BTN.DOWN);
    frame(0);
    h.scrollToIndex(50, "start", false); // jump far: focused row 0 unmounts
    frame(0);
    frame(BTN.DOWN); // controller resumes from its own index
    for (let i = 0; i < 30; i++) frame(0);
    expect(h.focusedIndex()).not.toBeNull();
  });
});

describe("touch", () => {
  test("tap on a row fires the shared onPress path (hit fact names the row)", () => {
    const pressed: number[] = [];
    const h = mountList({ onRowPress: (i) => pressed.push(i) });
    h.scroller.scrollTo(100, { immediate: true });
    // y 25 in-view → content y 125 → row 12; window first = 8 → child 4.
    const row12 = canvasNode().children[4];
    frame(0, [__packTouch(1, 100, 25)], [row12.id]);
    frame(0); // release
    expect(pressed).toEqual([12]);
    expect(h.focusedIndex()).toBe(12);
  });

  test("pan claims the contact, follows the finger, and flings on release", () => {
    const pressed: number[] = [];
    const h = mountList({ onRowPress: (i) => pressed.push(i) });
    // Drag upward 12 px/frame (content scrolls down), then release. The host
    // fact resolves to the viewport box — a bounds hit ANYWHERE in the list.
    frame(0, [__packTouch(1, 100, 45)], vpHit());
    frame(0, [__packTouch(1, 100, 33)], vpHit());
    frame(0, [__packTouch(1, 100, 21)], vpHit());
    frame(0, [__packTouch(1, 100, 9)], vpHit());
    const atRelease = h.scroller.offset();
    expect(atRelease).toBeGreaterThan(20); // finger-follow moved the content
    frame(0); // release → fling
    expect(pressed).toEqual([]); // never a tap
    let last = h.scroller.offset();
    let grew = false;
    for (let i = 0; i < 30; i++) {
      frame(0);
      if (h.scroller.offset() > last) grew = true;
      last = h.scroller.offset();
    }
    expect(grew).toBe(true); // inertia continued after release
  });

  test("a down arrests an in-flight fling", () => {
    const h = mountList();
    frame(0, [__packTouch(1, 100, 45)], vpHit());
    frame(0, [__packTouch(1, 100, 25)], vpHit());
    frame(0, [__packTouch(1, 100, 5)], vpHit());
    frame(0); // release → fling
    frame(0);
    expect(h.scroller.state()).toBe("fling");
    frame(0, [__packTouch(2, 100, 25)], vpHit()); // catch
    expect(h.scroller.state()).not.toBe("fling");
  });

  test("auxiliary surface drag scrolls its own virtual window", () => {
    host.ops.__auxiliarySurface = { root: 90, w: 320, h: 240 };
    const h = mountList({ surface: "auxiliary", focusRows: false });
    const viewport = auxiliaryViewportNode();

    frame(0, [__packTouch(1, 100, 45)], [viewport.id], [1]);
    frame(0, [__packTouch(1, 100, 25)], [viewport.id], [1]);
    frame(0, [__packTouch(1, 100, 5)], [viewport.id], [1]);
    expect(h.scroller.offset()).toBeGreaterThan(20);
    expect(auxiliaryCanvasNode().children.length).toBeLessThan(20);

    frame(0); // auxiliary contact release -> fling
    expect(h.scroller.state()).toBe("fling");
  });

  test("no fact channel: the gesture layer queries ops.hitTestBounds instead", () => {
    // The injected host GAINS the bounds op (a stale-host shim would lack
    // both — and then the region simply never matches, PSP-style inertness).
    host.ops.hitTestBounds = () => viewportNode().id;
    const h = mountList();
    frame(0, [__packTouch(1, 100, 45)]);
    frame(0, [__packTouch(1, 100, 25)]);
    frame(0, [__packTouch(1, 100, 5)]);
    frame(0);
    frame(0);
    expect(h.scroller.state()).toBe("fling");
  });
});

describe("data-flow invariants", () => {
  test("rebaseRows shifts the offset by exactly the added height", () => {
    const h = mountList();
    h.scroller.scrollTo(100, { immediate: true });
    h.rebaseRows(5);
    expect(h.scroller.offset()).toBe(150);
  });

  test("stickToBottom follows appends only while the intent is at the end", () => {
    const [count, setCount] = createSignal(10); // total 100, max = 50
    const h = mountList({ count, stickToBottom: true });
    h.scroller.scrollTo(50, { immediate: true }); // at the end
    setCount(12); // max becomes 70
    for (let i = 0; i < 40; i++) frame(0);
    expect(h.scroller.offset()).toBe(70); // followed
    h.scroller.scrollTo(0, { immediate: true }); // reading history
    setCount(14);
    for (let i = 0; i < 10; i++) frame(0);
    expect(h.scroller.offset()).toBe(0); // did not move
  });

  test("onNearEnd fires while inside the trigger zone", () => {
    let hits = 0;
    const h = mountList({ onNearEnd: () => hits++ });
    frame(0);
    expect(hits).toBe(0);
    h.scroller.scrollTo(920, { immediate: true }); // max = 950, zone = 36
    frame(0);
    expect(hits).toBe(1);
  });
});

describe("focusRow", () => {
  test("focuses a row programmatically, scrolling it into view", () => {
    const h = mountList();
    h.focusRow(0);
    frame(0);
    expect(h.focusedIndex()).toBe(0);
    expect(getFocused()).toBe(canvasNode().children[0]);
    h.focusRow(50); // off-window: chases + focuses on mount
    for (let i = 0; i < 60; i++) frame(0);
    expect(h.focusedIndex()).toBe(50);
    h.focusRow(999); // clamps to the last row
    for (let i = 0; i < 120; i++) frame(0);
    expect(h.focusedIndex()).toBe(99);
  });
});

describe("handle reactivity hygiene", () => {
  test("focusRow inside an effect does not subscribe to count", () => {
    const [count, setCount] = createSignal(10);
    let effectRuns = 0;
    let h!: VirtualListHandle;
    dispose = publicRender(
      () => {
        const el = VirtualList({
          get count() {
            return count();
          },
          rowHeight: 10,
          height: 50,
          renderRow: (i) => Text({ children: `R${i}` }),
          ref: (handle) => {
            h = handle;
          },
        });
        createEffect(() => {
          effectRuns++;
          h.focusRow(0); // must NOT leak a props.count subscription
        });
        return el;
      },
      { ops: host.ops, styles: {} },
    );
    const runsAfterMount = effectRuns;
    setCount(11); // an append must not re-fire the caller's effect
    expect(effectRuns).toBe(runsAfterMount);
    expect(h.focusedIndex()).toBe(0);
  });
});
