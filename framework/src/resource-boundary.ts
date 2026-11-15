import { createMemo, untrack, type Accessor, type JSX } from "solid-js";
import type { ResourceState } from "./resource-state.ts";

export interface ResourceBoundaryProps<T> {
  state: Accessor<ResourceState<T>>;
  fallback: () => JSX.Element;
  errorFallback?: (error: unknown) => JSX.Element;
  children: (value: Accessor<T>) => JSX.Element;
}

/** Reveals only this subtree. Rendering never starts IO or waits for a Promise.
 * Factories are lazy, and superseded content is disposed by Solid's owner. */
export function ResourceBoundary<T>(props: ResourceBoundaryProps<T>): JSX.Element {
  const state = createMemo(props.state);
  const status = createMemo(() => state().status);
  const error = createMemo(() => { const value = state(); return value.status === "error" ? value.error : undefined; });
  return createMemo(() => {
    const phase = status();
    const reason = phase === "error" ? error() : undefined;
    if (phase !== "ready") return phase === "error" && props.errorFallback
      ? props.errorFallback(reason) : props.fallback();
    return untrack(() => {
      return props.children(() => {
        const current = state();
        if (current.status !== "ready") throw new Error("Resource read outside its ready subtree");
        return current.value;
      });
    });
  }) as unknown as JSX.Element;
}

