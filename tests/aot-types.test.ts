import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { resolve } from "node:path";
import { createTypeEnvironment, location, TypeMapper, solidTypeAlias } from "../vapor/compiler/aot-types.ts";

function fixture(source: string) {
  const file = resolve(import.meta.dir, "fixtures/aot/type-probe.tsx");
  const environment = createTypeEnvironment(new Map([[file, source]]));
  const ast = environment.program.getSourceFile(file)!;
  const module = environment.checker.getSymbolAtLocation(ast)!;
  const types = new Map(environment.checker.getExportsOfModule(module).map(symbol => [symbol.name, environment.checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? symbol.declarations![0]!) ]));
  return { file, environment, ast, types, mapper: new TypeMapper(environment.checker, true) };
}
describe("Solid contract types", () => {
  test("recognizes signal tuple elements and follows alias chains without structural guessing", () => {
    const { types, environment, mapper, file } = fixture(`
import { createSignal } from "solid-js";
import type { Accessor, Setter } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";
type Read<T> = Accessor<T>; type Again<T> = Read<T>; type Write<T> = Setter<T>;
export const [count, setCount] = createSignal<i32>(0);
export declare const value: Again<i32>;
export declare const setValue: Write<i32>;
export declare const method: () => i32;
`);
    for (const name of ["count", "value"]) expect(mapper.map(types.get(name)!, location(file, ""), name)).toEqual({ kind: "number", name: "i32" });
    for (const name of ["setCount", "setValue"]) expect(environment.checker.typeToString(solidTypeAlias(types.get(name)!, "Setter", environment.checker)!)).toBe("i32");
    expect(solidTypeAlias(types.get("method")!, "Accessor", environment.checker)).toBeUndefined();
  });
  test("native TSX nodes retain file offsets and source locations", () => {
    const source = 'export default function App(props: { label: string }) {\n return <Text>{props.label}</Text>;\n}';
    const { file, environment } = fixture(source);
    const node = environment.nodeAt(file, source.indexOf("label}</"), 5)!;
    expect(node.getText()).toBe("label");
    expect(environment.locationOf(node)).toEqual(location(file, source, source.indexOf("label}</")));
    expect(environment.checker.typeToString(environment.typeAt(file, source.indexOf("label}</"))!)).toBe("string");
  });
  test("virtual imported contract modules participate in the checker", () => {
    const entry = resolve(import.meta.dir, "fixtures/aot/virtual/App.tsx"), module = resolve(import.meta.dir, "fixtures/aot/virtual/App.d.ts");
    const source = 'import { count } from "./App"; export default function App() { return <Text>{count()}</Text>; }';
    const e = createTypeEnvironment(new Map([[entry, source], [module, 'import type { Accessor } from "solid-js"; import type { i32 } from "@pocketjs/framework/solid/std"; export declare const count: Accessor<i32>;']]));
    const type = e.typeAt(entry, source.indexOf("count }"))!;
    expect(e.checker.typeToString(solidTypeAlias(type, "Accessor", e.checker)!)).toBe("i32");
  });
});
