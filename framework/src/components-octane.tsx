// Octane-facing public component API.
//
// Host primitives are hand-lowered universal plans (lower-case host tags stay
// out of the global JSX namespace on purpose — see framework/src/jsx.d.ts);
// composite components are ordinary Octane function components and this file
// is compiled by the Octane compiler, so their hooks get call-site slots.

import { useLayoutEffect, useMemo, useRef, useState } from "octane";
import type { JSX as SolidJSX } from "solid-js";
import { ENUMS, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { animate, type EasingName } from "./animation.ts";
import {
  useButtonPress,
  useFrame,
  pushButtonHandlerBlock,
  type ButtonPressOptions,
} from "./frame-octane.tsx";
import { BTN } from "./input-api.ts";
import { pushFocusGrid, pushFocusScope, type FocusGridOptions, type FocusScopeOptions } from "./input.ts";
import {
  createPortal as universalCreatePortal,
  defineUniversalComponent,
  OCTANE_RENDERER_ID,
  overlayPortalTarget,
  setProp,
  universalPlan,
  universalValue,
  type NodeMirror,
} from "./renderer-octane.ts";
import { getAuxiliarySurfaceRoots } from "./display.ts";

export type { NodeMirror } from "./renderer-octane.ts";

type StyleObject = Record<string, number | string>;
type NodeRef = ((node: NodeMirror | null) => void) | { current: NodeMirror | null } | undefined;

export type VNodeChild = SolidJSX.Element | (() => SolidJSX.Element);

const RENDERER_MODULE = "@pocketjs/framework/octane/renderer";

const createPortal = universalCreatePortal as unknown as (
  children: unknown,
  target: unknown,
) => SolidJSX.Element;

function valueOf<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function resolveActive(active: unknown): boolean {
  const resolved = valueOf(active);
  return typeof resolved === "function" ? !!resolved() : (resolved as boolean | undefined) ?? true;
}

function normalizeClassValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value)
      .filter(([, active]) => !!active)
      .map(([name]) => name)
      .join(" ");
  }
  if (!Array.isArray(value)) return value;
  const parts = value
    .map((part) => normalizeClassValue(part))
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join(" ");
}

function mergeRefs(...refs: NodeRef[]): (node: NodeMirror | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(node);
      else ref.current = node;
    }
  };
}

/** Normalize public props into native-tree's exact host property contract. */
function hostProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (key === "children" || key === "key") continue;
    const value = props[key];
    if (value === undefined) continue;
    if (key === "className") {
      if (out.class === undefined) out.class = normalizeClassValue(value);
    } else if (key === "class") {
      out.class = normalizeClassValue(value);
    } else if (key === "nodeRef") {
      if (out.ref === undefined) out.ref = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Host primitives
// ---------------------------------------------------------------------------

export interface ViewProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  onPress?: () => void;
  focusable?: boolean;
  debugName?: string;
  nodeRef?: NodeRef;
  key?: string | number;
  children?: VNodeChild;
}

export interface TextProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
  key?: string | number;
  children?: VNodeChild;
}

export interface ImageProps {
  class?: string;
  className?: string;
  src?: string;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
  key?: string | number;
}

export interface SpriteProps {
  class?: string;
  className?: string;
  frameStep?: number;
  sprite?: string;
  style?: StyleObject;
  debugName?: string;
  nodeRef?: NodeRef;
  key?: string | number;
}

export interface CompositorSurfaceProps {
  class?: string;
  className?: string;
  style?: StyleObject;
  package: string;
  focused?: boolean;
  debugName?: string;
  nodeRef?: NodeRef;
  key?: string | number;
}

type Component<P> = (props: P) => SolidJSX.Element;

function primitive<P extends object>(tag: "view" | "text" | "image" | "surface"): Component<P> {
  const plan = universalPlan(OCTANE_RENDERER_ID, {
    kind: "host",
    type: tag,
    propsSlot: 0,
    children: [{ kind: "slot", slot: 1 }],
  });
  return defineUniversalComponent(
    OCTANE_RENDERER_ID,
    (props: Record<string, unknown>) => universalValue(plan, [hostProps(props), props.children]),
    { module: RENDERER_MODULE },
  ) as unknown as Component<P>;
}

