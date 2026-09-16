// Vue Vapor-facing public component API.

import {
  defineVaporComponent,
  insert as vaporInsert,
  onScopeDispose,
  shallowRef,
  watchEffect,
} from "vue";
import type { JSX as SolidJSX } from "solid-js";
import { ENUMS, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { animate, type EasingName } from "./animation.ts";
import { pushButtonHandlerBlock, onButtonPress, onFrame, type ButtonPressOptions } from "./frame-vue-vapor.ts";
import { BTN } from "./input-api.ts";
import { pushFocusGrid, pushFocusScope, type FocusGridOptions, type FocusScopeOptions } from "./input.ts";
import { getOverlayRoot } from "./overlay.ts";
import { getAuxiliarySurfaceRoots } from "./display.ts";
import {
  createCommentNode,
  createElement,
  createTextNode,
  detachNode,
  insertNode,
  setProp,
  type HostProps,
  type NodeMirror,
} from "./native-tree.ts";
import { createRenderRoot, type RenderRoot } from "./renderer-vue-vapor.ts";

export type { NodeMirror } from "./renderer-vue-vapor.ts";

type StyleObject = Record<string, number | string>;
type NodeRef = ((node: NodeMirror | null) => void) | { current: NodeMirror | null } | undefined;
type SlotFn = (...args: unknown[]) => unknown;
type SlotBag = Record<string, SlotFn | undefined> | SlotFn | undefined;

export type VNodeChild = SolidJSX.Element | (() => SolidJSX.Element);
const NO_FALLTHROUGH = { inheritAttrs: false } as const;
type VaporCtx = { slots: SlotBag; attrs: Record<string, unknown> };
type VaporSetup<P extends object> = (props: P, ctx: VaporCtx) => unknown;
const definePocketVaporComponent = defineVaporComponent as unknown as <P extends object>(
  setup: VaporSetup<P>,
  extraOptions?: typeof NO_FALLTHROUGH,
) => (props: P) => SolidJSX.Element;
const insertVaporBlock = vaporInsert as unknown as (
  block: unknown,
  parent: NodeMirror,
  anchor?: NodeMirror | null,
) => void;
export interface ViewProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  onPress?: () => void;
  focusable?: boolean;
  nodeRef?: NodeRef;
  children?: VNodeChild;
}

export interface TextProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  nodeRef?: NodeRef;
  children?: VNodeChild;
}

export interface ImageProps {
  class?: string;
  className?: string;
  src?: string;
  style?: StyleObject;
  nodeRef?: NodeRef;
}

export interface SpriteProps {
  class?: string;
  className?: string;
  frameStep?: number;
  sprite?: string;
  style?: StyleObject;
  nodeRef?: NodeRef;
}

export interface CompositorSurfaceProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  package: string;
  focused?: boolean;
  nodeRef?: NodeRef;
}

function valueOf<T>(value: T): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function callbackOf<T extends (...args: any[]) => unknown>(value: unknown): T | undefined {
  if (typeof value !== "function") return undefined;
  return ((...args: unknown[]) => {
    const resolved = (value as (...innerArgs: unknown[]) => unknown)(...args);
    return typeof resolved === "function"
      ? (resolved as (...innerArgs: unknown[]) => unknown)(...args)
      : resolved;
  }) as T;
}

function booleanOption(value: unknown): boolean | undefined {
  const resolved = valueOf(value);
  return typeof resolved === "boolean" ? resolved : undefined;
}

function assignRef(refValue: unknown, node: NodeMirror | null): void {
  const ref = refValue as NodeRef;
  if (!ref) return;
  if (typeof ref === "function") {
    const resolved = (ref as (node: NodeMirror | null) => unknown)(node);
    if (typeof resolved === "function") resolved(node);
  } else {
    ref.current = node;
  }
}

function slotDefault(slots: SlotBag, ...args: unknown[]): unknown {
  return withNativeTextDocument(() => {
    if (typeof slots === "function") return slots(...args);
    return slots?.default?.(...args);
  });
}

