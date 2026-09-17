// micro/tests/compiler.test.ts — the Micro TS frontend and Rust emitter.
//
// The hero demo is the acceptance fixture: its IR shape is pinned here, the
// emitted Rust is asserted at the constructs that carry the compiler's
// decisions, and subset violations report file:line:column diagnostics.
//
// No generated artifact is committed, so nothing here compares against a
// checked-in file. What proves the emitter end to end is parity.test.ts:
// it compiles the output with cargo and compares rendered pixels against
// stock Solid.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { compileClasses } from "../../framework/compiler/tailwind.ts";
import { emitRust } from "../compiler/emit-rust.ts";
import { cleanJsxText, compileMicro, MicroCompileError } from "../compiler/frontend.ts";
import { walkNodes, type ElementNode, type Program } from "../compiler/ir.ts";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const HERO = resolve(ROOT, "apps/hero/main.tsx");

function elements(p: Program): ElementNode[] {
  const out: ElementNode[] = [];
  walkNodes(p.root, (n) => {
    if (n.k === "element") out.push(n);
  });
  return out;
}

describe("hero", () => {
  const program = compileMicro(HERO);

  test("lowers the component to one int signal, one effect, one mount hook and one handler", () => {
    expect(program.component).toBe("Hero");
    expect(program.signals).toEqual([{ id: 0, name: "count", ty: "int", init: { k: "int", v: 0 } }]);
    expect(program.effects).toHaveLength(1);
    expect(program.effects[0].deps).toEqual([0]);
    expect(program.mounts).toHaveLength(1);
    expect(program.mounts[0].body[0]).toMatchObject({ k: "animate", prop: "width", propId: 1, easing: 2 });
    expect(program.setupOrder).toEqual([{ kind: "effect", id: 0 }, { kind: "mount", id: 0 }]);
    expect(program.handlers).toHaveLength(1);
    expect(program.handlers[0].body).toEqual([
      { k: "set", signal: 0, e: { k: "binary", op: "+", l: { k: "signal", id: 0, ty: "int" }, r: { k: "int", v: 1 }, ty: "int" } },
    ]);
  });

  test("folds root props and inlines the Stat component", () => {
    const els = elements(program);
    expect(program.elements).toBe(31);
    expect(program.shows).toBe(1);
    // Every `props.largeLayout ? a : b` collapsed to its small arm.
    for (const el of els) if (el.class) expect(el.class.deps).toEqual([]);
    expect(program.assets.classes).not.toContain("text-5xl text-slate-950 font-bold");
    // Stat inlined three times with its props substituted.
    const stats = els.filter((e) => e.origin === "Stat:<Text>" && e.text);
    expect(stats.map((e) => e.text!.expr)).toEqual(
      expect.arrayContaining([{ k: "str", v: "60" }, { k: "str", v: "FPS" }, { k: "str", v: "42" }, { k: "str", v: "9" }]),
    );
    // frameworkName() + the ?? default fold into one static run.
    expect(els.find((e) => e.text?.expr.k === "str" && e.text.expr.v === "Solid + RUST + SCEGU")).toBeDefined();
  });

  test("keeps the reactive bindings and the conditional block", () => {
    const els = elements(program);
    const count = els.find((e) => e.text && e.text.deps.length > 0)!;
    expect(count.text!.expr).toEqual({ k: "concat", parts: [{ k: "str", v: "Count: " }, { k: "tostr", e: { k: "signal", id: 0, ty: "int" } }] });
    const underline = els.find((e) => e.refs?.includes("underline"))!;
    expect(underline.style).toEqual([{ prop: "translateX", propId: 128, value: { expr: { k: "binary", op: "*", l: { k: "signal", id: 0, ty: "int" }, r: { k: "int", v: 2 }, ty: "int" }, deps: [0] } }]);
    expect(program.refs).toEqual([{ name: "underline", element: underline.id }]);
    let show;
    walkNodes(program.root, (n) => {
      if (n.k === "show") show = n;
    });
    expect(show).toMatchObject({ when: { deps: [0] }, anchor: null, focusables: [] });
    const button = els.find((e) => e.focusable)!;
    expect(button.handler).toBe(0);
    expect(program.focusables).toEqual([{ element: button.id, order: button.order, handler: 0 }]);
  });

  test("collects the app's assets", () => {
    expect(program.assets.images).toEqual(["logo.png"]);
    expect(program.assets.sprites).toEqual(["spinner-atlas.svg"]);
    expect(program.assets.strings).toContain("ONE RUST CORE · ONE JSX APP");
    expect(program.assets.strings).toContain("Flexbox, springs and baked type —");
  });

  test("emits caches, masks and gates for exactly the dynamic bindings", () => {
    const styles = compileClasses(program.assets.classes);
    const rust = emitRust(program, { styleIds: styles.ids, fontSlots: styles.usedFontSlots });

    // One signal field, one node table, one flag per conditional block, and a
    // cache per DYNAMIC binding only.
    expect(rust).toContain("s0: i32, // count");
    expect(rust).toContain("n: [NodeId; ELEMENTS],");
    expect(rust).toContain("show0: bool,");
    expect(rust).toContain("t29: String,");
    expect(rust).toContain("p22_translateX: f64,");
    expect(rust).not.toContain("c0: i32"); // every class binding folded static

    // Writes compare before marking dirty (Solid's === gate).
    expect(rust).toContain("fn set_s0(&mut self, v: i32) {");
    expect(rust).toContain("self.dirty |= 0x1u64;");

    // int stays i32 and wraps; it converts once at the f64 host boundary.
    expect(rust).toContain("self.set_s0(self.s0.wrapping_add(1i32));");
    expect(rust).toContain("let v: f64 = (self.s0.wrapping_mul(2i32) as f64);");
    expect(rust).toContain("rt.set_prop(self.n[22], prop::TRANSLATE_X, v);");

    // A text run appends into one scratch String; no intermediate values.
    expect(rust).toContain('out.push_str("Count: "); fmt::push_int(out, self.s0);');

    // The conditional block carries its own mount/unmount with a static anchor.
    expect(rust).toContain("fn mount_show0(&mut self, rt: &mut Runtime) {");
    expect(rust).toContain("rt.create(NodeType::Text as u8, self.n[26], NodeId::NONE)");
    expect(rust).toContain("fn unmount_show0(&mut self, rt: &mut Runtime) {");

    // Flush dispatches on the dependency mask, in template pre-order.
    const flush = rust.slice(rust.indexOf("fn flush(&mut self"));
    expect(flush.slice(0, flush.indexOf("fn state"))).toContain("if d & 0x1u64 != 0 { self.apply_text_29(rt); }");
    expect(rust.indexOf("self.apply_style_22_translateX(rt); }")).toBeLessThan(rust.indexOf("self.apply_text_29(rt); }"));

    // Static props are written once at mount and have no apply function.
    expect(rust).toContain('rt.set_image(self.n[3], "logo.png");');
    expect(rust).toContain('rt.set_sprite(self.n[21], "spinner-atlas.svg", None);');
    expect(rust).not.toContain("fn apply_class_");
  });

  test("the emitter is deterministic", () => {
    const styles = compileClasses(program.assets.classes);
    const once = emitRust(program, { styleIds: styles.ids, fontSlots: styles.usedFontSlots });
    const twice = emitRust(compileMicro(HERO), { styleIds: styles.ids, fontSlots: styles.usedFontSlots });
    expect(twice).toBe(once);
  });
});