export const View = primitive<ViewProps>("view");
export const Text = primitive<TextProps>("text");
export const Image = primitive<ImageProps>("image");
export const Sprite = primitive<SpriteProps>("image");
export const CompositorSurface = primitive<CompositorSurfaceProps>("surface");

// ---------------------------------------------------------------------------
// Composites
// ---------------------------------------------------------------------------

export interface ScreenProps extends ViewProps {}

export function Screen(props: ScreenProps) {
  return (
    <View
      {...props}
      class={props.class ?? props.className ?? "relative flex-col w-full h-full bg-slate-50 overflow-hidden"}
    />
  );
}

export interface FocusableProps extends ViewProps {
  onPress?: () => void;
}

export function Focusable(props: FocusableProps) {
  return <View {...props} focusable={true} />;
}

export interface FocusScopeProps extends ViewProps, FocusScopeOptions {
  active?: boolean | (() => boolean);
}

export function FocusScope(props: FocusScopeProps) {
  const ref = useRef<NodeMirror | null>(null);
  const active = resolveActive(props.active);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !active) return;
    return pushFocusScope(node, {
      autoFocus: props.autoFocus,
      restoreFocus: props.restoreFocus,
    });
  }, [active]);
  const { active: _active, autoFocus: _autoFocus, restoreFocus: _restoreFocus, ...rest } = props;
  return <View {...rest} nodeRef={mergeRefs(ref, props.nodeRef)} />;
}

export interface FocusGridProps extends ViewProps, FocusGridOptions {
  active?: boolean | (() => boolean);
}

export function FocusGrid(props: FocusGridProps) {
  const ref = useRef<NodeMirror | null>(null);
  const active = resolveActive(props.active);
  const columns = props.columns;
  const wrap = props.wrap;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !active) return;
    return pushFocusGrid(node, { columns, wrap });
  }, [active, columns, wrap]);
  const { active: _active, columns: _columns, wrap: _wrap, ...rest } = props;
  return <View {...rest} nodeRef={mergeRefs(ref, props.nodeRef)} />;
}

export interface ActionHandlerProps extends ButtonPressOptions {
  button: number;
  onPress: (pressed: number, buttons: number) => void;
  children?: VNodeChild;
}

export function ActionHandler(props: ActionHandlerProps) {
  useButtonPress(
    props.button,
    (pressed, buttons) => props.onPress?.(pressed, buttons),
    {
      allowWhenBlocked: props.allowWhenBlocked,
      active: () => resolveActive(props.active),
      latched: props.latched,
    },
  );
  return <>{props.children}</>;
}

export interface PortalProps {
  children?: VNodeChild;
}

export function Portal(props: PortalProps) {
  const target = useMemo(() => overlayPortalTarget(), []);
  return <>{createPortal(props.children, target)}</>;
}

export interface AuxiliarySurfaceProps {
  children?: VNodeChild;
}

export function AuxiliarySurface(props: AuxiliarySurfaceProps) {
  const target = useMemo(() => getAuxiliarySurfaceRoots().app, []);
  return <>{createPortal(props.children, target)}</>;
}

export function AuxiliaryPortal(props: AuxiliarySurfaceProps) {
  const target = useMemo(() => getAuxiliarySurfaceRoots().overlay, []);
  return <>{createPortal(props.children, target)}</>;
}

export interface ModalProps {
  class?: string;
  panelClass?: string;
  open?: boolean | (() => boolean);
  children?: VNodeChild;
}

export function Modal(props: ModalProps) {
  const target = useMemo(() => overlayPortalTarget(), []);
  const open = resolveActive(props.open);
  useLayoutEffect(() => {
    if (!open) return;
    return pushButtonHandlerBlock();
  }, [open]);
  return (
    <>
      {createPortal(
        <View class={props.class ?? "absolute inset-0 z-50 flex-col items-center justify-center"}>
          <View class="absolute inset-0 bg-slate-950" style={{ opacity: open ? 0.62 : 0 }} />
          <View
            class={props.panelClass ?? "flex-col gap-2 w-[328] p-3 rounded-xl shadow-lg bg-white border-slate-200"}
            style={{ opacity: open ? 1 : 0, translateY: 0, scale: 1 }}
          >
            {props.children}
          </View>
        </View>,
        target,
      )}
    </>
  );
}

export interface ActionBarProps extends ViewProps {}

