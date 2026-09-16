import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeSolidAot } from "../vapor/compiler/aot-solid-frontend.ts";
import { checkSolidAotGraph, generateSolidAotMock, getSolidAotProgram, resolveSolidAotMock, resolveSolidAotModel } from "../vapor/compiler/aot-solid-browser.ts";
import { normalizeSolidAotSemantics } from "../vapor/compiler/aot-solid-semantics.ts";
import { jsxPlugin, transformFile } from "../framework/compiler/jsx-plugin.ts";

let sequence = 0;
function fixture(files: Record<string, string>, aot = true) {
  const root = resolve(".pocket-build/validation/solid-aot/browser", `${Date.now()}-${sequence++}`);
  mkdirSync(root, { recursive: true });
  for (const [name, source] of Object.entries(files)) writeFileSync(resolve(root, name), source);
  writeFileSync(resolve(root, "pocket.json"), JSON.stringify({ app: { framework: "solid", aot, entry: "main.tsx" } }));
  return root;
}
const imports = 'import { Text, View } from "@pocketjs/framework/solid/components";';
const main = 'import App from "./App.tsx"; export default App;';

test("ordinary Solid basename imports do not opt into AOT admission", async () => {
  const source = imports + 'import { createSignal } from "solid-js"; export default function App() { const [x] = createSignal(1); return <Text>{x()}</Text>; }';
  const root = fixture({ "main.tsx": main, "App.tsx": source }, false);
  expect(getSolidAotProgram(resolve(root, "App.tsx"), source)).toBeUndefined();
  expect((await transformFile(resolve(root, "App.tsx"), source, "solid")).code).toContain("createSignal");
});
test("admission traverses pure children and invalidates warm transforms on model changes", async () => {
  const source = imports + 'import { count } from "./App"; import Child from "./Child.tsx"; export default function App() { return <View><Text>{count()}</Text><Child /></View>; }';
  const root = fixture({ "main.tsx": main, "App.tsx": source, "App.d.ts": 'import type { Accessor } from "solid-js"; export declare const count: Accessor<string>;', "Child.tsx": imports + 'export default function Child() { return <Text>child</Text>; }' });
  expect((await transformFile(resolve(root, "App.tsx"), source, "solid")).code).toContain("child");
  writeFileSync(resolve(root, "Child.tsx"), imports + 'export default function Child() { return <div />; }');
  expect(() => checkSolidAotGraph(resolve(root, "main.tsx"))).toThrow("not an imported host primitive");
  writeFileSync(resolve(root, "Child.tsx"), imports + 'export default function Child() { return <Text>child</Text>; }');
  writeFileSync(resolve(root, "App.d.ts"), 'import type { Accessor } from "solid-js"; export declare const count: Accessor<boolean>;');
  await expect(transformFile(resolve(root, "App.tsx"), source, "solid")).rejects.toThrow("Boolean");
});
test("declaration previews create signals and resolve the whole graph through the standard build", async () => {
  const root = fixture({ "main.tsx": main, "App.tsx": imports + 'import { count, setCount } from "./App"; export default function App() { return <View focusable onPress={() => setCount(count() + 1)}><Text>{count()}</Text></View>; }', "App.d.ts": 'import type { Accessor, Setter } from "solid-js"; import type { i32 } from "@pocketjs/framework/solid/std"; export declare const count: Accessor<i32>; export declare const setCount: Setter<i32>;' });
  const entry = resolve(root, "App.tsx"), program = analyzeSolidAot(entry, { strict: true });
  const mock = generateSolidAotMock(program, program.components.find(c => c.root)!);
  expect(mock).toContain("createSignal(0)"); expect(mock).toContain("export const setCount");
  expect(resolveSolidAotMock(entry, "./App")).toBe(mock);
  const result = await Bun.build({ entrypoints: [resolve(root, "main.tsx")], target: "browser", plugins: [jsxPlugin("solid")] });
  expect(result.success, result.logs.map(String).join("\n")).toBe(true);
});
test("model modules are resolved before homonymous TSX views", () => {
  const root = fixture({ "main.tsx": main, "App.tsx": imports + 'import { count } from "./App"; export default function App() { return <Text>{count()}</Text>; }', "App.ts": 'import { createSignal } from "solid-js"; export const [count] = createSignal("value");' });
  expect(resolveSolidAotModel(resolve(root, "App.tsx"), "./App")).toBe(resolve(root, "App.ts"));
});
test("Color text, equality and derived colors normalize against their source locations", () => {
  const root = fixture({ "main.tsx": main, "App.tsx": imports + 'import { color } from "./App"; export default function App() { const derived = () => color(); return <Text>{derived()}:{color() === "#FFF" ? "yes" : "no"}:{`${color()}`}</Text>; }', "App.d.ts": 'import type { Accessor } from "solid-js"; import type { Color } from "@pocketjs/framework/solid/std"; export declare const color: Accessor<Color>;' });
  const file = resolve(root, "App.tsx");
  const program = analyzeSolidAot(file, { strict: true });
  const normalized = normalizeSolidAotSemantics(readFileSync(file, "utf8"), file, program);
  expect(normalized).toContain("__pocketColorText(derived())");
  expect(normalized).toContain('__pocketColorBits(color()) === __pocketColorBits("#FFF")');
  expect(normalized).toContain('__pocketColorText(color(), "undefined")');
});

