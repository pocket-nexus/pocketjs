import { shallowRef, triggerRef, getCurrentScope, onScopeDispose, type Ref } from "vue";
import { ModelRegion, registerModelRegion } from "./model-reactive.ts";
export function createModelRegion(development = true, recursionLimit = 256): ModelRegion {
  const region = registerModelRegion(new ModelRegion(<T>(seed: T) => {
    const storage = shallowRef(seed);
    return [() => storage.value, value => { const equal = value === storage.value; storage.value = value; if (equal) triggerRef(storage); }];
  }, development, recursionLimit));
  if (getCurrentScope()) onScopeDispose(() => region.dispose());
  return region;
}
export function watch<T>(_source: Ref<T> | (() => T) | readonly (Ref<T> | (() => T))[], _body: (value: T, previous: T | undefined) => void, _options?: { immediate?: boolean }): void {
  throw new Error("Model effects require app.model = compiled and the PocketJS transform");
}
export function watchEffect(_body: () => void): void { throw new Error("Model effects require app.model = compiled and the PocketJS transform"); }
