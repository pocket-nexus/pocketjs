// The execution domain the compiler assigned to this bundle: tools/build.ts
// defines "ui", tools/build-worker.ts defines "worker". Outside a compiled
// bundle, such as a test, the constant is absent and no assertion runs.
import type { PocketDomain } from "../../contracts/spec/worker.ts";

declare const __POCKET_DOMAIN__: PocketDomain | undefined;

/** The bundle's domain, or undefined outside a compiled bundle. */
export function compiledDomain(): PocketDomain | undefined {
  return typeof __POCKET_DOMAIN__ === "undefined" ? undefined : __POCKET_DOMAIN__;
}

/** A domain module loaded into the other domain's bundle is a compiler
 *  defect; the subpath registry keeps it out of that bundle's import set. */
export function assertDomain(expected: PocketDomain, module: string): void {
  const actual = compiledDomain();
  if (actual !== undefined && actual !== expected) {
    throw new Error(`${module} is ${expected}-domain code; this bundle is the ${actual} domain`);
  }
}
