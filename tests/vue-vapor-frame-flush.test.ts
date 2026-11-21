import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { exposeVaporFrameFlush } from "../framework/compiler/vue-vapor-frame-flush.ts";

test("the Vue scheduler adapter recognizes both pinned runtime builds", async () => {
  for (const name of ["vue.runtime-with-vapor.esm-browser.js", "vue.runtime-with-vapor.esm-browser.prod.js"]) {
    const output = exposeVaporFrameFlush(await Bun.file(resolve("node_modules/vue/dist", name)).text());
    expect(output).toContain("__pocketInstallFrameFlush(");
    expect(output).toContain("vue-vapor-flush.ts");
  }
  expect(() => exposeVaporFrameFlush("export function nextTick() {};")).toThrow("Vue runtime scheduler changed");
});

test("PocketJS Vue hooks complete structural and cleanup rounds before returning", async () => {
  const dir = resolve(".pocket-build/validation/solid-runtime", `vue-hooks-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const fixture = resolve(dir, "fixture.ts");
  await Bun.write(fixture, `
import { effectScope, ref, renderEffect } from "vue";
import { onMounted, onUnmounted, flushLifecycleHooks, flushUnmountedHooks, resetLifecycleHooks } from ${JSON.stringify(resolve("framework/src/lifecycle-vue-aot.ts"))};
export function check() {
  resetLifecycleHooks();
  const trace = [];
  const open = ref(true);
  const count = ref(1);
  let displayed;
  let child;
  const root = effectScope();
  root.run(() => {
    onMounted(() => { trace.push("parent mount"); open.value = false; });
    onUnmounted(() => trace.push("parent unmount"));
    renderEffect(() => { displayed = count.value; });
    renderEffect(() => {
      if (open.value && !child) {
        child = effectScope();
        child.run(() => {
          trace.push("child created");
          onMounted(() => trace.push("child mount"));
          onUnmounted(() => { trace.push("child unmount"); count.value--; });
        });
      } else if (!open.value && child) { child.stop(); child = undefined; }
    });
  });
  flushLifecycleHooks();
  const afterMount = [...trace];
  root.stop();
  flushUnmountedHooks();
  return { afterMount, trace, displayed };
}
`);
  const runtime = resolve("node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.prod.js");
  const result = await Bun.build({ entrypoints: [fixture], target: "bun", format: "esm", plugins: [{
    name: "real-vue-runtime",
    setup(build) {
      build.onResolve({ filter: /^vue$/ }, () => ({ path: runtime }));
      build.onLoad({ filter: /vue\.runtime-with-vapor\.esm-browser\.prod\.js$/ }, async () => ({ contents: exposeVaporFrameFlush(await Bun.file(runtime).text()), loader: "js" }));
    },
  }] });
  expect(result.success).toBe(true);
  const bundle = resolve(dir, "fixture.mjs");
  await Bun.write(bundle, result.outputs[0]!);
  const output = (await import(bundle)).check();
  expect(output.afterMount).toEqual(["child created", "parent mount", "child mount", "child unmount"]);
  expect(output.trace).toEqual([...output.afterMount, "parent unmount"]);
  expect(output.displayed).toBe(0);
});