function withNativeTextDocument<T>(fn: () => T): T {
  // Patch the guest's document, never the embedding page's: vue-vapor builds
  // alias the guest `document` to globalThis.__pocketDocument (see
  // installVueVaporDom), and the real browser document must stay untouched.
  const g = globalThis as { __pocketDocument?: unknown; document?: unknown };
  const doc = (g.__pocketDocument ?? g.document) as
    | {
        createTextNode?: (value?: string) => unknown;
        createComment?: (value?: string) => unknown;
      }
    | undefined;
  if (!doc) return fn();
  const prevCreateTextNode = doc.createTextNode;
  const prevCreateComment = doc.createComment;
  try {
    doc.createTextNode = (value = "") => createTextNode(String(value));
    doc.createComment = (value = "") => createCommentNode(String(value));
    return fn();
  } finally {
    if (prevCreateTextNode) doc.createTextNode = prevCreateTextNode;
    else delete doc.createTextNode;
    if (prevCreateComment) doc.createComment = prevCreateComment;
    else delete doc.createComment;
  }
}

function normalizeVaporBlock(block: unknown): unknown | null {
  while (typeof block === "function" && block.length === 0) {
    block = withNativeTextDocument(() => (block as () => unknown)());
  }
  if (block == null || typeof block === "boolean") return null;
  if (!Array.isArray(block)) return block;
  const out: unknown[] = [];
  for (const child of block) {
    const normalized = normalizeVaporBlock(child);
    if (Array.isArray(normalized)) out.push(...normalized);
    else if (normalized != null) out.push(normalized);
  }
  return out.length > 0 ? out : null;
}

function defaultBlock(slots: SlotBag, ...args: unknown[]): unknown | null {
  return normalizeVaporBlock(slotDefault(slots, ...args));
}

function normalizeClassValue(value: unknown): unknown {
  const resolved = valueOf(value);
  if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
    return Object.entries(resolved)
      .filter(([, active]) => !!valueOf(active))
      .map(([name]) => name)
      .join(" ");
  }
  if (!Array.isArray(resolved)) return resolved;
  const parts = resolved
    .map((part) => normalizeClassValue(part))
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join(" ");
}

function normalizeStyleValue(value: unknown): unknown {
  const resolved = valueOf(value);
  if (!Array.isArray(resolved)) return resolved;
  const out: StyleObject = {};
  for (const part of resolved) {
    const normalized = normalizeStyleValue(part);
    if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
      Object.assign(out, normalized);
    }
  }
  return out;
}

function cleanProps(props: Record<string, unknown>, omit: Set<string>): HostProps {
  const out: HostProps = {};
  for (const rawKey of Object.keys(props)) {
    // Vue templates conventionally spell multi-word props in kebab case.
    // JSX already supplies the camel-case forms, so normalize only at this
    // host-component boundary and keep native-tree's property contract exact.
    const key = rawKey === "debug-name"
      ? "debugName"
      : rawKey === "node-ref"
        ? "nodeRef"
        : rawKey;
    if (omit.has(rawKey) || omit.has(key)) continue;
    const rawValue = props[rawKey];
    if (key === "class" || key === "className") out[key] = normalizeClassValue(rawValue);
    else if (key === "style") out[key] = normalizeStyleValue(rawValue);
    else if (key === "onPress" || key === "on:press") out[key] = callbackOf<() => void>(rawValue);
    // Primitive host components intentionally keep props in attrs instead of
    // declaring runtime prop tables. Vue therefore leaves a bare boolean
    // attribute as ""; on native components it still means true.
    else if (key === "focusable") {
      const resolved = valueOf(rawValue);
      out[key] = resolved === "" ? true : resolved;
    } else out[key] = valueOf(rawValue);
  }
  if (out.class == null && out.className != null) out.class = out.className;
  delete out.className;
  return out;
}

function cleanExtraProps(props: HostProps): HostProps {
  const out: HostProps = {};
  for (const key of Object.keys(props)) {
    if (key === "class" || key === "className") out[key] = normalizeClassValue(props[key]);
    else if (key === "style") out[key] = normalizeStyleValue(props[key]);
    else out[key] = props[key];
  }
  if (out.class == null && out.className != null) out.class = out.className;
  delete out.className;
  return out;
}

function insertBlock(block: unknown, parent: NodeMirror): void {
  const normalized = normalizeVaporBlock(block);
  if (normalized) insertVaporBlock(normalized, parent);
}

function mountChildren(node: NodeMirror, slots: SlotBag): void {
  insertBlock(slotDefault(slots), node);
}

