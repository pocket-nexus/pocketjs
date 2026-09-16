// Public platform primitives for application code.
//
// The renderer still owns the lower-case host tags internally. Apps should
// import these React Native-style components from `PocketJS` instead of writing
// host tags directly. This file intentionally contains no JSX so ordinary Bun
// tests can import the public entry without a Solid transform step.

import type { JSX as SolidJSX } from "solid-js";
import { createRenderEffect, createSignal, onCleanup, untrack } from "solid-js";
import { ResourceBoundary } from "./resource-boundary.ts";
import { pending, type ResourceState } from "./resource-state.ts";
import type { PreparedText, TextResource } from "./fonts.ts";
import { createElement, spread } from "./renderer.ts";
import type { NodeMirror } from "./renderer.ts";

type StyleObject = Record<string, number | string>;
type RefProp =
  | ((node: NodeMirror) => void)
  | { current: NodeMirror | null }
  | NodeMirror
  | undefined;

export interface ViewProps {
  class?: string;
  style?: StyleObject;
  onPress?: () => void;
  focusable?: boolean;
  /** DevTools semantic name shown in the component tree (docs/DEVTOOLS.md). */
  debugName?: string;
  ref?: RefProp;
  nodeRef?: RefProp;
  children?: SolidJSX.Element;
}

export interface TextProps {
  /** A prepared whole-text lease. Its immutable text and font slot own content. */
  resource?: TextResource;
  fallback?: () => SolidJSX.Element;
  errorFallback?: (error: unknown) => SolidJSX.Element;
  class?: string;
  style?: StyleObject;
  /** DevTools semantic name shown in the component tree (docs/DEVTOOLS.md). */
  debugName?: string;
  ref?: RefProp;
  nodeRef?: RefProp;
  children?: SolidJSX.Element;
}

export interface ImageProps {
  class?: string;
  src?: string;
  style?: StyleObject;
  /** DevTools semantic name shown in the component tree (docs/DEVTOOLS.md). */
  debugName?: string;
  ref?: RefProp;
  nodeRef?: RefProp;
}

function callRef(ref: RefProp, node: NodeMirror): void {
  if (!ref) return;
  if (typeof ref === "function") ref(node);
  else if ("current" in ref) ref.current = node;
}

export interface SpriteProps {
  class?: string;
  /** DevTools semantic name shown in the component tree (docs/DEVTOOLS.md). */
  debugName?: string;
  /** Core ticks per atlas frame. Overrides the sprite manifest when provided. */
  frameStep?: number;
  /** Sprite-atlas key (a `ui:sprite.<name>` entry baked into the pak). */
  sprite?: string;
  style?: StyleObject;
  ref?: RefProp;
}

export interface CompositorSurfaceProps {
  class?: string;
  style?: StyleObject;
  /** Stable package id from the resolved Pocket System installation model. */
  package: string;
  /** Shell focus fact consumed by the native compositor. */
  focused?: boolean;
  debugName?: string;
  ref?: RefProp;
  nodeRef?: RefProp;
}

function primitive(tag: "view" | "text" | "image" | "surface", props: Record<string, unknown>): SolidJSX.Element {
  const el = createElement(tag);
  spread(el, props, false);
  callRef(props.nodeRef as RefProp, el);
  return el as unknown as SolidJSX.Element;
}

export function View(props: ViewProps): SolidJSX.Element {
  return primitive("view", props as Record<string, unknown>);
}

export function Text(props: TextProps): SolidJSX.Element {
  // The presence of this prop selects the resource form for this component's lifetime.
  if ("resource" in props) {
    const [state, setState] = createSignal<ResourceState<PreparedText>>(pending());
    createRenderEffect(() => {
      const resource = props.resource;
      const update = () => setState(() => resource?.state() ?? pending());
      untrack(update);
      const unsubscribe = resource?.subscribe(update);
      onCleanup(() => unsubscribe?.());
    });
    return ResourceBoundary({
      state,
      fallback: () => props.fallback?.() ?? null,
      errorFallback: error => props.errorFallback?.(error) ?? props.fallback?.() ?? null,
      children: value => primitive("text", {
        get class() { return props.class; },
        get style() { return { ...props.style, fontSlot: value().slot }; },
        get debugName() { return props.debugName; },
        get ref() { return props.ref; },
        get nodeRef() { return props.nodeRef; },
        get children() { return value().text; },
      }),
    });
  }
  return primitive("text", props as Record<string, unknown>);
}

export function Image(props: ImageProps): SolidJSX.Element {
  return primitive("image", props as Record<string, unknown>);
}

/** A package AppInstance composed by a native host. It participates in
 *  ordinary layout, clipping and z-order but has no image/texture semantics. */
export function CompositorSurface(props: CompositorSurfaceProps): SolidJSX.Element {
  return primitive("surface", props as unknown as Record<string, unknown>);
}

/**
 * An auto-playing animated sprite — a native primitive alongside View/Text/Image.
 * Backed by an image node whose `sprite` atlas the Rust core cycles per vblank
 * (deterministic, zero per-frame JS). It plays from the first frame the moment
 * it is displayed, so revealing/paging one starts its animation automatically.
 */
export function Sprite(props: SpriteProps): SolidJSX.Element {
  return primitive("image", props as Record<string, unknown>);
}
