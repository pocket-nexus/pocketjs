import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import { analyzeVueAot } from "../vapor/compiler/aot-frontend.ts";
const root = resolve(import.meta.dir, "..");
export const portableAot = (program: unknown) => JSON.parse(JSON.stringify(program, (key, value) => key === "file" && typeof value === "string" ? relative(root, value) : value));
test("Vue feature lab View IR", () => {
  expect(portableAot(analyzeVueAot(resolve(root, "apps/vue-sfc-lab/app.vue"), { strict: true }))).toMatchSnapshot();
});

function vue(source: string, contract: string) {
  const file = resolve(root, "tests/fixtures/aot/vue/App.vue");
  return analyzeVueAot(file, { strict: true, sources: new Map([[file, source], [file.replace(/\.vue$/, ".d.ts"), contract]]) });
}
test("Vue lowers statement sequences, branches and PocketJS lifecycle hooks", () => {
  const program = vue(`<script setup lang="ts">
import { View } from "@pocketjs/framework/vue-vapor/components";
import { onMounted, onUnmounted } from "@pocketjs/framework/vue-vapor/lifecycle";
import { count, reset, load, release } from "./App";
onMounted(() => load()); onUnmounted(() => release());
</script><template><View focusable @press="if (count &lt; 10) count++; reset();" /></template>`, `import type { i32 } from "@pocketjs/framework/vue-vapor/std";
export declare const count: i32; export declare function reset(): void; export declare function load(): i32; export declare function release(): void;`);
  const app = program.components.find(c => c.root)!;
  expect(app.hooks?.mount?.kind).toBe("call");
  expect(app.hooks?.unmount?.kind).toBe("call");
  expect(app.values.find(v => v.name === "count")?.writable).toBe(true);
  const node = app.nodes[0]!;
  expect(node.kind === "element" && node.events[0]?.handler.kind).toBe("sequence");
});
test("Vue rejects model reads after an emit and unsupported handler statements", () => {
  const source = (body: string) => `<script setup lang="ts">import { View } from "@pocketjs/framework/vue-vapor/components"; import { reset } from "./App"; const emit = defineEmits<{ saved: [] }>();</script><template><View focusable @press="${body}" /></template>`;
  expect(() => vue(source("emit('saved'); reset();"), 'export declare function reset(): void;')).toThrow("An emit must be the last statement");
  expect(() => vue(source("let x = 1; reset();"), 'export declare function reset(): void;')).toThrow("expression statements and if statements only");
});
test("Vue literal tables are compile-time constants", () => {
  const program = vue(`<script setup lang="ts">import { Text } from "@pocketjs/framework/vue-vapor/components"; import { len } from "@pocketjs/framework/vue-vapor/std"; import { FILTERS, index } from "./App";</script><template><Text>{{ FILTERS[0] }}:{{ len(FILTERS) }}:{{ FILTERS[index] ?? '' }}</Text></template>`, 'import type { i32 } from "@pocketjs/framework/vue-vapor/std"; export declare const FILTERS: readonly ["ALL", "ACTIVE", "DONE"]; export declare const index: i32;');
  const app = program.components.find(c => c.root)!;
  expect(app.constants[0]!.value).toEqual(["ALL", "ACTIVE", "DONE"]);
  expect(app.values.map(v => v.name)).toEqual(["index"]);
});
