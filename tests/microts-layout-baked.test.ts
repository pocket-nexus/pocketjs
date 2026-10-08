// `layout-baked` / `contain-strict`: the compiler solves a baked subtree once
// in the no_std wasm core and emits constant rects; violations are errors that
// name the node and the rule. Run: bun test tests/microts-layout-baked.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bakeAtlases } from "../framework/compiler/bake-font.ts";
import { analyzeAot, buildAot } from "../microts/compiler/aot-build.ts";
import { emitAot } from "../microts/compiler/aot-codegen.ts";
import { AotCompileError } from "../microts/compiler/aot-ir.ts";
import type { LayoutEnvironment } from "../microts/compiler/aot-layout-plan.ts";
import { analyzeSolidAot } from "../microts/compiler/aot-solid-frontend.ts";

const root = resolve(import.meta.dir, "..");
const fixture = resolve(root, "tests/fixtures/aot/layout-baked");
const wasmPath = resolve(root, "hosts/web/pocketjs.wasm");

async function environment(slots: number[]): Promise<LayoutEnvironment> {
  if (!existsSync(wasmPath)) {
    const build = Bun.spawnSync([process.execPath, "tools/wasm.ts"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  }
  const atlases = await bakeAtlases({ codepoints: [], slots });
  return { viewport: [240, 160], fontAtlases: atlases.map(atlas => atlas.bytes), wasm: readFileSync(wasmPath) };
}

describe("layout-baked", () => {
  test("the fixture bakes every rect the core would solve and keeps the live islands", async () => {
    const program = analyzeAot(resolve(fixture, "app.tsx"), { strict: true });
    const outDir = mkdtempSync(join(tmpdir(), "layout-baked-"));
    const result = await buildAot(fixture, { outDir, strict: true, format: false, layoutEnvironment: await environment(program.styles.usedFontSlots) });
    const rust = readFileSync(join(outDir, "app.rs"), "utf8");
    expect(result.layout.regions).toEqual([{ name: "Page", file: resolve(fixture, "app.tsx"), line: 9, nodes: 11, formulas: 1, islands: 1, layers: [] }]);
    // The page fills the viewport; absolute children sit at their insets.
    expect(rust).toContain("ui.set_layout_static(node, 0f32, 0f32, 240f32, 160f32)");
    expect(rust).toContain("ui.set_layout_static(node, 200f32, 58f32, 32f32, 32f32)");
    expect(rust).toContain("ui.set_layout_static(node, 100f32, 123f32, 82f32, 15f32)");
    expect(rust).toContain("ui.set_layout_static(node, 0f32, 0f32, 82f32, 15f32)");
    expect(rust).toContain("ui.set_layout_static(node, 8f32, 145f32, 224f32, 15f32)");
    expect(rust).toContain("ui.set_layout_static(node, 0f32, 0f32, 224f32, 15f32)");
    // Text measured by the baked atlas: one 14 px bold line at the header inset.
    expect(rust).toMatch(/ui\.set_layout_static\(node, 40f32, 7f32, \d+f32, \d+f32\)/);
    // The underline animates its width: a formula leaf, no table entry.
    expect(rust).toContain("ui.set_layout_formula(node)");
    expect(rust.match(/set_layout_formula\(/g)).toHaveLength(1);
    // Static: Page, Header, header text, Spinner, Action, action text, Counter, counter text, Message, message text.
    expect(rust.match(/set_layout_static\(/g)).toHaveLength(10);
    // The spinner image lives inside a contain-strict island: no placement call.
    const image = rust.slice(rust.indexOf('set_image_asset(node, "spinner-00.svg")') - 400, rust.indexOf('set_image_asset(node, "spinner-00.svg")'));
    expect(image).not.toContain("set_layout_");
    // Placement precedes the insert, so the insert under a static parent costs nothing.
    expect(rust.indexOf("set_layout_static(node, 200f32")).toBeLessThan(rust.indexOf("insert_before(parent, node, anchor)", rust.indexOf("set_layout_static(node, 200f32")));
  });

  test("sprite layers: one recipe per named dynamic subtree", async () => {
    const program = analyzeAot(resolve(fixture, "app.tsx"), { strict: true });
    const layoutEnvironment = { ...(await environment(program.styles.usedFontSlots)), spriteLayers: true, tickRate: 30 };
    const layers = emitAot(program, { layoutEnvironment }).layout.regions[0]!.layers;
    expect(layers.map(layer => [layer.name, layer.recipe.kind, layer.rect, layer.island, layer.translate])).toEqual([
      ["Spinner", "branches", [200, 58, 32, 32], true, false],
      ["Underline", "size", [8, 87, 0, 3], false, true],
      ["Action", "color", [8, 118, 80, 24], false, false],
      ["Counter", "text", [100, 123, 82, 15], false, false],
      ["Message", "branches", [8, 145, 224, 15], false, false],
    ]);
    const [spinner, underline, action, counter, message] = layers;
    expect(spinner!.recipe).toMatchObject({ kind: "branches", branches: [{ signature: { style: expect.any(Number), src: "spinner-00.svg" }, nodes: [{ parent: -1, tag: "Image", nodeType: 2, rect: null, src: "spinner-00.svg" }] }] });
    // 0 from `w-0`, 144 from the model's animate literal.
    expect(underline!.recipe).toEqual({ kind: "size", node: [], prop: "width", range: [0, 144] });
    // base and focus colors, sampled once per 30 Hz tick a 150 ms transition can show.
    expect(action!.recipe).toMatchObject({ kind: "color", node: [], steps: 2 });
    expect((action!.recipe as { endpoints: number[] }).endpoints).toHaveLength(2);
    expect(counter!.recipe).toEqual({ kind: "text", node: [0], prefix: "Count: ", glyphs: "0123456789-", maxLength: 11, fontSlot: 0 });
    expect(message!.recipe).toMatchObject({ kind: "branches", branches: [{ signature: { text: "Reactive" }, nodes: [{ parent: -1, tag: "Text", rect: [0, 0, 224, 15], text: "Reactive" }] }] });
  });

  test("a baked subtree without an environment is an error", () => {
    const program = analyzeAot(resolve(fixture, "app.tsx"), { strict: true });
    expect(() => emitAot(program)).toThrow(/layout environment/);
  });
});

function solid(body: string, model = "export declare const count: Accessor<i32>; export declare const open: Accessor<boolean>; export declare const items: Accessor<i32[]>;"): ReturnType<typeof analyzeSolidAot> {
  const entry = resolve(root, "tests/fixtures/aot/layout-baked-variants/App.tsx");
  const source = `import { Show } from "solid-js"; import { For, Image, Text, View } from "@pocketjs/framework/solid/components"; import { count, open, items } from "./App";
export default function App() { return (${body}); }`;
  const sources = new Map([[entry, source], [resolve(entry, "../App.d.ts"), `import type { i32 } from "@pocketjs/framework/solid/std"; import type { Accessor } from "solid-js";\n${model}`]]);
  return analyzeSolidAot(entry, { sources, strict: true });
}

describe("layout-baked rules", () => {
  const cases: [string, string, RegExp][] = [
    ["a Show branch that is not absolute", `<View class="w-full h-full layout-baked"><Show when={open()}><View class="w-[10] h-[10]" /></Show></View>`, /Show branch .* absolutely positioned/],
    ["dynamic text without a fixed cell", `<View class="w-full h-full layout-baked"><Text class="text-xs">{count()}</Text></View>`, /dynamic text .* fixed cell/],
    ["a list", `<View class="w-full h-full layout-baked"><For each={items()} by={item => item}>{item => <Text class="text-xs">{item()}</Text>}</For></View>`, /<For> list/],
    ["a focus variant that changes layout", `<View class="w-full h-full layout-baked"><View class="w-[10] h-[10] focus:w-[20]" focusable /></View>`, /focus: variant changes layout props \(width\)/],
    ["a width binding on a flex child", `<View class="w-full h-full layout-baked"><View class="h-[10]" style={{ width: count() }} /></View>`, /only an absolutely positioned leaf/],
    ["a size binding on a node with children", `<View class="w-full h-full layout-baked"><View class="absolute left-[1] top-[1] h-[10]" style={{ width: count() }}><Text class="text-xs">x</Text></View></View>`, /childless View or Image/],
    ["layout-baked under a live parent", `<View class="w-full h-full"><View class="w-[10] h-[10] layout-baked" /></View>`, /under a live parent/],
    ["contain-strict without a size", `<View class="w-full h-full layout-baked"><View class="contain-strict"><Text class="text-xs">x</Text></View></View>`, /contain-strict .* constant width and height/],
  ];
  test.each(cases)("%s is rejected", async (_name, body, message) => {
    const program = solid(body);
    const layoutEnvironment = await environment(program.styles.usedFontSlots);
    let error: unknown;
    try { emitAot(program, { layoutEnvironment }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AotCompileError);
    expect((error as AotCompileError).message).toMatch(message);
    expect((error as AotCompileError).diagnostics[0]!.line).toBeGreaterThan(0);
  });

  const spriteCases: [string, string, RegExp][] = [
    ["dynamic paint without a named ancestor", `<View class="w-full h-full layout-baked"><View class="absolute left-[1] top-[1] w-[10] h-[10]" style={{ opacity: open() ? 1 : 0 }} /></View>`, /needs a debugName/],
    ["a layer inside a layer", `<View class="w-full h-full layout-baked"><View debugName="Outer" class="absolute left-[1] top-[1] w-[50] h-[50]" style={{ opacity: open() ? 1 : 0 }}><View debugName="Inner" class="absolute left-[1] top-[1] w-[10] h-[10]" style={{ opacity: open() ? 0 : 1 }} /></View></View>`, /cannot sit inside layer "Outer"/],
    ["two recipes on one layer", `<View class="w-full h-full layout-baked"><View debugName="Both" class="absolute left-[1] top-[1] w-[10] h-[10]" style={{ opacity: open() ? 1 : 0, width: count() }} /></View>`, /one state recipe/],
    ["a binding with no recipe", `<View class="w-full h-full layout-baked"><View debugName="Spin" class="absolute left-[1] top-[1] w-[10] h-[10]" style={{ rotate: count() }} /></View>`, /no sprite layer recipe/],
    ["a width binding with no literal range", `<View class="w-full h-full layout-baked"><View debugName="Bar" class="absolute left-[1] top-[1] h-[10]" style={{ width: count() }} /></View>`, /declare it in gba-layers.json/],
  ];
  test.each(spriteCases)("sprite layers: %s is rejected", async (_name, body, message) => {
    const program = solid(body);
    const layoutEnvironment = { ...(await environment(program.styles.usedFontSlots)), spriteLayers: true };
    let error: unknown;
    try { emitAot(program, { layoutEnvironment }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AotCompileError);
    expect((error as AotCompileError).message).toMatch(message);
  });

  test("an app without layout-baked needs no environment and emits no placement", () => {
    const program = solid(`<View class="w-full h-full"><Text class="text-xs">{count()}</Text></View>`);
    const rust = emitAot(program).files["app.rs"]!;
    expect(rust).not.toContain("set_layout_");
  });
});
