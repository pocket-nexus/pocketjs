import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import { jsxPlugin, transformFile } from "../framework/compiler/jsx-plugin.ts";

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

test.each(["solid", "vue-vapor"] as const)("compiled %s models follow the resolved presentation entry instead of the default App", async framework => {
  const directory = resolve(".pocket-build/validation/model-aot/build-plan", `${process.pid}-presentation-${framework}`);
  mkdirSync(directory, { recursive: true });
  const extension = framework === "solid" ? ".tsx" : ".vue";
  const settings = { aot: true, model: "compiled", framework, entry: "main.ts", presentations: [
    { id: "buttons", entry: "buttons-main.ts", modality: { buttons: true } },
  ] };
  const compiled = plan(settings);
  writeFileSync(resolve(directory, "pocket.json"), JSON.stringify({ ...baseline, app: { ...baseline.app, ...settings } }));
  const view = (name: string) => framework === "solid" ? `import { Text } from "@pocketjs/framework/solid/components";
import { count } from "./${name}";
export default function ${name}() { return <Text>{count()}</Text>; }` : `<script setup lang="ts">
import { Text } from "@pocketjs/framework/vue-vapor/components";
import { count } from "./${name}";
</script><template><Text>{{ count }}</Text></template>`;
  const model = framework === "solid" ? `import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";
export const [count, setCount] = createSignal<i32>(2147483647);
export function press(): void { setCount(count() + 1); }` : `import { ref } from "vue";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";
export const count = ref<i32>(2147483647);
export function press(): void { count.value = count.value + 1; }`;
  for (const name of ["App", "Buttons"]) {
    writeFileSync(resolve(directory, name + extension), view(name));
    writeFileSync(resolve(directory, `${name}.ts`), model);
  }
  writeFileSync(resolve(directory, "main.ts"), `import App from "./App${extension}"; export default App;`);
  writeFileSync(resolve(directory, "buttons-main.ts"), `import Buttons from "./Buttons${extension}"; export default Buttons; export { count, press } from "./Buttons.ts";`);
  expect(compiled.app.entry).toBe("buttons-main.ts");
  const entry = resolve(directory, compiled.app.entry);
  const transformed = await transformFile(resolve(directory, "Buttons.ts"), model, framework, { entry });
  expect(transformed.code).toContain("createModelRegion");
  const standalone = await transformFile(resolve(directory, "App.ts"), model, framework);
  expect(standalone.code).toContain("createModelRegion");
  const bootstrap = await transformFile(resolve(directory, "App.ts"), model, framework, { entry: resolve(directory, "main.ts") });
  expect(bootstrap.code).toBe(standalone.code);
  const result = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm", conditions: ["browser"], plugins: [jsxPlugin(framework, { entry })] });
  expect(result.success, result.logs.join("\n")).toBe(true);
  const output = resolve(directory, "presentation.mjs");
  await Bun.write(output, result.outputs[0]!);
  const compiledModel = await import(output);
  compiledModel.press();
  expect(framework === "solid" ? compiledModel.count() : compiledModel.count.value).toBe(-2147483648);
}, 60_000);
