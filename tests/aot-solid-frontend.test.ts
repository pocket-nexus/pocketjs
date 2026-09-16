import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import { transformSync } from "@babel/core";
import solid from "babel-preset-solid";
import { analyzeSolidAot } from "../vapor/compiler/aot-solid-frontend.ts";
import { normalizeJsxText } from "../vapor/compiler/aot-jsx-text.ts";
import type { AotNode } from "../vapor/compiler/aot-ir.ts";
const root = resolve(import.meta.dir, "..");
const entry = resolve(root, "tests/fixtures/aot/solid/App.tsx");
const modulePath = resolve(entry, "../App.d.ts");
const model = `import type { Accessor, Setter, Context } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";
export interface Item { id: string; label: string; }
export interface Theme { label: string }
export declare const ThemeContext: Context<Accessor<Theme> | undefined>;
export declare const theme: Accessor<Theme>;
export declare const count: Accessor<i32>;
export declare const setCount: Setter<i32>;
export declare const enabled: Accessor<boolean>;
export declare const items: Accessor<Item[]>;
export declare function reset(): void;
export declare function read(): i32;
export declare function adjust(delta: i32): void;
export declare const FILTERS: readonly ["ALL", "ACTIVE", "DONE"];
`;
const imports = `import { View, Text, Image, For, ActionHandler, AxisHandler } from "@pocketjs/framework/solid/components";
import { Show, Switch, Match, createMemo, mergeProps } from "solid-js";
import { BTN } from "@pocketjs/framework/input";
import { len } from "@pocketjs/framework/solid/std";
import { count, setCount, enabled, items, reset, read, adjust, FILTERS, theme, ThemeContext } from "./App";
`;
function analyze(body: string, extra = "", children: Record<string, string> = {}, contract = model) {
  const sources = new Map([[entry, `${imports}${extra}\nexport default function App() { ${body} }`], [modulePath, contract], ...Object.entries(children).map(([name, content]) => [resolve(entry, "../" + name), content] as [string, string])]);
  return analyzeSolidAot(entry, { sources, strict: true });
}
const portable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, value) => key === "file" ? relative(root, value) : value));
function flatten(nodes: AotNode[]): AotNode[] { return nodes.flatMap(node => [node, ...(node.kind === "if" ? node.branches.flatMap(b => flatten(b.children)) : node.kind === "component" ? node.slots.flatMap(s => flatten(s.children)) : node.kind === "slot" ? flatten(node.fallback) : flatten(node.children))]); }

test("Solid lab View IR is deterministic", () => {
  const program = analyzeSolidAot(resolve(root, "apps/solid-aot-lab/app.tsx"), { strict: true });
  expect(portable(program)).toMatchSnapshot();
  expect(program.version).toBe(3);
  expect(program.components.some(c => c.factory)).toBe(true);
  expect(program.components.some(c => c.name === "FeatureListInstance1")).toBe(true);
});

test("signals, derived values, keyed lists and input lower directly to shared nodes", () => {
  const program = analyze(`const zero = () => count() === 0; const width = createMemo(() => 80 + count() * 12);
    return <View style={{ width: width() }}>
      <Show when={zero()} fallback={<Text>active</Text>}><Text>idle</Text></Show>
      <For each={items()} by={item => item.id}>{(item, index) => <Text>{index() + 1}.{item().label}</Text>}</For>
      <ActionHandler button={BTN.CROSS} active={!zero()} latched onPress={() => setCount(value => value + 1)} />
      <AxisHandler axis="primary" onDelta={delta => adjust(delta)} />
    </View>;`);
  const app = program.components.at(-1)!;
  expect(app.values.find(v => v.name === "count")?.writable).toBe(true);
  expect(app.values.some(v => ["zero", "width", "setCount"].includes(v.name))).toBe(false);
  expect(flatten(app.nodes).map(n => n.kind)).toEqual(["element", "if", "element", "element", "for", "element", "input", "input"]);
  expect(program.demands).toEqual({ buttons: [16384], axes: [0], capabilities: ["relative-axis"] });
});

