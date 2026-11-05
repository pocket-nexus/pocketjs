// Type surface of system-engine.js for the TS harness
// (tests/web-system-host.test.ts). The .js stays plain ESM so the browser
// loads it without a build step — the same split wasm-ops.d.ts documents.

import type { ResolvedSystemPackage, ResolvedSystemPlan } from "../../framework/src/manifest/system.ts";

/** Focus without scrolling, so a double-click cannot land on another surface. */
export declare function focusCanvas(
  canvas: { focus(options: { preventScroll: boolean }): void },
): void;

/** One-based compositor handles in installation order. */
export declare function createSurfaceCatalog(
  applications: readonly ResolvedSystemPackage[],
): {
  catalog: Map<number, ResolvedSystemPackage>;
  surfaces: Record<string, number>;
};

/** Throws unless the plan is a web-app ABI 4 System the browser host can run. */
export declare function validateSystemPlan(plan: ResolvedSystemPlan): void;

export declare function mountPocketSystem(
  canvas: unknown,
  options?: {
    planUrl?: string;
    baseUrl?: string;
    distBase?: string;
    wasmUrl?: string;
    instanceUrl?: string;
    onLog?: (message: string) => void;
  },
): Promise<unknown>;
