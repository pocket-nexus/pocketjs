import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { jsxPlugin, transformFile } from "../framework/compiler/jsx-plugin.ts";
import { compileVueSfc } from "../framework/compiler/vue-sfc-compile.ts";

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const COUNTER_SFC = `
<script setup lang="ts">
import { ref } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/vue-vapor/components";
const count = ref(0);
let node: NodeMirror | undefined;
</script>

<template>
  <View class="flex-row gap-3" @press="count++">
    <Text class="text-base text-white">Count: {{ count }}</Text>
  </View>
</template>
`;

describe("Vue SFC Vapor compilation", () => {
  test("compiles an unmarked SFC as Vapor and preserves ref semantics", () => {
    const result = compileVueSfc(COUNTER_SFC, "/virtual/Counter.vue");

    expect(result.code).toContain("defineVaporComponent");
    expect(result.code).not.toContain("defineComponent");
    expect(result.code).toContain("count.value++");
    expect(result.code).toContain("count.value");
    // Inline template compilation keeps every static class/text node as an
    // ordinary string literal — the invariant pass-1 collection relies on.
    expect(result.code).toContain("flex-row gap-3");
    expect(result.code).toContain("text-base text-white");
    expect(result.code).toContain("Count: ");
  });

  test("runs the compiled module through PocketJS collection", async () => {
    const result = await transformFile("/virtual/Counter.vue", COUNTER_SFC, "vue-vapor");
    const codepoints = new Set(result.textCodepoints);

    expect(result.code).not.toContain(": any");
    expect(result.code).not.toContain("type NodeMirror");
    expect(result.classStrings).toContain("flex-row gap-3");
    expect(result.classStrings).toContain("text-base text-white");
    for (const character of "Count: ") {
      expect(codepoints.has(character.codePointAt(0)!)).toBe(true);
    }
  });

  test("requires the Vue Vapor framework", async () => {
    await expect(transformFile("/virtual/Counter.vue", COUNTER_SFC, "solid")).rejects.toThrow(
      'requires framework "vue-vapor"',
    );
  });

  test("rejects runtime CSS blocks", () => {
    expect(() => compileVueSfc(`${COUNTER_SFC}\n<style>.x { color: red }</style>`, "/virtual/Styled.vue"))
      .toThrow("<style> blocks are not supported");
  });

  test("bundles an imported .vue file through the Web build plugin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-vue-sfc-"));
    directories.push(directory);
    const entry = join(directory, "main.ts");
    await Bun.write(join(directory, "App.vue"), COUNTER_SFC);
    await Bun.write(
      entry,
      `import { mount } from "@pocketjs/framework/vue-vapor";\n` +
        `import App from "./App.vue";\n` +
        `mount(App);\n`,
    );

    const result = await Bun.build({
      entrypoints: [entry],
      format: "iife",
      target: "browser",
      conditions: ["browser"],
      define: {
        "process.env.NODE_ENV": '"production"',
        document: "globalThis.__pocketDocument",
        __POCKET_TARGET__: '""',
        __POCKET_HOST_ABI__: "0",
        __POCKET_FEATURES__: "{}",
        __POCKET_PIXEL_RATIO__: "1",
      },
      plugins: [jsxPlugin("vue-vapor", { entry })],
    });

    expect(result.success).toBe(true);
    expect((await result.outputs[0]!.text()).length).toBeGreaterThan(0);
  });

  test("compiles component v-model", async () => {
    const modelButtonSource = await Bun.file(
      new URL("../apps/vue-sfc-lab/ModelButton.vue", import.meta.url),
    ).text();
    const modelButton = compileVueSfc(modelButtonSource, "/virtual/ModelButton.vue");

    expect(modelButton.code).toContain("modelValue");
    expect(modelButton.code).toContain("update:modelValue");
    expect(modelButton.code).toContain("model.value++");
  });

  test("compiles a v-if chain and template fragments", async () => {
    const appSource = await Bun.file(
      new URL("../apps/vue-sfc-lab/app.vue", import.meta.url),
    ).text();
    const app = compileVueSfc(appSource, new URL("../apps/vue-sfc-lab/app.vue", import.meta.url).pathname);

    expect(app.code).toContain('"onUpdate:modelValue"');
    expect(app.code).toContain("_createIf");
    expect(app.code).toContain("_unref(count) === 0");
    expect(app.code).toContain("_unref(count) < 4");
    expect(app.code).toContain("_unref(count) > 0");
    expect(app.code).toContain("Vue SFC Feature Lab");
  });

  test("compiles keyed template v-for with value and index aliases", async () => {
    const appSource = await Bun.file(
      new URL("../apps/vue-sfc-lab/app.vue", import.meta.url),
    ).text();
    const app = compileVueSfc(appSource, new URL("../apps/vue-sfc-lab/app.vue", import.meta.url).pathname);

    expect(app.code).toContain("_createFor");
    expect(app.code).toContain("_for_item0.value.label");
    expect(app.code).toContain("_for_key0.value + 1");
    const listPath = new URL("../apps/vue-sfc-lab/FeatureList.vue", import.meta.url).pathname;
    const list = compileVueSfc(await Bun.file(listPath).text(), listPath);
    expect(list.code).toMatch(/\(item\)\s*=>\s*\(item\.id\)/);
    expect(app.code).toMatch(/\(feature, index\)\s*=>\s*\(`summary-\$\{feature\.id\}`\)/);
    expect(app.code).toContain("flex-row gap-2");
  });

  test("rejects v-else without an adjacent v-if branch", () => {
    const source = `<script setup>const ok = true</script><template><div v-else>{{ ok }}</div></template>`;
    expect(() => compileVueSfc(source, "/virtual/OrphanElse.vue")).toThrow(
      /v-else.*adjacent v-if/i,
    );
  });

  test("strips template comments from the emitted render function", () => {
    const source = `<script setup>const ok = true</script>
<template>
  <!-- leading block comment -->
  <div>{{ ok }}</div>
  <!-- trailing
       multi-line comment -->
</template>`;
    const result = compileVueSfc(source, "/virtual/Comments.vue");

    expect(result.code).not.toContain("<!--");
    expect(result.code).not.toContain("leading block comment");
    expect(result.code).not.toContain("multi-line comment");
  });
});