test("declaration preview imports share one context and signal module across parent and child", async () => {
  const bootstrap = `import App from "./App.tsx";
    import { render } from "@pocketjs/framework/solid";
    import { rootMirror } from "@pocketjs/framework/solid/renderer";
    let next = 2; const noop = () => {};
    const dispose = render(() => <App/>, { styles: {}, ops: {
      createNode: () => next++, destroyNode: noop, insertBefore: noop, removeChild: noop,
      setStyle: noop, setProp: noop, setText: noop, replaceText: noop, uploadTexture: () => 0,
      setImage: noop, setSprite: noop, animate: () => 1, cancelAnim: noop, setFocus: noop, measureText: () => 0
    } });
    const text = (node: typeof rootMirror): string => (node.text ?? "") + node.children.map(text).join("");
    export const snapshot = text(rootMirror); dispose();`;
  const root = fixture({
    "main.tsx": bootstrap,
    "App.tsx": 'import { ThemeContext, theme } from "./App"; import Child from "./Child.tsx"; export default function App() { return <ThemeContext.Provider value={theme}><Child/></ThemeContext.Provider>; }',
    "App.d.ts": 'import type { Accessor, Context } from "solid-js"; export interface Theme { label: string }; export declare const theme: Accessor<Theme>; export declare const ThemeContext: Context<Accessor<Theme> | undefined>;',
    "Child.tsx": 'import { Text } from "@pocketjs/framework/solid/components"; import { useContext } from "solid-js"; import { ThemeContext } from "./App"; export default function Child() { const theme = useContext(ThemeContext)!; return <Text>context:{theme().label}</Text>; }',
  });
  const result = await Bun.build({ entrypoints: [resolve(root, "main.tsx")], target: "browser", plugins: [jsxPlugin("solid")] });
  expect(result.success, result.logs.map(String).join("\n")).toBe(true);
  const code = await result.outputs[0]!.text();
  expect(code.match(/ThemeContext\d* = createContext\(/g)).toHaveLength(1);
  const output = resolve(root, "context-bundle.mjs"); writeFileSync(output, code);
  const executed = await import(output);
  expect(executed.snapshot).toBe("context:");
});

test("uppercase views resolve lowercase basename declaration modules", async () => {
  const root = fixture({
    "main.tsx": main,
    "App.tsx": imports + 'import { count } from "./app"; export default function App() { return <Text>{count()}</Text>; }',
    "app.d.ts": 'import type { Accessor } from "solid-js"; export declare const count: Accessor<string>;',
  });
  const file = resolve(root, "App.tsx");
  expect(resolveSolidAotModel(file, "./app")).toBe(resolve(root, "app.d.ts"));
  expect(resolveSolidAotMock(file, "./app")).toContain("createSignal");
  const result = await Bun.build({ entrypoints: [resolve(root, "main.tsx")], target: "browser", plugins: [jsxPlugin("solid")] });
  expect(result.success, result.logs.map(String).join("\n")).toBe(true);
});

test("root factories export their context objects at module scope", async () => {
  const bootstrap = `import App from "./App.tsx";
    import { render } from "@pocketjs/framework/solid";
    import { rootMirror } from "@pocketjs/framework/solid/renderer";
    let next = 2; const noop = () => {};
    const dispose = render(() => <App/>, { styles: {}, ops: {
      createNode: () => next++, destroyNode: noop, insertBefore: noop, removeChild: noop,
      setStyle: noop, setProp: noop, setText: noop, replaceText: noop, uploadTexture: () => 0,
      setImage: noop, setSprite: noop, animate: () => 1, cancelAnim: noop, setFocus: noop, measureText: () => 0
    } });
    const text = (node: typeof rootMirror): string => (node.text ?? "") + node.children.map(text).join("");
    export const snapshot = text(rootMirror); dispose();`;
  const root = fixture({
    "main.tsx": bootstrap,
    "App.tsx": 'import { ThemeContext, createApp } from "./App"; import Child from "./Child.tsx"; export default function App() { const { theme } = createApp(); return <ThemeContext.Provider value={theme}><Child/></ThemeContext.Provider>; }',
    "App.d.ts": 'import type { Accessor, Context } from "solid-js"; export interface Theme { label: string }; export declare function createApp(): { theme: Accessor<Theme> }; export declare const ThemeContext: Context<Accessor<Theme> | undefined>;',
    "Child.tsx": 'import { Text } from "@pocketjs/framework/solid/components"; import { useContext } from "solid-js"; import { ThemeContext } from "./App"; export default function Child() { const theme = useContext(ThemeContext)!; return <Text>factory context:{theme().label}</Text>; }',
  });
  const mock = resolveSolidAotMock(resolve(root, "App.tsx"), "./App")!;
  expect(mock.indexOf("export const ThemeContext")).toBeLessThan(mock.indexOf("export function createApp"));
  const result = await Bun.build({ entrypoints: [resolve(root, "main.tsx")], target: "browser", plugins: [jsxPlugin("solid")] });
  expect(result.success, result.logs.map(String).join("\n")).toBe(true);
  const code = await result.outputs[0]!.text();
  expect(code.match(/ThemeContext\d* = createContext\(/g)).toHaveLength(1);
  const output = resolve(root, "factory-context-bundle.mjs"); writeFileSync(output, code);
  expect((await import(output)).snapshot).toBe("factory context:");
});
