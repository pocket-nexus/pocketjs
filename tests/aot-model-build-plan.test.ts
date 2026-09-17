import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";

const baseline = JSON.parse(readFileSync(resolve("tests/fixtures/manifests/portable-psp.json"), "utf8"));
function plan(app: Record<string, unknown>) {
  const result = validateAndResolveBuildPlan({ ...baseline, app: { ...baseline.app, ...app } }, { target: "psp" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

test("model selection and recursion limits are part of the resolved build identity", () => {
  const compiled = plan({ aot: true, model: "compiled", recursionLimit: 32 });
  expect(compiled.app).toMatchObject({ aot: true, model: "compiled", recursionLimit: 32 });
  expect(verifyPlanHash(compiled)).toBe(true);
  expect(verifyPlanHash({ ...compiled, app: { ...compiled.app, model: "rust" } })).toBe(false);
  expect(verifyPlanHash({ ...compiled, app: { ...compiled.app, recursionLimit: 64 } })).toBe(false);
  expect(plan({ aot: true, model: "rust", recursionLimit: 32 }).planHash).not.toBe(compiled.planHash);
});

test.each([
  { aot: true, model: "rust", recursionLimit: 32 },
  { aot: true, model: "compiled", recursionLimit: 64 },
  { aot: false, model: "rust", recursionLimit: 32 },
  { aot: true, model: "compiled", recursionLimit: 32, framework: "vue-vapor" },
])("a frozen plan rejects changed model configuration %j before compiling", changed => {
  const directory = resolve(".pocket-build/validation/model-aot/build-plan", `${process.pid}-${changed.model}-${changed.recursionLimit}-${changed.aot}-${changed.framework ?? "solid"}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "plan.json"), JSON.stringify(plan({ aot: true, model: "compiled", recursionLimit: 32 })));
  writeFileSync(resolve(directory, "pocket.json"), JSON.stringify({ ...baseline, app: { ...baseline.app, ...changed } }));
  const run = Bun.spawnSync([process.execPath, resolve("tools/build.ts"), `--plan=${resolve(directory, "plan.json")}`, `--project-root=${directory}`, "--no-config"], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr.toString()).toContain("model settings differ from the ResolvedBuildPlan");
});