function createPrimitiveNode(
  tag: "view" | "text" | "image" | "surface",
  rawProps: Record<string, unknown>,
  slots: SlotBag,
  opts: { omit?: string[]; onNode?: (node: NodeMirror) => void; extra?: HostProps | (() => HostProps) } = {},
): NodeMirror {
  const node = createElement(tag);
  opts.onNode?.(node);
  mountChildren(node, slots);
  const omit = new Set(["children", "key", "ref", "nodeRef", "node-ref", ...(opts.omit ?? [])]);
  let prev: HostProps = {};
  const apply = () => {
    const extra = typeof opts.extra === "function" ? opts.extra() : (opts.extra ?? {});
    const next = { ...cleanProps(rawProps, omit), ...cleanExtraProps(extra) };
    for (const key of Object.keys(next)) setProp(node, key, next[key], prev[key]);
    for (const key of Object.keys(prev)) {
      if (!(key in next)) setProp(node, key, undefined, prev[key]);
    }
    prev = next;
    assignRef(rawProps.nodeRef ?? rawProps["node-ref"] ?? rawProps.ref, node);
  };
  watchEffect(apply);
  return node;
}

function primitive(tag: "view" | "text" | "image" | "surface") {
  return definePocketVaporComponent(
    (_props: Record<string, unknown>, { attrs, slots }: VaporCtx) => createPrimitiveNode(tag, attrs, slots),
    NO_FALLTHROUGH,
  );
}

export const View = primitive("view");
export const Text = primitive("text");
export const Image = primitive("image");
export const Sprite = primitive("image");
export const CompositorSurface = primitive("surface");

function resolveActive(active: unknown): boolean {
  const resolved = valueOf(active);
  return typeof resolved === "function" ? !!resolved() : (resolved as boolean | undefined) ?? true;
}

export interface ScreenProps extends ViewProps {}

export const Screen = definePocketVaporComponent(
  (_props: ScreenProps, { attrs, slots }: VaporCtx) =>
    createPrimitiveNode("view", attrs, slots, {
      extra: () => ({ class: attrs.class ?? "relative flex-col w-full h-full bg-slate-50 overflow-hidden" }),
    }),
  NO_FALLTHROUGH,
);

export interface FocusableProps extends ViewProps {
  onPress?: () => void;
}

export const Focusable = definePocketVaporComponent(
  (_props: FocusableProps, { attrs, slots }: VaporCtx) =>
    createPrimitiveNode("view", attrs, slots, { extra: { focusable: true } }),
  NO_FALLTHROUGH,
);

export interface FocusScopeProps extends ViewProps, FocusScopeOptions {
  active?: boolean | (() => boolean);
}

export const FocusScope = definePocketVaporComponent((_props: FocusScopeProps, { attrs, slots }: VaporCtx) => {
  let root: NodeMirror | undefined;
  const node = createPrimitiveNode("view", attrs, slots, {
    omit: ["active", "autoFocus", "restoreFocus"],
    onNode(next) {
      root = next;
    },
  });
  watchEffect((registerCleanup) => {
    if (!root || !resolveActive(attrs.active)) return;
    const dispose = pushFocusScope(root, {
      autoFocus: booleanOption(attrs.autoFocus),
      restoreFocus: booleanOption(attrs.restoreFocus),
    });
    registerCleanup(dispose);
  });
  return node;
}, NO_FALLTHROUGH);

export interface FocusGridProps extends ViewProps, FocusGridOptions {
  active?: boolean | (() => boolean);
}

export const FocusGrid = definePocketVaporComponent((_props: FocusGridProps, { attrs, slots }: VaporCtx) => {
  let root: NodeMirror | undefined;
  const node = createPrimitiveNode("view", attrs, slots, {
    omit: ["active", "columns", "wrap"],
    onNode(next) {
      root = next;
    },
  });
  watchEffect((registerCleanup) => {
    if (!root || !resolveActive(attrs.active)) return;
    const dispose = pushFocusGrid(root, {
      columns: valueOf(attrs.columns) as number,
      wrap: booleanOption(attrs.wrap),
    });
    registerCleanup(dispose);
  });
  return node;
}, NO_FALLTHROUGH);

export interface ActionHandlerProps extends ButtonPressOptions {
  button: number;
  onPress: (pressed: number, buttons: number) => void;
  children?: VNodeChild;
}