test("blocks, conditions, lifecycle and optional callbacks preserve effects in IR", () => {
  const program = analyze(`onMount(() => reset()); onCleanup(reset); return <Child onChanged={setCount} />;`,
    `import { onMount, onCleanup } from "@pocketjs/framework/solid/lifecycle"; import Child from "./Child.tsx";`, {
      "Child.tsx": `import { View } from "@pocketjs/framework/solid/components"; import type { i32 } from "@pocketjs/framework/solid/std";
        import { createChild } from "./Child";
        export default function Child(props: { onChanged: (n: i32) => void; onSaved?: (n: i32) => void }) {
          const { count, setCount, reset, press } = createChild();
          return <View focusable onPress={() => { if (count() < 10) setCount(v => v + 1); reset(); if (count() > 0) props.onSaved?.(press()); else props.onChanged(count()); }} />;
        }`,
      "Child.d.ts": `import type { Accessor, Setter } from "solid-js"; import type { i32 } from "@pocketjs/framework/solid/std";
        export declare function createChild(): { count: Accessor<i32>; setCount: Setter<i32>; reset: () => void; press: () => i32; };`,
    });
  const child = program.components.find(c => c.name === "Child")!, app = program.components.find(c => c.root)!;
  expect(app.hooks?.mount?.kind).toBe("call"); expect(app.hooks?.unmount?.kind).toBe("call");
  const host = child.nodes[0]!; expect(host.kind).toBe("element");
  if (host.kind !== "element") throw new Error();
  const handler = host.events[0]!.handler; expect(handler.kind).toBe("sequence");
  if (handler.kind !== "sequence") throw new Error();
  expect(handler.steps.map(s => s.kind)).toEqual(["if", "call", "if"]);
  expect(JSON.stringify(handler)).toContain('"optional":true');
});

test("literal arrays stay outside the model trait", () => {
  const program = analyze('return <Text>{FILTERS[count()] ?? ""}/{FILTERS[0]}/{len(FILTERS)}</Text>;');
  expect(program.components.at(-1)!.constants.find(c => c.name === "FILTERS")?.value).toEqual(["ALL", "ACTIVE", "DONE"]);
  expect(program.components.at(-1)!.values.some(c => c.name === "FILTERS")).toBe(false);
});

test.each([
  ['return <View>{items().map(item => <Text>{item.label}</Text>)}</View>;', "instead of .map"],
  ['const total = count(); return <Text>{total}</Text>;', "Only the factory call"],
  ['const [open, setOpen] = read(); return <View/>;', "belong to the basename module"],
  ['return <Show when={items()}><Text>x</Text></Show>;', "requires a boolean condition"],
  ['return <View ref={reset}/>;', "Node references"],
  ['return <div/>;', "not an imported host primitive"],
  ['return <View {...items()}/>;', "Spread attributes"],
  ['return <View debug-name="card"/>;', "camelCase identifiers"],
  ['return <View>{enabled() && <Text>on</Text>}</View>;', "Conditional children"],
  ['return <View>{enabled() ? <Text>on</Text> : <Text>off</Text>}</View>;', "Conditional children"],
  ['return <Text>{enabled()}</Text>;', "Boolean text"],
  ['return <Text>&amp;</Text>;', "HTML entities"],
  ['return <View debugName="&#x2192;"/>;', "HTML entities"],
  ['return <View class="p-2" class="p-3"/>;', "Duplicate attribute"],
  ['return <View>{...items()}</View>;', "Spread children"],
  ['return <View>not text</View>;', "inside Text"],
  ['return <View focusable={true}/>;', "bare attribute"],
  ['return <View class={"p-2"}/>;', "class requires a ternary"],
  ['return <Text>{count() as number}</Text>;', "TypeScript assertions"],
  ['return <Text>{count()!}</Text>;', "TypeScript assertions"],
  ['return <Text>{count() satisfies number}</Text>;', "TypeScript assertions"],
  ['return <Text>{read<number>()}</Text>;', "Type arguments"],
  ['return <View x:y="x"/>;', "camelCase identifiers"],
  ['return <a:b/>;', "Namespaced JSX"],
  ['return <View.X/>;', "Member tags"],
  ['return <View<number>/>;', "generics are inferred"],
  ['return <View class=<Text/>/>;', "inside braces"],
  ['const badge = <Text/>; return <View/>;', "Only the factory call"],
  ['return <View style="width:10"/>;', "requires an expression"],
  ['return <View style={{ ...items() }}/>;', "without spread"],
  ['return <View style={{ ["width"]: 10 }}/>;', "without spread"],
  ['return <View style={{ count }}/>;', "without spread"],
  ['return <For each={items()}>{item => <Text/>}</For>;', "requires each and by"],
  ['return <For each={items()} by={item => count()}>{item => <Text/>}</For>;', "only its parameter"],
  ['return <For each={items()} by={item => read()}>{item => <Text/>}</For>;', "only its parameter"],
  ['return <For each={items()} by={item => item.id} fallback={<Text/>}>{item => <Text/>}</For>;', "does not accept fallback"],
  ['const value = createMemo(() => read()); return <Text>{value()}</Text>;', "Derived expressions cannot"],
  ['const a = () => b(); const b = () => a(); return <Text>{a()}</Text>;', "Cyclic derived"],
  ['return <View focusable onPress={() => { let value = 1; reset(); }}/>;', "expression statements and if"],
  ['return <View focusable onPress={() => { return reset(); }}/>;', "expression statements and if"],
  ['return <Match when={enabled()}><Text/></Match>;', "direct child of Switch"],
  ['return <Show when={enabled()} keyed><Text/></Show>;', "does not accept keyed"],
  ['return <View><ThemeContext.Provider value={theme}><Text/></ThemeContext.Provider></View>;', "wrap the whole root"],
  ['return <ThemeContext.Provider value={theme()}><Text/></ThemeContext.Provider>;', "without calling it"],
  ['return <View/>; reset();', "final component statement"],
])("rejects unsupported TSX: %s", (body, diagnostic) => {
  expect(() => analyze(body)).toThrow(diagnostic);
});

