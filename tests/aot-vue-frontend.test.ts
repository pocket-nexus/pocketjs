import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { analyzeVueAot } from "../microts/compiler/aot-frontend.ts";
const root = resolve(import.meta.dir, "..");
test("Vue lab preserves typed model, factory, slot and input contracts deterministically", () => {
  const labEntry = resolve(root, "apps/vue-sfc-lab/app.vue");
  const program = analyzeVueAot(labEntry, { strict: true });
  expect(JSON.stringify(analyzeVueAot(labEntry, { strict: true }))).toBe(JSON.stringify(program));
  expect(program.version).toBe(1);
  const app = program.components.find(c => c.root)!;
  expect(app.name).toBe(program.root);
  expect(app.values.find(v => v.name === "count")).toMatchObject({ type: { kind: "number", name: "i32" }, writable: true });
  expect(app.functions.find(f => f.name === "adjustCount")).toMatchObject({
    parameters: [{ name: "delta", type: { kind: "number", name: "i32" } }], returns: { kind: "void" }, handler: true, binding: false,
  });
  expect(app.provides).toMatchObject([{ key: "theme", value: { kind: "binding", name: "theme", scope: "vm" } }]);

  const toggle = program.components.find(c => c.name === "FeatureToggle")!;
  expect(toggle.factory).toMatchObject({ name: "createFeatureToggle", module: "./FeatureToggle" });
  expect(toggle.values.find(v => v.name === "presses")?.type).toEqual({ kind: "number", name: "i32" });
  expect(toggle.functions.find(f => f.name === "press")).toMatchObject({ returns: { kind: "number", name: "i32" }, handler: true });
  expect(toggle.injections).toMatchObject([{ key: "theme", type: { kind: "named", name: "LabTheme" } }]);

  const list = program.components.find(c => c.name === "FeatureListInstance1")!;
  expect(list.props.find(p => p.name === "items")?.type).toEqual({ kind: "array", element: { kind: "named", name: "Feature" } });
  expect(list.slotProps).toEqual([{ name: "row", parameters: [{ name: "item", type: { kind: "named", name: "Feature" } }] }]);
  expect(program.components.find(c => c.name === "FeatureCard")?.slots).toEqual(["badge", "default", "footer"]);

  const button = program.components.find(c => c.name === "ModelButton")!;
  expect(button.props.find(p => p.name === "modelValue")).toMatchObject({ model: "modelValue", type: { kind: "number", name: "i32" } });
  expect(button.events).toEqual([{ name: "update:modelValue", parameters: [{ name: "value", type: { kind: "number", name: "i32" } }] }]);
  expect(program.demands).toEqual({ buttons: [16384], axes: [0], motion: [], capabilities: ["relative-axis"] });
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
test("Vue motion method handlers receive the payload values they declare", () => {
  const contract = 'import type { f32, u8 } from "@pocketjs/framework/vue-vapor/std"; export declare function lean(beta: f32, gamma: f32): void; export declare let w: f32;';
  const source = (update: string) => `<script setup lang="ts">import { MotionHandler, View } from "@pocketjs/framework/vue-vapor/components"; import { lean, w } from "./App";</script><template><View><MotionHandler @update="lean" value="tilt" /><MotionHandler value="orientation" minQuality="medium" @update="${update}" /></View></template>`;
  const program = vue(source("w = $event"), contract);
  const view = program.components.find(c => c.root)!.nodes[0]!;
  const inputs = view.kind === "element" ? view.children : [];
  expect(inputs.map(node => node.kind === "input" && node.input)).toEqual([
    { kind: "motion", name: "tilt", value: 7, minQuality: 2 },
    { kind: "motion", name: "orientation", value: 4, minQuality: 3 },
  ]);
  const first = inputs[0]!;
  expect(first.kind === "input" && first.handler.kind === "call" && first.handler.expression.kind === "call" && first.handler.expression.arguments.map(a => a.kind === "binding" && a.name)).toEqual(["$event", "$event1"]);
  expect(program.demands).toEqual({ buttons: [], axes: [], motion: [4, 7], capabilities: ["motion"] });
  // Vue has no names for later payload values in an inline statement; Vapor guests would leave them undefined.
  expect(() => vue(source("w = $event1"), contract)).toThrow("$event1");
  // Only the whole attribute is a method handler: inside a statement, Vue evaluates the reference without calling it.
  expect(() => vue(source("if (w > 0) { lean; }"), contract)).toThrow("A reference to lean does nothing");
  expect(() => vue(source("lean; w = $event"), contract)).toThrow("A reference to lean does nothing");
});