export const ActionHandler = definePocketVaporComponent((_props: ActionHandlerProps, { attrs, slots }: VaporCtx) => {
  onButtonPress(
    valueOf(attrs.button) as number,
    (pressed, buttons) => callbackOf<ActionHandlerProps["onPress"]>(attrs.onPress)?.(pressed, buttons),
    {
      allowWhenBlocked: booleanOption(attrs.allowWhenBlocked),
      active: () => resolveActive(attrs.active),
      latched: booleanOption(attrs.latched),
    },
  );
  return defaultBlock(slots) ?? createCommentNode("action");
}, NO_FALLTHROUGH);

export interface PortalProps {
  children?: VNodeChild;
}

function createPortalRoot(): { marker: NodeMirror; host: NodeMirror; root: RenderRoot } {
  const marker = createCommentNode("portal");
  const host = createElement("view");
  setProp(
    host,
    "style",
    {
      width: SCREEN_W,
      height: SCREEN_H,
      posType: ENUMS.PosType.Absolute,
      insetT: 0,
      insetR: 0,
      insetB: 0,
      insetL: 0,
      zIndex: 1000,
    },
    undefined,
  );
  insertNode(getOverlayRoot(), host);
  return { marker, host, root: createRenderRoot(host) };
}

export const Portal = definePocketVaporComponent((_props: PortalProps, { slots }: { slots: SlotBag }) => {
  const state = createPortalRoot();
  watchEffect(() => {
    state.root.update(defaultBlock(slots));
  });
  onScopeDispose(() => {
    state.root.dispose();
    if (state.host.parent) detachNode(state.host.parent, state.host);
  });
  return state.marker;
}, NO_FALLTHROUGH);

export interface AuxiliarySurfaceProps {
  children?: VNodeChild;
}

export const AuxiliarySurface = definePocketVaporComponent(
  (_props: AuxiliarySurfaceProps, { slots }: { slots: SlotBag }) => {
    const surface = getAuxiliarySurfaceRoots();
    const marker = createCommentNode("auxiliary-surface");
    const host = createElement("view");
    setProp(
      host,
      "style",
      {
        width: surface.viewport.width,
        height: surface.viewport.height,
        overflow: ENUMS.Overflow.Hidden,
      },
      undefined,
    );
    insertNode(surface.app, host);
    const root = createRenderRoot(host);
    watchEffect(() => root.update(defaultBlock(slots)));
    onScopeDispose(() => {
      root.dispose();
      if (host.parent) detachNode(host.parent, host);
    });
    return marker;
  },
  NO_FALLTHROUGH,
);

export const AuxiliaryPortal = definePocketVaporComponent(
  (_props: AuxiliarySurfaceProps, { slots }: { slots: SlotBag }) => {
    const surface = getAuxiliarySurfaceRoots();
    const marker = createCommentNode("auxiliary-portal");
    const host = createElement("view");
    setProp(
      host,
      "style",
      {
        width: surface.viewport.width,
        height: surface.viewport.height,
        posType: ENUMS.PosType.Absolute,
        insetT: 0,
        insetR: 0,
        insetB: 0,
        insetL: 0,
        hitPass: 1,
      },
      undefined,
    );
    insertNode(surface.overlay, host);
    const root = createRenderRoot(host);
    watchEffect(() => root.update(defaultBlock(slots)));
    onScopeDispose(() => {
      root.dispose();
      if (host.parent) detachNode(host.parent, host);
    });
    return marker;
  },
  NO_FALLTHROUGH,
);

export interface ModalProps {
  class?: string;
  panelClass?: string;
  open?: boolean | (() => boolean);
  children?: VNodeChild;
}