test.each([
  ['import { For as StockFor } from "solid-js";', "instead of solid-js For"],
  ['import { createSignal } from "solid-js";', "belong to the basename module"],
  ['import { onMount } from "solid-js";', "belong to the basename module"],
  ['import { Modal } from "@pocketjs/framework/solid/components";', "Modal has no native runtime"],
  ['import Child from "./Child";', "require the .tsx extension"],
  ['export const value = 1;', "one default-exported function"],
  ['const value = 1;', "one default-exported function"],
])("rejects unsupported imports/top-level statements: %s", (extra, diagnostic) => {
  expect(() => analyze("return <View/>;", extra)).toThrow(diagnostic);
});

test.each([
  ["\n  Vue SFC Feature Lab\n", "Vue SFC Feature Lab"],
  ["\n  first line\n  second line\n", "first line second line"],
  ["a\n\n b", "a b"],
  ["\t a\t b\r\n\t c\r\n", " a b c"],
  [" leading and trailing ", " leading and trailing "],
  ["\n \n", ""],
])("JSX text uses Babel normalization: %j", (source, expected) => {
  expect(normalizeJsxText(source)).toBe(expected);
  const output = transformSync(`const x = <Text>${source}</Text>`, { presets: [[solid, { generate: "universal", moduleName: "renderer" }]], configFile: false, babelrc: false })!.code!;
  if (expected) expect(output).toContain(JSON.stringify(expected));
  else expect(output).not.toContain("children:");
});

test("JSX literal expressions merge adjacent text without changing whitespace", () => {
  const program = analyze('return <Text>a{" "}b</Text>;');
  const text = program.components.at(-1)!.nodes[0]!;
  expect(text.kind === "element" && text.text?.parts).toEqual(["a b"]);
});

function sourceProgram(source: string, files: Record<string, string> = {}) {
  return analyzeSolidAot(entry, { strict: true, sources: new Map([[entry, source], [modulePath, model], ...Object.entries(files).map(([name, content]) => [resolve(entry, "../" + name), content] as [string,string])]) });
}
test("a setter pairs with its module's Accessor even when only the setter is imported", () => {
  const program = sourceProgram(`import { View } from "@pocketjs/framework/solid/components"; import { setCount } from "./App";
    export default function App() { return <View focusable onPress={() => setCount(1)}/>; }`);
  expect(program.components[0]!.values).toMatchObject([{ name: "count", writable: true }]);
});

test("Accessor alias chains are signals while plain zero-argument functions remain methods", () => {
  const program = sourceProgram(`import { Text } from "@pocketjs/framework/solid/components"; import { signal, read } from "./App";
    export default function App() { return <Text>{signal()}/{read()}</Text>; }`, {
      "App.d.ts": 'import type { Accessor } from "solid-js"; import type { i32 } from "@pocketjs/framework/solid/std"; type Read<T> = Accessor<T>; type Again<T> = Read<T>; export declare const signal: Again<i32>; export declare const read: () => i32;',
    });
  expect(program.components[0]!.values.map(v => v.name)).toEqual(["signal"]);
  expect(program.components[0]!.functions.map(v => v.name)).toEqual(["read"]);
});

test("setter pairs must match the source name and type", () => {
  expect(() => sourceProgram(`${imports}export default function App() { return <View/>; }`, {
    "App.d.ts": model.replace("setCount: Setter<i32>", "setCount: Setter<string>"),
  })).toThrow("must pair with an Accessor of the same type");
});

