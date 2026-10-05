import { initDevtools } from "@pocketjs/framework/devtools";
import type { HostOps } from "@pocketjs/framework/host";

// Raw app bundle used by tests/sim.test.ts to exercise installation failures
// and reentrant boots without mounting a framework tree.
type LifecycleGlobals = typeof globalThis & {
  __simLifecycleEval?: () => void;
  __simLifecycleCreateFrameworkGlobals?: boolean;
  __simLifecycleFrameworkMarker?: unknown;
  __simLifecycleMutateNestedGlobals?: boolean;
  __simLifecycleInitDevtools?: boolean;
  __simLifecycleBridgeHolder?: { current: unknown };
  __simLifecycleAfterDevtools?: (current: unknown) => void;
  __simLifecycleThrowDuringEval?: boolean;
  __simLifecycleEvalLeak?: unknown;
  frame?: () => void;
};

const globals = globalThis as LifecycleGlobals;
const properties = globals as unknown as Record<PropertyKey, unknown>;

globals.__simLifecycleEval?.();

if (globals.__simLifecycleCreateFrameworkGlobals) {
  for (const key of [
    "document",
    "window",
    "Node",
    "Element",
    "HTMLElement",
    "Text",
    "Comment",
    "__pocketjsNativeReturn",
  ]) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: globals.__simLifecycleFrameworkMarker,
    });
  }
}

if (globals.__simLifecycleMutateNestedGlobals) {
  const consoleObject = console as unknown as Record<PropertyKey, unknown>;
  consoleObject.__simLifecycleNested = globals.__simLifecycleFrameworkMarker;
  consoleObject.log = globals.__simLifecycleFrameworkMarker;
  consoleObject.__pocketBridge = {
    current: globals.__simLifecycleFrameworkMarker,
  };
  const NodeConstructor = properties.Node;
  if (typeof NodeConstructor === "function") {
    Object.defineProperty(NodeConstructor, Symbol.hasInstance, {
      configurable: true,
      value: globals.__simLifecycleFrameworkMarker,
    });
  }
}

if (globals.__simLifecycleInitDevtools) {
  const consoleObject = console as unknown as {
    __pocketBridge?: { current: unknown };
  };
  consoleObject.__pocketBridge = globals.__simLifecycleBridgeHolder;
  initDevtools(properties.ui as HostOps);
  if (consoleObject.__pocketBridge) {
    globals.__simLifecycleAfterDevtools?.(consoleObject.__pocketBridge.current);
  }
}

if (globals.__simLifecycleThrowDuringEval) {
  globals.__simLifecycleEvalLeak = globals.__simLifecycleFrameworkMarker;
  throw new Error("sim lifecycle fixture eval failed");
}

globals.frame = () => {};
