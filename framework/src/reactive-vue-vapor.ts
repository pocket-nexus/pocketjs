import { shallowRef, triggerRef, getCurrentScope, onScopeDispose, type Ref } from "vue";
import { ModelRegion, registerModelRegion } from "./model-reactive.ts";
import { registerModelLifecycle } from "./lifecycle-vue-aot.ts";
export function createModelRegion(development = true, recursionLimit = 256): ModelRegion {
  const region = registerModelRegion(new ModelRegion(<T>(seed: T): [() => T, (value: T) => void] => {
    const storage = shallowRef(seed);
    return [() => storage.value, value => { const equal = value === storage.value; storage.value = value; if (equal) triggerRef(storage); }];
  }, development, recursionLimit));
  const dispose = registerModelLifecycle(region, !getCurrentScope());
  if (getCurrentScope()) onScopeDispose(dispose);
  return region;
}
type WatchSource<T> = Ref<T> | (() => T);
export function watch<T>(source: WatchSource<T>, body: (value:T, previous:T)=>void, options?: {immediate?:false}):void;
export function watch<T>(source: WatchSource<T>, body: (value:T, previous:T|undefined)=>void, options: {immediate:true}):void;
export function watch(source: readonly WatchSource<unknown>[], body:()=>void, options?:{immediate?:boolean}):void;
export function watch<T>(_source: WatchSource<T> | readonly WatchSource<unknown>[], _body: (value:T, previous:T|undefined)=>void, _options?: {immediate?:boolean}):void {
  throw new Error("Model effects require app.model = compiled and the PocketJS transform");
}
export function watchEffect(_body: () => void): void { throw new Error("Model effects require app.model = compiled and the PocketJS transform"); }