test("mergeProps defaults and StyleClass props lower at the parent boundary", () => {
  const program = analyze('return <Chip tone={enabled() ? "p-2 bg-blue-600" : "p-2 bg-red-600"}/>;', 'import Chip from "./Chip.tsx";', {
    "Chip.tsx": 'import { View, Text } from "@pocketjs/framework/solid/components"; import { mergeProps } from "solid-js"; import type { StyleClass } from "@pocketjs/framework/solid/std"; export default function Chip(raw: { tone: StyleClass; label?: string }) { const props = mergeProps({ label: "LABEL" }, raw); return <View class={props.tone}><Text>{props.label}</Text></View>; }',
  });
  const chip = program.components.find(c => c.name === "Chip")!;
  expect(chip.props.find(p => p.name === "label")).toMatchObject({ type: { kind: "string" }, default: "LABEL" });
  const instance = program.components.find(c => c.root)!.nodes[0]!;
  expect(instance.kind).toBe("component");
  if (instance.kind !== "component") throw new Error();
  const tone = instance.props.find(p => p.name === "tone")!.value;
  expect(tone.kind === "conditional" && tone.consequent.kind === "literal" && typeof tone.consequent.value).toBe("number");
});

test("props are reactive getters and cannot be destructured", () => {
  expect(() => sourceProgram('import { Text } from "@pocketjs/framework/solid/components"; export default function App(props: { label: string }) { const { label } = props; return <Text>{label}</Text>; }')).toThrow("destructuring is outside the view subset");
});

test.each([
  ['export default (props: {}) => <View/>;', "one default-exported function"],
  ['const App = () => <View/>; export default App;', "one default-exported function"],
  ['export default function App(props: {} = {}) { return <View/>; }', "without a default"],
  ['export default function App(props: {}, more: {}) { return <View/>; }', "one props parameter"],
  ['export default function App(props) { return <View/>; }', "object type annotation"],
])("rejects component declaration %s", (source, diagnostic) => {
  expect(() => sourceProgram(`import { View } from "@pocketjs/framework/solid/components"; ${source}`)).toThrow(diagnostic);
});

test.each([
  ['onPress={() => props.onSaved(1)}', "Optional callbacks must use"],
  ['onPress={() => { props.onSaved?.(1); props.onSaved?.(2); }}', "final statement"],
  ['onPress={() => { if (true) props.onSaved?.(1); props.onSaved?.(2); }}', "final statement"],
])("rejects callback evaluation form %s", (attribute, diagnostic) => {
  expect(() => analyze('return <Child/>;', 'import Child from "./Child.tsx";', {
    "Child.tsx": `import { View } from "@pocketjs/framework/solid/components"; import type { i32 } from "@pocketjs/framework/solid/std"; export default function Child(props: { onSaved?: (id: i32) => void }) { return <View focusable ${attribute}/>; }`,
  })).toThrow(diagnostic);
});

test("required callbacks must be passed by every parent", () => {
  expect(() => analyze('return <Child/>;', 'import Child from "./Child.tsx";', {
    "Child.tsx": 'import { View } from "@pocketjs/framework/solid/components"; export default function Child(props: { onSaved: () => void }) { return <View focusable onPress={() => props.onSaved()}/>; }',
  })).toThrow("Missing required Child callback onSaved");
});

test("generic scoped slots infer concrete props and preserve Accessor boundaries", () => {
  const program = analyze('return <List items={items()} row={({ item: row }) => <Text>{row().label}</Text>}/>;', 'import List from "./List.tsx";', {
    "List.tsx": 'import { For, View } from "@pocketjs/framework/solid/components"; import type { Accessor, JSX } from "solid-js"; export default function List<T extends { id: string }>(props: { items: T[]; row: (args: { item: Accessor<T> }) => JSX.Element }) { return <View><For each={props.items} by={item => item.id}>{item => props.row({ item })}</For></View>; }',
  });
  const list = program.components.find(c => c.name === "ListInstance1")!;
  expect(list.slotProps?.[0]?.parameters).toEqual([{ name: "item", type: { kind: "named", name: "Item" } }]);
  expect(flatten(list.nodes).at(-1)?.kind).toBe("slot");
});

