import { createSignal as stockSignal, getOwner, onCleanup, type Accessor, type Setter } from "solid-js";
import { ModelRegion, registerModelRegion } from "./model-reactive.ts";
import { registerModelLifecycle } from "./lifecycle-solid-aot.ts";
export function createModelRegion(development = true, recursionLimit = 256): ModelRegion {
  const region = registerModelRegion(new ModelRegion(<T>(seed: T): [() => T, (value: T) => void] => {
    const [read, set] = stockSignal(seed, { equals: false });
    return [read, (value: T) => { set(() => value); }];
  }, development, recursionLimit));
  const dispose = registerModelLifecycle(region, !getOwner());
  if (getOwner()) onCleanup(dispose);
  return region;
}
/** Source signatures; compiled calls register the analyzed dependency sets. */
export function createSignal<T>(value: T): [Accessor<T>, Setter<T>] { return stockSignal(value); }
export function createMemo<T>(body: () => T): Accessor<T> { return body; }
export function on<T>(sources: Accessor<T>[], body: () => void, options: { defer?: boolean } = {}): (() => void) & { sources: Accessor<T>[]; defer: boolean } {
  return Object.assign(body, { sources, defer: options.defer ?? false });
}
export function createEffect(_body: () => void): void { throw new Error("Model effects require app.model = compiled and the PocketJS transform"); }