describe("subset diagnostics", () => {
  const entry = "/virtual/main.tsx";
  const module = "/virtual/app.tsx";
  const MAIN = `import App from "./app.tsx";\nimport { mount } from "@pocketjs/framework/solid";\nmount(() => <App />);\n`;
  const HEAD = `import { createSignal, createEffect, onMount } from "solid-js";\nimport { Text, View } from "@pocketjs/framework/components";\n`;

  function compile(body: string): Program {
    const files: Record<string, string> = { [entry]: MAIN, [module]: HEAD + body };
    return compileMicro(entry, { read: (p) => files[p], exists: (p) => p in files });
  }

  function diagnostic(body: string): string {
    try {
      compile(body);
    } catch (e) {
      expect(e).toBeInstanceOf(MicroCompileError);
      return (e as Error).message;
    }
    throw new Error("expected a diagnostic");
  }

  test("a setup-level signal read is not reactive", () => {
    const msg = diagnostic(`export default function App() {\n  const [n, setN] = createSignal(0);\n  const twice = n() * 2;\n  return <Text>{twice}</Text>;\n}\n`);
    expect(msg).toContain("/virtual/app.tsx:5:9");
    expect(msg).toContain("reads a signal once at setup");
  });

  test("class strings are literals or ternaries of literals", () => {
    const msg = diagnostic(`export default function App() {\n  const [on, setOn] = createSignal(false);\n  return <View class={"p-" + (on() ? 2 : 4)} />;\n}\n`);
    expect(msg).toContain("class is a string literal or a ternary of full class literals");
  });

  test("text belongs inside <Text>", () => {
    const msg = diagnostic(`export default function App() {\n  return <View>hello</View>;\n}\n`);
    expect(msg).toContain("text belongs inside <Text>");
  });

  test("an unbound ref is reported at its use", () => {
    const msg = diagnostic(`import { animate } from "@pocketjs/framework/animation";\nexport default function App() {\n  let box: unknown;\n  onMount(() => { animate(box, "width", 10); });\n  return <View />;\n}\n`);
    expect(msg).toContain("never bound to an element");
  });

  test("signal types widen from fractional writes", () => {
    const p = compile(`export default function App() {\n  const [x, setX] = createSignal(1);\n  return <View focusable onPress={() => setX(x() / 2)}><Text>{x()}</Text></View>;\n}\n`);
    expect(p.signals[0].ty).toBe("num");
    const els = elements(p);
    expect(els[1].text!.expr).toEqual({ k: "tostr", e: { k: "signal", id: 0, ty: "num" } });
  });

  test("callback props inline at the use site and fold when absent", () => {
    const p = compile(
      `function Counter(props: { onCount?: (n: number) => void }) {\n  const [c, setC] = createSignal(0);\n  return <View focusable onPress={() => { setC(c() + 1); props.onCount?.(c()); }}><Text>{c()}</Text></View>;\n}\n` +
        `export default function App() {\n  const [total, setTotal] = createSignal(0);\n  return <View><Counter onCount={(n) => setTotal(total() + n)} /><Counter /><Text>{total()}</Text></View>;\n}\n`,
    );
    expect(p.signals.map((s) => s.name)).toEqual(["total", "c", "c"]);
    expect(p.handlers[0].body).toEqual([
      { k: "set", signal: 1, e: { k: "binary", op: "+", l: { k: "signal", id: 1, ty: "int" }, r: { k: "int", v: 1 }, ty: "int" } },
      { k: "set", signal: 0, e: { k: "binary", op: "+", l: { k: "signal", id: 0, ty: "int" }, r: { k: "signal", id: 1, ty: "int" }, ty: "int" } },
    ]);
    expect(p.handlers[1].body).toEqual([
      { k: "set", signal: 2, e: { k: "binary", op: "+", l: { k: "signal", id: 2, ty: "int" }, r: { k: "int", v: 1 }, ty: "int" } },
      { k: "nop", note: "props.onCount is not bound at this use site" },
    ]);
  });
});

test("JSX text follows the JSX whitespace rules", () => {
  expect(cleanJsxText("\n    PocketJS\n  ")).toBe("PocketJS");
  expect(cleanJsxText("Flexbox, springs and baked type —")).toBe("Flexbox, springs and baked type —");
  expect(cleanJsxText("\n  a\n  b\n")).toBe("a b");
  expect(cleanJsxText(" + ")).toBe(" + ");
});
