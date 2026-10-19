// apps/home/ui/nav.tsx — a UINavigationController for one 320x240 screen:
// a stack of pages that push in from the right and pop back, each with its
// own navigation bar, scroll position and d-pad focus.
//
// A page hands the stack a PageContent: the view drawn at content offset 0,
// its height, the ids the d-pad walks, and the hit targets for an offset. The
// layer owns the scroller and the focus; the touch router asks the top layer
// for its targets; the keys go to the top layer too.

import { createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type Accessor, type JSX } from "solid-js";
import { View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { after } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { analogY, onFrame } from "@pocketjs/framework/lifecycle";
import { createScroller } from "@pocketjs/framework/kinetics";
import { NAV_H, NavBar, navTargets, type NavButton } from "./bar.tsx";
import type { Press, Target, TouchPage } from "./touch.ts";

export const SCREEN_W = 320;
export const SCREEN_H = 240;
const VIEW_H = SCREEN_H - NAV_H;
const PUSH_MS = 300;

export interface PageContent {
  view: () => JSX.Element;
  height: Accessor<number>;
  focusOrder: Accessor<readonly string[]>;
  /** Targets for content drawn at surface y `top`, scrolled by `offset`, visible above `bottom`. */
  targets(top: number, offset: number, bottom: number): Target[];
  span(id: string): [number, number] | null;
  activate(id: string): void;
}

export interface PageSpec {
  title: Accessor<string>;
  /** Text of the back button on the page pushed on top of this one. */
  backLabel?: string;
  right?: Accessor<NavButton | null>;
  /** Scrolling content under the bar. */
  content?: PageContent;
  /** Fixed content filling the screen under (and behind) the bar. */
  fixed?: () => JSX.Element;
  /** Extra targets for fixed content. */
  fixedTargets?: () => Target[];
  /** Keys the page handles before the stack (true = consumed). */
  key?: (pressed: number) => boolean;
  /** Bar tint (default iOS 6 blue; black over the camera). */
  tint?: "blue" | "black" | "orange";
  /** Drawn in the bar instead of the title. */
  titleView?: () => JSX.Element;
  /** No page background (options.background): fixed content paints its own,
   *  or "white" for a plain list. */
  bare?: boolean | "white";
}

export interface StackEntry {
  key: number;
  page: string;
}

export interface NavStack {
  entries: Accessor<readonly StackEntry[]>;
  top: Accessor<StackEntry | null>;
  push(page: string): void;
  pop(): void;
  reset(page: string | null): void;
  busy: Accessor<boolean>;
  /** The top layer's touch page. */
  touch(): TouchPage | null;
  /** Route a button press to the top layer; true when consumed. */
  key(pressed: number): boolean;
  /** Pages per entry, created inside each layer. */
  view: () => JSX.Element;
}

/** What a page builder gets from the layer it is drawn in. */
export interface LayerContext {
  /** The d-pad focus id (drawn while keys mode is on). */
  focus: Accessor<string>;
  setFocus(id: string): void;
  /** The content scroll offset (for windowing long lists). */
  offset: Accessor<number>;
  /** Scroll content so [top, bottom) is in view. */
  reveal(top: number, bottom: number): void;
}

interface Layer {
  spec: PageSpec;
  touch(): TouchPage;
  key(pressed: number): boolean;
}

export interface NavOptions {
  press: Press;
  keys: Accessor<boolean>;
  setKeys(on: boolean): void;
  /** Builds a page; runs inside the layer's reactive owner. */
  page(id: string, stack: NavStack, layer: LayerContext): PageSpec;
  /** Back at the root page (B, or the root's back button). */
  onExit(): void;
  /** Label of the root page's back button ("Home"); null draws none. */
  rootBack?: string | null;
  /** The page background (Settings' pinstripes) unless a page is bare. */
  background?: () => JSX.Element;
}

export function createNavStack(options: NavOptions): NavStack {
  let nextKey = 1;
  const [entries, setEntries] = createSignal<readonly StackEntry[]>([]);
  const [busy, setBusy] = createSignal(false);
  const layers = new Map<number, Layer>();
  const nodes = new Map<number, NodeMirror>();
  const hidden = new Map<number, (on: boolean) => void>();
  const top = () => {
    const list = entries();
    return list.length ? list[list.length - 1]! : null;
  };
  const settle = (ms: number, then?: () => void) => {
    setBusy(true);
    after(ms / 1000, () => {
      setBusy(false);
      then?.();
    });
  };

  const stack: NavStack = {
    entries,
    top,
    busy,
    push(page) {
      if (busy()) return;
      const below = top();
      setEntries([...entries(), { key: nextKey++, page }]);
      if (below) {
        const node = nodes.get(below.key);
        if (node) animate(node, "translateX", -SCREEN_W / 3, { dur: PUSH_MS, easing: "out" });
        settle(PUSH_MS, () => hidden.get(below.key)?.(true));
      }
    },
    pop() {
      if (busy()) return;
      const list = entries();
      if (list.length <= 1) {
        options.onExit();
        return;
      }
      const leaving = list[list.length - 1]!;
      const below = list[list.length - 2]!;
      hidden.get(below.key)?.(false);
      const node = nodes.get(leaving.key);
      const under = nodes.get(below.key);
      if (node) animate(node, "translateX", SCREEN_W, { dur: PUSH_MS, easing: "out" });
      if (under) animate(under, "translateX", 0, { dur: PUSH_MS, easing: "out" });
      settle(PUSH_MS, () => setEntries(entries().filter((entry) => entry.key !== leaving.key)));
    },
    reset(page) {
      setEntries(page ? [{ key: nextKey++, page }] : []);
    },
    touch() {
      const entry = top();
      return entry ? layers.get(entry.key)?.touch() ?? null : null;
    },
    key(pressed) {
      const entry = top();
      if (!entry || busy()) return false;
      return layers.get(entry.key)?.key(pressed) ?? false;
    },
    view: () => (
      <For each={entries()}>
        {(entry, index) => (
          <LayerView
            entry={entry}
            first={index() === 0}
            stack={stack}
            options={options}
            register={(layer, node, setHidden) => {
              layers.set(entry.key, layer);
              nodes.set(entry.key, node);
              hidden.set(entry.key, setHidden);
              onCleanup(() => {
                layers.delete(entry.key);
                nodes.delete(entry.key);
                hidden.delete(entry.key);
              });
            }}
          />
        )}
      </For>
    ),
  };
  return stack;
}

function LayerView(props: {
  entry: StackEntry;
  first: boolean;
  stack: NavStack;
  options: NavOptions;
  register(layer: Layer, node: NodeMirror, setHidden: (on: boolean) => void): void;
}) {
  const [focus, setFocus] = createSignal("");
  let contentRef: PageContent | undefined;
  const scroller = createScroller({
    max: () => Math.max(0, (contentRef?.height() ?? 0) - VIEW_H),
    extent: () => VIEW_H,
  });
  const reveal = (top: number, bottom: number) => {
    const offset = scroller.intent();
    if (top - 8 < offset) scroller.chaseTo(Math.max(0, top - 8));
    else if (bottom + 8 > offset + VIEW_H) scroller.chaseTo(Math.min(bottom + 8 - VIEW_H, Math.max(0, (contentRef?.height() ?? 0) - VIEW_H)));
  };
  const spec = props.options.page(props.entry.page, props.stack, { focus, setFocus, offset: scroller.offset, reveal });
  contentRef = spec.content;
  const content = spec.content;
  const [hidden, setHidden] = createSignal(false);
  const isTop = () => props.stack.top()?.key === props.entry.key;
  onFrame(() => {
    scroller.step();
    if (!isTop() || !content) return;
    const nub = analogY();
    if (nub !== 0) scroller.nudge(nub * 8);
  });

  // The back button names the page underneath (its title or backLabel).
  const below = createMemo(() => {
    const list = props.stack.entries();
    const at = list.findIndex((entry) => entry.key === props.entry.key);
    return at > 0 ? list[at - 1]! : null;
  });
  const backButton: Accessor<NavButton | null> = () => {
    const under = below();
    const label = under ? labels.get(under.key) ?? "Back" : props.options.rootBack ?? null;
    if (!label) return null;
    return { id: `nav.back.${props.entry.key}`, label, kind: "back", run: () => props.stack.pop() };
  };
  labels.set(props.entry.key, spec.backLabel ?? untrack(spec.title));
  onCleanup(() => labels.delete(props.entry.key));

  const moveFocus = (step: number) => {
    if (!content) return;
    const order = content.focusOrder();
    if (order.length === 0) return;
    const at = order.indexOf(focus());
    let next: string;
    if (!props.options.keys() || at < 0) {
      // First press: the first row on screen takes focus.
      const offset = scroller.offset();
      next = order.find((id) => (content.span(id)?.[0] ?? 0) >= offset) ?? order[0]!;
    } else {
      next = order[Math.max(0, Math.min(order.length - 1, at + step))]!;
    }
    props.options.setKeys(true);
    setFocus(next);
    const span = content.span(next);
    if (span) reveal(span[0], span[1]);
  };

  const layer: Layer = {
    spec,
    touch: () => ({
      targets: () => [
        ...(content ? content.targets(NAV_H, scroller.offset(), SCREEN_H) : []),
        ...(spec.fixedTargets?.() ?? []),
        ...navTargets(SCREEN_W, backButton(), spec.right?.() ?? null),
      ],
      scroll: content ? { scroller, top: NAV_H, bottom: SCREEN_H } : undefined,
    }),
    key(pressed) {
      if (spec.key?.(pressed)) return true;
      if (pressed & BTN.UP) {
        moveFocus(-1);
        return true;
      }
      if (pressed & BTN.DOWN) {
        moveFocus(1);
        return true;
      }
      if (pressed & BTN.CIRCLE && content && props.options.keys() && focus()) {
        const id = focus();
        props.options.press.down(id);
        props.options.press.release();
        content.activate(id);
        return true;
      }
      if (pressed & BTN.CROSS) {
        props.stack.pop();
        return true;
      }
      return false;
    },
  };

  let node: NodeMirror | undefined;
  onMount(() => {
    if (!node) return;
    props.register(layer, node, setHidden);
    if (!props.first) {
      jump(node, "translateX", SCREEN_W);
      animate(node, "translateX", 0, { dur: PUSH_MS, easing: "out" });
    }
  });

  return (
    <View
      ref={(el) => (node = el)}
      class={hidden() ? "hidden" : "absolute left-0 top-0 w-[320] h-[240] overflow-hidden bg-[#c9d0d8]"}
    >
      <Show when={!spec.bare && props.options.background}>{(background) => background()()}</Show>
      <Show when={spec.bare === "white"}>
        <View class="absolute left-0 top-0 w-[320] h-[240] bg-white" />
      </Show>
      <Show when={spec.fixed}>{(fixed) => fixed()()}</Show>
      <Show when={content}>
        {(body) => (
          <View class="absolute left-0 top-[36] w-[320] h-[204] overflow-hidden">
            <View class="absolute left-0 top-0 w-[320]" style={{ translateY: -scroller.offset(), height: Math.max(VIEW_H, body().height()) }}>
              {body().view()}
            </View>
          </View>
        )}
      </Show>
      <NavBar
        width={SCREEN_W}
        title={spec.title}
        left={backButton()}
        right={spec.right?.() ?? null}
        press={props.options.press}
        tint={spec.tint}
        titleView={spec.titleView}
      />
    </View>
  );
}

const labels = new Map<number, string>();
