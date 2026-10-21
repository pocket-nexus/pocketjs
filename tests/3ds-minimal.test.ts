import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { test3dsMinimal } from "../tools/test-3ds-minimal.ts";
import { resolveRuntimeProgram } from "../tools/build/programs.ts";
const root = resolve(import.meta.dir, "..");
test("3DS aliases select independent product and minimal configurations", async () => {
  const product = await resolveRuntimeProgram({ from: root, target: "3ds" });
  const minimal = await resolveRuntimeProgram({ from: root, target: "3ds", generic: true });
  const direct = await resolveRuntimeProgram({ from: root, target: "3ds-runtime" });
  expect(product.config?.path).toBe(resolve(root, "products/3ds/pocket.runtime-config.ts"));
  expect(product.profile.id).toBe("3ds-dev");
  expect(minimal.config?.path).toBe(resolve(root, "programs/3ds/pocket.runtime-config.ts"));
  expect(direct.profileHash).toBe(minimal.profileHash);
  expect(minimal.config?.dependencies.some(path => path.startsWith(resolve(root, "products") + "/"))).toBe(false);
  expect(minimal.config?.value.build?.sourceInputs?.some(path => path.includes("products/"))).toBe(false);
});
test.skipIf(!Bun.which("cc"))("minimal file program uses actual Runtime and generated guest through terminal destruction", () => {
  const out = resolve(root, `.pocket-build/validation/3ds-minimal/${Date.now()}-${process.pid}`);
  expect(test3dsMinimal(out)).toContain("terminal teardown and zero leaks passed");
}, 240_000);
