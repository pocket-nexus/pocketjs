import { createMemo, createRenderEffect, type Accessor, type JSX } from "solid-js";
import { Image, View, type ViewProps } from "./primitives.ts";
import { insert, type NodeMirror } from "./renderer.ts";
import { getOps } from "./host.ts";
import type { ResourceState } from "./resource-state.ts";
import { ResourceBoundary } from "./resource-boundary.ts";
export { ResourceBoundary, type ResourceBoundaryProps } from "./resource-boundary.ts";
export { createResourceSlot, pending, ready, failed, type ResourceState } from "./resource-state.ts";

/** A decoded/uploaded image, including its texture envelope dimensions. */
export interface TextureResource { handle: number; width: number; height: number }
export interface ResourceImageProps extends Pick<ViewProps, "class" | "style" | "debugName"> {
  state: Accessor<ResourceState<TextureResource>>;
  fallback: () => JSX.Element;
  errorFallback?: (error: unknown) => JSX.Element;
}

/** The outer View reserves layout and clipping while content is pending.
 * It borrows the texture: eviction and freeTexture belong to the resource owner. */
export function ResourceImage(props: ResourceImageProps): JSX.Element {
  const frame = View({
    get class() { return props.class; },
    get style() { return props.style; },
    get debugName() { return props.debugName; },
  });
  // Construct the content after the outer primitive has returned. Keeping the
  // lazy subtree inside View's children getter retains its entire synchronous
  // spread/effect stack while fallback components mount on recursive engines.
  const content = ResourceBoundary({
    state: props.state,
    fallback: props.fallback,
    errorFallback: props.errorFallback,
    children: value => {
      let node: NodeMirror | undefined;
      const handle = createMemo(() => value().handle);
      const result = Image({
        ref: n => { node = n; },
        get style() { return { posType: 1, insetL: 0, insetT: 0, width: value().width, height: value().height }; },
      });
      createRenderEffect(() => { if (node) getOps().setImage(node.id, handle()); });
      return result;
    },
  });
  insert(frame as unknown as NodeMirror, content);
  return frame;
}