test("scoped slot calls pass Accessors, not snapshots", () => {
  expect(() => analyze('return <List items={items()} row={({ item }) => <Text>{item().label}</Text>}/>;', 'import List from "./List.tsx";', {
    "List.tsx": 'import { For } from "@pocketjs/framework/solid/components"; import type { Accessor, JSX } from "solid-js"; export default function List<T extends { id: string }>(props: { items: T[]; row: (args: { item: Accessor<T> }) => JSX.Element }) { return <For each={props.items} by={item => item.id}>{item => props.row({ item: item() })}</For>; }',
  })).toThrow("without calling them");
});

test("context must have one root provider", () => {
  expect(() => analyze('return <Child/>;', 'import Child from "./Child.tsx";', {
    "Child.tsx": 'import { Text } from "@pocketjs/framework/solid/components"; import { useContext } from "solid-js"; import { ThemeContext } from "./App"; export default function Child() { const theme = useContext(ThemeContext)!; return <Text>{theme().label}</Text>; }',
  })).toThrow("No root provide");
});

test("derived closures keep module bindings when a For parameter shadows the name", () => {
  const program = analyze('const readCount = () => count(); return <For each={items()} by={item => item.id}>{count => <Text>{readCount()}</Text>}</For>;');
  const node = flatten(program.components.find(c => c.root)!.nodes).find(n => n.kind === "element")!;
  expect(node.kind === "element" && node.text?.parts[0]).toMatchObject({ kind: "binding", name: "count", scope: "vm" });
});

test("multiargument callbacks bind each payload once under a distinct event alias", () => {
  const program = analyze('return <Child onSaved={(first, second) => adjust(first + second)}/>;', 'import Child from "./Child.tsx";', {
    "Child.tsx": 'import { View } from "@pocketjs/framework/solid/components"; import type { i32 } from "@pocketjs/framework/solid/std"; export default function Child(props: { onSaved: (first: i32, second: i32) => void }) { return <View focusable onPress={() => props.onSaved(1, 2)}/>; }',
  });
  const instance = program.components.find(c => c.root)!.nodes[0]!;
  if (instance.kind !== "component") throw new Error();
  const action = instance.events[0]!.handler;
  if (action.kind !== "call" || action.expression.kind !== "call") throw new Error();
  expect(action.expression.arguments[0]).toMatchObject({ kind: "binary", left: { name: "$event", scope: "event" }, right: { name: "$event1", scope: "event" } });
});

test("reactive values cross model boundaries as Accessors", () => {
  expect(() => sourceProgram('import { Text } from "@pocketjs/framework/solid/components"; import { value } from "./App"; export default function App() { return <Text>{value}</Text>; }', {
    "App.d.ts": 'import type { i32 } from "@pocketjs/framework/solid/std"; export declare const value: i32;',
  })).toThrow("cross the boundary as Accessor");
});

test("required slots cannot be omitted", () => {
  expect(() => analyze('return <Child/>;', 'import Child from "./Child.tsx";', {
    "Child.tsx": 'import { View } from "@pocketjs/framework/solid/components"; import type { JSX } from "solid-js"; export default function Child(props: { children: JSX.Element }) { return <View>{props.children}</View>; }',
  })).toThrow("Missing required Child slot default");
});

test("For keys cannot be asynchronous", () => {
  expect(() => analyze('return <For each={items()} by={async item => item.id}>{item => <Text>{item().label}</Text>}</For>;')).toThrow("one-parameter key expression");
});

test("local JSX tag bindings cannot impersonate imported host primitives", () => {
  expect(() => analyze('return <For each={items()} by={item => item.id}>{Text => <Text/>}</For>;')).toThrow("shadowed by a local binding");
});

test("local row values cannot impersonate imported BTN constants", () => {
  expect(() => analyze('return <For each={items()} by={item => item.id}>{BTN => <ActionHandler button={BTN.CROSS} onPress={reset}/>}</For>;')).toThrow("static member of BTN imported");
});

test("class ternaries cannot mix StyleClass props with literal leaves", () => {
  expect(() => sourceProgram('import { View } from "@pocketjs/framework/solid/components"; import type { StyleClass } from "@pocketjs/framework/solid/std"; export default function App(props: { tone: StyleClass; enabled: boolean }) { return <View class={props.enabled ? props.tone : "bg-red-600"}/>; }')).toThrow("full class literal leaves");
});

test("Switch accepts a self-closing empty Match branch", () => {
  const program = analyze('return <Switch fallback={<Text>fallback</Text>}><Match when={enabled()}/></Switch>;');
  const node = program.components.find(c => c.root)!.nodes[0]!;
  expect(node.kind === "if" && node.branches[0]!.children).toEqual([]);
});
