import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { analyzeSolidAot } from "../vapor/compiler/aot-solid-frontend.ts";
import { analyzeVueAot } from "../vapor/compiler/aot-frontend.ts";
import { emitVueAot } from "../vapor/compiler/aot-codegen.ts";

function analyze(kind: "solid" | "vue", contract: string, expression: string, type = "i64") {
  const entry = resolve(`tests/fixtures/aot/constants/App.${kind === "solid" ? "tsx" : "vue"}`);
  const extension = kind === "solid" ? "solid" : "vue-vapor";
  const imports = `import { Text, View } from "@pocketjs/framework/${extension}/components"; import { TABLE, index, record } from "./App";`;
  const source = kind === "solid" ? `${imports} export default function App() { return <View focusable onPress={() => record(${expression})}><Text>{TABLE[0]}</Text></View>; }`
    : `<script setup lang="ts">${imports}</script><template><View focusable @press="record(${expression})"><Text>{{ TABLE[0] }}</Text></View></template>`;
  const sources = new Map([[entry, source], [resolve(entry, "../App.d.ts"), `import type { ${type}, i32 } from "@pocketjs/framework/${extension}/std"; import type { ${kind === "solid" ? "Accessor" : "Ref"} } from "${kind === "solid" ? "solid-js" : "vue"}";
${contract}
export declare const index: ${kind === "solid" ? "Accessor" : "Ref"}<i32>; export declare function record(value: ${type}): void;`]]);
  return (kind === "solid" ? analyzeSolidAot : analyzeVueAot)(entry, { sources, strict: true });
}

test.each(["solid", "vue"] as const)("%s literal u64 tables retain exact source spelling", kind => {
  const program = analyze(kind, 'export declare const TABLE: readonly [18446744073709551615, 9007199254740993];', `TABLE[${kind === "solid" ? "index()" : "index"}] ?? 0`, "u64");
  const root = program.components.find(component => component.root)!;
  const table = root.constants.find(constant => constant.name === "TABLE")!;
  expect(table.type).toEqual({ kind: "array", element: { kind: "number", name: "u64" }, length: 2 });
  expect(table.rawNumbers).toEqual(["18446744073709551615", "9007199254740993"]);
  const output = emitVueAot(program).files["app.rs"]!;
  expect(output).toContain("18446744073709551615u64");
  expect(output).toContain("9007199254740993u64");
  expect(root.values.some(value => value.name === "TABLE")).toBe(false);
});

test.each(["solid", "vue"] as const)("%s literal i64 table negative values retain exact source spelling", kind => {
  const program = analyze(kind, 'export declare const TABLE: readonly [-9223372036854775808, 9223372036854775807];', `TABLE[${kind === "solid" ? "index()" : "index"}] ?? 0`);
  const output = emitVueAot(program).files["app.rs"]!;
  expect(output).toContain("-9223372036854775808i64");
  expect(output).toContain("9223372036854775807i64");
});

test.each(["solid", "vue"] as const)("%s reactive literal values remain writable getters", kind => {
  const entry = resolve(`tests/fixtures/aot/constants/App.${kind === "solid" ? "tsx" : "vue"}`);
  const extension = kind === "solid" ? "solid" : "vue-vapor";
  const source = kind === "solid" ? `import { View, Text } from "@pocketjs/framework/solid/components"; import { state, setState } from "./App"; export default function App() { return <View focusable onPress={() => setState("ONLY")}><Text>{state()}</Text></View>; }`
    : `<script setup lang="ts">import { View, Text } from "@pocketjs/framework/vue-vapor/components"; import { state } from "./App";</script><template><View focusable @press="state = 'ONLY'"><Text>{{ state }}</Text></View></template>`;
  const contract = kind === "solid" ? `import type { Accessor, Setter } from "solid-js"; export declare const state: Accessor<"ONLY">; export declare const setState: Setter<"ONLY">;`
    : `import type { Ref } from "vue"; export declare const state: Ref<"ONLY">;`;
  const sources = new Map([[entry, source], [resolve(entry, "../App.d.ts"), contract]]);
  const result = (kind === "solid" ? analyzeSolidAot : analyzeVueAot)(entry, { sources, strict: true });
  const root = result.components.find(component => component.root)!;
  expect(root.constants).toEqual([]);
  expect(root.values).toEqual([{ name: "state", sourceName: "state", type: { kind: "string" }, writable: true }]);
  expect(emitVueAot(result).files["app.rs"]).toContain("fn set_state(&mut self, value: String)");
});