export function ActionBar(props: ActionBarProps) {
  const target = useMemo(() => overlayPortalTarget(), []);
  return (
    <>
      {createPortal(
        <View
          {...props}
          class={
            props.class ??
            props.className ??
            "absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200"
          }
        />,
        target,
      )}
    </>
  );
}

export interface GridProps extends ViewProps, Partial<FocusGridOptions> {
  gap?: number;
  active?: boolean | (() => boolean);
}

export function Grid(props: GridProps) {
  const ref = useRef<NodeMirror | null>(null);
  const active = resolveActive(props.active);
  const columns = props.columns;
  const wrap = props.wrap;
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || columns == null || !active) return;
    return pushFocusGrid(node, { columns, wrap });
  }, [active, columns, wrap]);
  const { active: _active, columns: _columns, wrap: _wrap, gap, style, ...rest } = props;
  return (
    <View
      {...rest}
      class={props.class ?? props.className ?? "flex-row flex-wrap"}
      style={gap != null ? { ...(style ?? {}), gap } : style}
      nodeRef={mergeRefs(ref, props.nodeRef)}
    />
  );
}

export interface LazyProps extends Omit<ViewProps, "children"> {
  when: boolean | (() => boolean);
  reveal?: number;
  fallback?: VNodeChild | (() => VNodeChild);
  children: VNodeChild | (() => VNodeChild);
}

export function Lazy(props: LazyProps) {
  const reveal = Math.max(0, Math.floor(props.reveal ?? 0));
  const [ready, setReady] = useState(reveal === 0);
  const elapsed = useRef(0);
  useFrame(() => {
    if (ready) return;
    if (!resolveActive(props.when)) return;
    if (++elapsed.current >= reveal) setReady(true);
  });
  const active = resolveActive(props.when);
  const body = (!active
    ? null
    : ready
      ? valueOf(props.children)
      : valueOf(props.fallback)) as VNodeChild;
  const { when: _when, reveal: _reveal, fallback: _fallback, children: _children, ...rest } = props;
  return (
    <View
      {...rest}
      style={
        props.class || props.className
          ? props.style
          : {
              ...(props.style ?? {}),
              grow: 1,
              width: SCREEN_W,
              flexDir: ENUMS.FlexDir.Col,
              justify: ENUMS.Justify.Center,
              align: ENUMS.Align.Center,
            }
      }
    >
      {body}
    </View>
  );
}

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

export function Gallery(props: GalleryProps) {
  const count = Math.max(0, Math.floor(props.count ?? 0));
  const win = Math.max(0, Math.floor(props.window ?? 1));
  const clampPage = (n: number): number =>
    props.wrap ? ((n % count) + count) % count : Math.max(0, Math.min(count - 1, n));
  const page = clampPage(Math.max(0, Math.floor(valueOf(props.page) ?? 0)));
  const stripRef = useRef<NodeMirror | null>(null);
  const mounted = useRef(false);

  if (props.bindTriggers !== false) {
    useButtonPress(BTN.LTRIGGER, () => props.onPageChange?.(clampPage(page - 1)));
    useButtonPress(BTN.RTRIGGER, () => props.onPageChange?.(clampPage(page + 1)));
  }

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    if (!mounted.current) {
      mounted.current = true;
      setProp(strip, "style", { translateX: -page * SCREEN_W }, undefined);
      return;
    }
    animate(strip, "translateX", -page * SCREEN_W, {
      dur: props.duration ?? 300,
      easing: props.easing ?? "out",
    });
  }, [page]);

  const pages: SolidJSX.Element[] = [];
  for (let i = 0; i < count; i++) {
    pages.push(
      <View
        key={i}
        style={{
          posType: ENUMS.PosType.Absolute,
          insetT: 0,
          insetR: 0,
          insetB: 0,
          insetL: 0,
          translateX: i * SCREEN_W,
        }}
      >
        {Math.abs(i - page) <= win ? props.renderPage(i) : null}
      </View>,
    );
  }

  return (
    <View
      class={props.class}
      style={props.class ? undefined : { width: SCREEN_W, height: SCREEN_H, overflow: ENUMS.Overflow.Hidden }}
    >
      <View nodeRef={stripRef} style={{ width: SCREEN_W, height: SCREEN_H }}>
        {pages}
      </View>
    </View>
  );
}