export const Modal = definePocketVaporComponent((_props: ModalProps, { attrs, slots }: VaporCtx) => {
  const state = createPortalRoot();
  const frame = createElement("view");
  const backdrop = createElement("view");
  const panel = createElement("view");
  let unblockButtons: (() => void) | undefined;

  setProp(frame, "class", attrs.class ?? "absolute inset-0 z-50 flex-col items-center justify-center", undefined);
  setProp(backdrop, "class", "absolute inset-0 bg-slate-950", undefined);
  setProp(backdrop, "style", { opacity: 0 }, undefined);
  setProp(
    panel,
    "class",
    attrs.panelClass ?? "flex-col gap-2 w-[328] p-3 rounded-xl shadow-lg bg-white border-slate-200",
    undefined,
  );
  setProp(panel, "style", { opacity: 0, translateY: 0, scale: 1 }, undefined);
  insertNode(frame, backdrop);
  insertNode(frame, panel);
  state.root.update(frame);
  insertBlock(slotDefault(slots), panel);

  watchEffect((registerCleanup) => {
    const visible = resolveActive(attrs.open);
    if (visible && !unblockButtons) {
      unblockButtons = pushButtonHandlerBlock();
    } else if (!visible && unblockButtons) {
      unblockButtons();
      unblockButtons = undefined;
    }
    setProp(backdrop, "style", { opacity: visible ? 0.62 : 0 }, undefined);
    setProp(panel, "style", { opacity: visible ? 1 : 0, translateY: 0, scale: 1 }, undefined);
    registerCleanup(() => unblockButtons?.());
  });
  onScopeDispose(() => {
    unblockButtons?.();
    state.root.dispose();
    if (state.host.parent) detachNode(state.host.parent, state.host);
  });
  return state.marker;
}, NO_FALLTHROUGH);

export interface ActionBarProps extends ViewProps {}

export const ActionBar = definePocketVaporComponent((_props: ActionBarProps, { attrs, slots }: VaporCtx) => {
  const state = createPortalRoot();
  const bar = createPrimitiveNode("view", attrs, slots, {
    extra: () => ({
      class:
        attrs.class ??
        "absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200",
    }),
  });
  state.root.update(bar);
  onScopeDispose(() => {
    state.root.dispose();
    if (state.host.parent) detachNode(state.host.parent, state.host);
  });
  return state.marker;
}, NO_FALLTHROUGH);

export interface GridProps extends ViewProps, Partial<FocusGridOptions> {
  gap?: number;
  active?: boolean | (() => boolean);
}

export const Grid = definePocketVaporComponent((_props: GridProps, { attrs, slots }: VaporCtx) => {
  let root: NodeMirror | undefined;
  const hasColumns = attrs.columns != null;
  const node = createPrimitiveNode("view", attrs, slots, {
    omit: ["active", "columns", "wrap", "gap"],
    onNode(next) {
      root = next;
    },
    extra: () => {
      const style = attrs.gap != null
        ? { ...((normalizeStyleValue(attrs.style) as StyleObject | undefined) ?? {}), gap: valueOf(attrs.gap) as number }
        : normalizeStyleValue(attrs.style);
      return {
        class: attrs.class ?? "flex-row flex-wrap",
        style: style as HostProps["style"],
      };
    },
  });
  if (hasColumns) {
    watchEffect((registerCleanup) => {
      if (!root || !resolveActive(attrs.active)) return;
      const dispose = pushFocusGrid(root, {
        columns: valueOf(attrs.columns) as number,
        wrap: booleanOption(attrs.wrap),
      });
      registerCleanup(dispose);
    });
  }
  return node;
}, NO_FALLTHROUGH);

export interface LazyProps extends Omit<ViewProps, "children"> {
  when: boolean | (() => boolean);
  reveal?: number;
  fallback?: VNodeChild | (() => VNodeChild);
  children: () => VNodeChild;
}

export const Lazy = definePocketVaporComponent((_props: LazyProps, { attrs, slots }: VaporCtx) => {
  const reveal = Math.max(0, Math.floor((valueOf(attrs.reveal) as number | undefined) ?? 0));
  const ready = shallowRef(reveal === 0);
  let elapsed = 0;
  const root = createPrimitiveNode("view", attrs, undefined, {
    omit: ["when", "reveal", "fallback", "children"],
    extra: () =>
      attrs.class
        ? {}
        : {
            style: {
              grow: 1,
              width: SCREEN_W,
              flexDir: ENUMS.FlexDir.Col,
              justify: ENUMS.Justify.Center,
              align: ENUMS.Align.Center,
            },
          },
  });
  const renderRoot = createRenderRoot(root);
  const active = () => resolveActive(attrs.when);
  let renderedState: "hidden" | "fallback" | "ready" | undefined;
  const renderLazy = (): void => {
    const nextState = !active() ? "hidden" : ready.value ? "ready" : "fallback";
    if (nextState === renderedState) return;
    renderedState = nextState;
    if (nextState === "hidden") {
      renderRoot.update(null);
      return;
    }
    if (nextState === "fallback") {
      const fallback = attrs.fallback;
      renderRoot.update(typeof fallback === "function" ? (fallback as () => VNodeChild)() : fallback);
      return;
    }
    renderRoot.update(slotDefault(slots));
  };

  if (reveal > 0) {
    onFrame(() => {
      if (!ready.value && active()) {
        if (++elapsed >= reveal) ready.value = true;
      }
      renderLazy();
    });
  } else {
    onFrame(renderLazy);
  }

  renderLazy();
  onScopeDispose(() => renderRoot.dispose());
  return root;
}, NO_FALLTHROUGH);

