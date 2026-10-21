import { describe, expect, test } from "bun:test";
import {
  createSurfaceCatalog,
  focusCanvas,
  validateSystemPlan,
} from "../hosts/web/system-engine.js";
import { validateAndResolveSystemPlan } from "@pocketjs/framework/manifest";
import systemInput from "./fixtures/systems/managed-desktop.json";
import { POCKET_BINDING_GENERATION } from "../engine/guest-web/src/generated-ui.js";

async function resolvedWebSystem() {
  const installed = new Set(systemInput.installation.installedPackages);
  const packages = await Promise.all(
    systemInput.applications.catalog
      .filter((entry) => installed.has(entry.package))
      .map(async (entry) => ({
        source: entry.manifest,
        manifest: await Bun.file(entry.manifest).json(),
      })),
  );
  const result = validateAndResolveSystemPlan(systemInput, {
    target: "web-app",
    packages,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

/** The resolver hands back a deeply readonly plan. The rejection tests
 *  deliberately corrupt a clone of one, so they need a writable view of it. */
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type WebSystemPlan = Awaited<ReturnType<typeof resolvedWebSystem>>;

async function corruptibleWebSystem(): Promise<Mutable<WebSystemPlan>> {
  return structuredClone(await resolvedWebSystem()) as Mutable<WebSystemPlan>;
}

describe("browser Pocket System host", () => {
  test("focusing the canvas cannot move a double-click onto another surface", () => {
    let options: FocusOptions | undefined;
    focusCanvas({
      focus(next: FocusOptions) {
        options = next;
      },
    });
    expect(options).toEqual({ preventScroll: true });
  });

  test("assigns one-based compositor handles in installation order", async () => {
    const plan = await resolvedWebSystem();
    const { catalog, surfaces } = createSurfaceCatalog(plan.applications);
    expect(catalog.get(0)).toBeUndefined();
    expect(catalog.get(1)).toBe(plan.applications[0]);
    expect(surfaces[plan.applications[0].package]).toBe(1);
    expect(surfaces[plan.applications[1].package]).toBe(2);
  });

  test("accepts a complete resolved web System plan", async () => {
    const plan = await resolvedWebSystem();
    expect(() => validateSystemPlan(plan)).not.toThrow();
  });
  test("rejects unsupported root and package binding generations without treating generation as profile identity", async () => {
    const current = await resolvedWebSystem();
    expect(current.target.hostAbi).toBe(POCKET_BINDING_GENERATION);
    for (const generation of [...Array.from({ length: 12 }, (_, i) => i), POCKET_BINDING_GENERATION + 1]) {
      const root = structuredClone(current) as Mutable<WebSystemPlan>;
      root.target.hostAbi = generation;
      expect(() => validateSystemPlan(root)).toThrow("binding generation");
      const child = structuredClone(current) as Mutable<WebSystemPlan>;
      child.applications[0].plan.target.hostAbi = generation;
      expect(() => validateSystemPlan(child)).toThrow("binding generation");
    }
    const wrongProfile = structuredClone(current) as Mutable<WebSystemPlan>;
    wrongProfile.target.id = "vita";
    expect(() => validateSystemPlan(wrongProfile)).toThrow("web-app");
  });

  test("rejects child companions and artifact collisions at its trust boundary", async () => {
    const companions = await corruptibleWebSystem();
    companions.applications[0].plan.companions = ["note"];
    expect(() => validateSystemPlan(companions)).toThrow("unsupported companions");

    const collision = await corruptibleWebSystem();
    collision.applications[1].plan.app.output = collision.applications[0].plan.app.output;
    expect(() => validateSystemPlan(collision)).toThrow("duplicate or missing artifact output");
  });
});