export interface GalleryProps {
  count: number;
  page: number | (() => number);
  onPageChange?: (next: number) => void;
  renderPage: (index: number) => VNodeChild;
  window?: number;
  duration?: number;
  easing?: EasingName;
  bindTriggers?: boolean;
  wrap?: boolean;
  class?: string;
}

export const Gallery = definePocketVaporComponent((_props: GalleryProps, { attrs }: VaporCtx) => {
  const count = () => Math.max(0, Math.floor((valueOf(attrs.count) as number | undefined) ?? 0));
  const page = () => Math.max(0, Math.floor((valueOf(attrs.page) as number | undefined) ?? 0));
  const win = () => Math.max(0, Math.floor((valueOf(attrs.window) as number | undefined) ?? 1));
  const dur = () => (valueOf(attrs.duration) as number | undefined) ?? 300;
  const easing = () => (valueOf(attrs.easing) as EasingName | undefined) ?? "out";
  const renderPage = () => callbackOf<GalleryProps["renderPage"]>(attrs.renderPage);
  const onPageChange = () => callbackOf<NonNullable<GalleryProps["onPageChange"]>>(attrs.onPageChange);
  const clampPage = (n: number): number =>
    booleanOption(attrs.wrap)
      ? ((n % count()) + count()) % count()
      : Math.max(0, Math.min(count() - 1, n));
  let currentPage = page();
  const go = (delta: number): void => {
    const next = clampPage(currentPage + delta);
    if (next === currentPage) return;
    currentPage = next;
    renderCurrent(currentPage, true);
    onPageChange()?.(next);
  };

  if (attrs.bindTriggers !== false) {
    onButtonPress(BTN.LTRIGGER, () => go(-1));
    onButtonPress(BTN.RTRIGGER, () => go(1));
  }

  const viewport = createElement("view");
  const strip = createElement("view");
  const cells: NodeMirror[] = [];
  const roots: RenderRoot[] = [];
  if (attrs.class) {
    setProp(viewport, "class", attrs.class, undefined);
  } else {
    setProp(viewport, "style", { width: SCREEN_W, height: SCREEN_H, overflow: ENUMS.Overflow.Hidden }, undefined);
  }
  setProp(strip, "style", { width: SCREEN_W, height: SCREEN_H, translateX: -currentPage * SCREEN_W }, undefined);
  insertNode(viewport, strip);

  for (let i = 0; i < count(); i++) {
    const cell = createElement("view");
    setProp(
      cell,
      "style",
      {
        posType: ENUMS.PosType.Absolute,
        insetT: 0,
        insetR: 0,
        insetB: 0,
        insetL: 0,
        translateX: i * SCREEN_W,
      },
      undefined,
    );
    insertNode(strip, cell);
    cells.push(cell);
    roots.push(createRenderRoot(cell));
  }

  const renderCurrent = (current: number, animated: boolean): void => {
    if (animated) {
      animate(strip, "translateX", -current * SCREEN_W, { dur: dur(), easing: easing() });
    } else {
      setProp(strip, "style", { width: SCREEN_W, height: SCREEN_H, translateX: -current * SCREEN_W }, undefined);
    }
    const render = renderPage();
    for (let i = 0; i < cells.length; i++) {
      roots[i].update(render && Math.abs(i - current) <= win() ? render(i) : null);
    }
  };

  renderCurrent(currentPage, false);
  onFrame(() => {
    const externalPage = page();
    if (externalPage === currentPage) return;
    currentPage = externalPage;
    renderCurrent(currentPage, true);
  });
  onScopeDispose(() => roots.forEach((root) => root.dispose()));
  return viewport;
}, NO_FALLTHROUGH);
