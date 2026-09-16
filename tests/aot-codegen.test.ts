import { expect, test } from "bun:test";
import { analyzeVueAot } from "../vapor/compiler/aot-frontend.ts";
import { emitVueAot } from "../vapor/compiler/aot-codegen.ts";

test("Vue lab generated Rust", () => {
  const program = analyzeVueAot("apps/vue-sfc-lab/app.vue", { strict: true });
  expect(emitVueAot(program).files).toMatchSnapshot();
});

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AotComponent, AotExpr, AotHandler, AotNode, AotProgram, AotType } from "../vapor/compiler/aot-ir.ts";

const loc = { file: "backend-fixture.tsx", line: 1, column: 1, offset: 0 };
const boolean: AotType = { kind: "boolean" }, string: AotType = { kind: "string" }, integer: AotType = { kind: "number", name: "i32" };
const read = (name: string, type: AotType): AotExpr => ({ kind: "binding", scope: "vm", name, type, loc });
const call = (name: string, args: AotExpr[] = [], returns: AotType = { kind: "void" }): AotHandler => ({ kind: "call", expression: { kind: "call", target: "vm", name, arguments: args, type: returns, loc }, id: 0, loc });
const component = (name: string, nodes: AotNode[] = []): AotComponent => ({ name, file: `${name}.tsx`, root: name === "App", props: [], events: [], slots: [], values: [], functions: [], constants: [], children: [], nodes, nodeCount: 0, memoCount: 0, handlerCount: 0 });
function program(components: AotComponent[]): AotProgram { return { version: 3, root: "App", components, types: [], styles: { records: [], anims: [], ids: {}, bytes: [], usedFontSlots: [] }, diagnostics: [] }; }
function method(name: string, parameters: { name: string; type: AotType }[] = [], returns: AotType = { kind: "void" }) { return { name, sourceName: name, parameters, returns, binding: false, handler: true }; }
function childNode(name: string): AotNode { return { kind: "component", id: 0, component: name, props: [], events: [], slots: [], loc }; }
function branch(name: string, binding: string): AotNode { return { kind: "if", id: 0, branches: [{ condition: read(binding, boolean), children: [childNode(name)] }], loc }; }
function cargoFixture(name: string, generated: string, rust: string) {
  const directory = resolve(".pocket-build/validation/solid-aot/backend", name);
  mkdirSync(`${directory}/src`, { recursive: true });
  writeFileSync(`${directory}/Cargo.toml`, `[package]\nname = "aot-backend-${name}"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\npocket_vapor = { path = ${JSON.stringify(resolve("engine/crates/pocket-vapor"))}, features = ["std"] }\n`);
  writeFileSync(`${directory}/src/generated.rs`, generated);
  writeFileSync(`${directory}/src/lib.rs`, `mod generated;\nuse generated::*;\n${rust}`);
  const result = Bun.spawnSync(["cargo", "test", "--quiet", "--manifest-path", `${directory}/Cargo.toml`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/solid-aot/backend/target") } });
  expect(result.stderr.toString()).not.toContain("error[");
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}

test("IR consumers reject old versions", () => {
  expect(() => emitVueAot({ ...program([component("App")]), version: 2 } as unknown as AotProgram)).toThrow("Unsupported AOT IR version 2");
});

test("lifecycle hooks settle structural updates and unmount immediately", () => {
  const child = component("Child"); child.factory = { name: "createChild", sourceName: "createChild", module: "./Child" };
  child.functions = [method("load"), method("release")]; child.hooks = { mount: call("load"), unmount: call("release") };
  const app = component("App", [{ kind: "element", id: 0, tag: "Text", style: 0, props: [], focusable: false, children: [], events: [], text: { memo: 0, parts: [read("count", integer)] }, loc }, branch("Child", "visible")]); app.children = ["Child"];
  app.values = [{ name: "visible", sourceName: "visible", type: boolean, writable: false }, { name: "count", sourceName: "count", type: integer, writable: false }];
  app.functions = [method("load"), method("release")]; app.hooks = { mount: call("load"), unmount: call("release") };
  const output = emitVueAot(program([child, app])).files["app.rs"]!;
  cargoFixture("lifecycle", output, `
use std::{cell::{Cell, RefCell}, rc::Rc};
thread_local! { static TRACE: RefCell<Vec<&'static str>> = RefCell::new(Vec::new()); static COUNT: Cell<i32> = const { Cell::new(1) }; }
fn log(value: &'static str) { TRACE.with(|trace| trace.borrow_mut().push(value)); }
struct ChildModel;
impl Default for ChildModel { fn default() -> Self { log("child created"); Self } }
impl ChildViewModel for ChildModel { fn load(&mut self) { log("child mount"); } fn release(&mut self) { log("child unmount"); COUNT.with(|count| count.set(count.get() - 1)); } }
struct Model { visible: bool }
impl AppViewModel for Model {
  type Child = ChildModel;
  fn visible(&self) -> bool { self.visible }
  fn count(&self) -> i32 { COUNT.with(Cell::get) }
  fn load(&mut self) { log("parent mount"); self.visible = false; }
  fn release(&mut self) { log("parent unmount"); }
}
#[test] fn settles_and_destroys() {
  TRACE.with(|trace| trace.borrow_mut().clear());
  let mut app = AppApp::new(pocket_vapor::CoreHost::new(), AppProps {}, Model { visible: true });
  app.frame(&pocket_vapor::Input::default());
  TRACE.with(|trace| assert_eq!(*trace.borrow(), ["child created", "parent mount", "child mount", "child unmount"]));
  let text = app.ui().core().node_children(pocket_vapor::NodeId::ROOT.0)[0];
  assert_eq!(app.ui().core().node_text(text), Some("0"));
  app.unmount();
  TRACE.with(|trace| assert_eq!(trace.borrow().last(), Some(&"parent unmount")));
}
`);
}, 120_000);

function button(handler: AotHandler, mask = 1): AotNode { return { kind: "input", id: 0, input: { kind: "button", name: "CONFIRM", button: mask, latched: false }, active: { kind: "literal", value: true, type: boolean, loc }, handler, children: [], loc }; }
const eventRead = (): AotExpr => ({ kind: "binding", scope: "event", name: "$event", type: string, loc });
const twice = (): AotHandler => ({ kind: "sequence", steps: [call("record", [eventRead()]), call("record", [eventRead()])], id: 0, loc });

test("optional callbacks skip argument effects and owned event arguments can be consumed twice", () => {
  const child = component("Child"); child.factory = { name: "createChild", sourceName: "createChild", module: "./Child" };
  child.functions = [method("press", [], string)]; child.events = [{ name: "saved", parameters: [{ name: "value", type: string }, { name: "index", type: integer }], optional: true }];
  child.nodes = [button({ kind: "emit", name: "saved", optional: true, arguments: [(call("press", [], string) as Extract<AotHandler, { kind: "call" }>).expression, { kind: "literal", value: 7, type: integer, loc }], id: 0, loc })];
  const app = component("App", [childNode("Child"), { ...childNode("Child"), events: [{ name: "saved", handler: { kind: "sequence", steps: [twice(), call("recordIndex", [{ kind: "binding", scope: "event", name: "$event1", type: integer, loc }])], id: 0, loc } }] } as AotNode]);
  app.children = ["Child"]; app.functions = [method("record", [{ name: "value", type: string }]), method("recordIndex", [{ name: "value", type: integer }])];
  cargoFixture("callbacks", emitVueAot(program([child, app])).files["app.rs"]!, `
use std::cell::Cell;
thread_local! { static PRESSES: Cell<usize> = const { Cell::new(0) }; }
#[derive(Default)] struct ChildModel;
impl ChildViewModel for ChildModel { fn press(&mut self) -> String { PRESSES.with(|value| value.set(value.get() + 1)); "payload".into() } }
#[derive(Default)] struct Model { received: Vec<String> }
impl AppViewModel for Model { type Child = ChildModel; fn record(&mut self, value: String) { self.received.push(value); } fn recordIndex(&mut self, value: i32) { assert_eq!(value, 7); } }
#[test] fn optional_and_owned() {
  let mut app = AppApp::new(pocket_vapor::CoreHost::new(), AppProps {}, Model::default());
  app.frame(&pocket_vapor::Input::default());
  app.frame(&pocket_vapor::Input { buttons: 1, ..Default::default() });
  assert_eq!(app.model.received, ["payload", "payload"]);
  PRESSES.with(|value| assert_eq!(value.get(), 1));
}
`);
}, 120_000);

test("inlined listeners bind payloads once and clone before their final consuming use", () => {
  const child = component("Child"); child.props = [{ name: "value", type: string }];
  child.events = [{ name: "saved", parameters: [{ name: "value", type: string }] }];
  child.nodes = [button({ kind: "emit", name: "saved", arguments: [{ kind: "binding", scope: "prop", name: "value", type: string, loc }], id: 0, loc })];
  const app = component("App", [{ ...childNode("Child"), props: [{ name: "value", value: { kind: "literal", value: "payload", type: string, loc } }], events: [{ name: "saved", handler: twice() }] } as AotNode]);
  app.children = ["Child"]; app.functions = [method("record", [{ name: "value", type: string }])];
  cargoFixture("inline-callback", emitVueAot(program([child, app])).files["app.rs"]!, `
#[derive(Default)] struct Model { received: Vec<String> }
impl AppViewModel for Model { fn record(&mut self, value: String) { self.received.push(value); } }
#[test] fn inline_owned() {
  let mut app = AppApp::new(pocket_vapor::CoreHost::new(), AppProps {}, Model::default());
  app.frame(&pocket_vapor::Input::default());
  app.frame(&pocket_vapor::Input { buttons: 1, ..Default::default() });
  assert_eq!(app.model.received, ["payload", "payload"]);
}
`);
}, 120_000);

test("StyleId props and scalar array constants compile without a model binding", () => {
  const child = component("Child", [{ kind: "element", id: 0, tag: "View", style: 0, dynamicStyle: { id: 0, expression: { kind: "binding", scope: "prop", name: "tone", type: { kind: "style" }, loc } }, props: [], focusable: false, children: [], events: [], loc }]);
  child.factory = { name: "createChild", sourceName: "createChild", module: "./Child" }; child.props = [{ name: "tone", type: { kind: "style" } }];
  const table: AotExpr = { kind: "constant", name: "FILTERS", type: { kind: "array", element: string, length: 3 }, loc };
  const selection: AotExpr = { kind: "binary", operator: "??", left: { kind: "index", object: table, index: read("filter", integer), type: { kind: "option", value: string }, loc }, right: { kind: "literal", value: "", type: string, loc }, type: string, loc };
  child.constants = [{ name: "FILTERS", type: { kind: "array", element: string, length: 1 }, value: ["CHILD"] }];
  const childLabel: AotExpr = { kind: "binary", operator: "??", left: { kind: "index", object: { kind: "constant", name: "FILTERS", type: child.constants[0]!.type, loc }, index: { kind: "literal", value: 0, type: integer, loc }, type: { kind: "option", value: string }, loc }, right: { kind: "literal", value: "", type: string, loc }, type: string, loc };
  (child.nodes[0] as Extract<AotNode, { kind: "element" }>).children.push({ kind: "element", id: 1, tag: "Text", style: 0, props: [], focusable: false, children: [], events: [], text: { memo: 0, parts: [childLabel] }, loc });
  child.props.push({ name: "labels", type: table.type }, { name: "numbers", type: { kind: "array", element: { kind: "number", name: "u64" }, length: 1 } });
  const label: AotExpr = { kind: "binding", scope: "local", name: "label", type: string, loc };
  const list: AotNode = { kind: "for", id: 0, source: table, item: "label", itemType: string, key: label, children: [{ kind: "element", id: 0, tag: "Text", style: 0, props: [], focusable: false, children: [], events: [], text: { memo: 0, parts: [label] }, loc }], loc };
  const app = component("App", [{ ...childNode("Child"), props: [{ name: "tone", value: { kind: "literal", value: 7, type: { kind: "style" }, loc } }, { name: "labels", value: table }, { name: "numbers", value: { kind: "constant", name: "BIG_TABLE", type: child.props.find(prop => prop.name === "numbers")!.type, loc } }] } as AotNode, button(call("record", [selection])), list]);
  app.children = ["Child"]; app.constants = [{ name: "FILTERS", type: table.type, value: ["ALL", "ACTIVE", "DONE"] }, { name: "BIG_TABLE", type: { kind: "array", element: { kind: "number", name: "u64" }, length: 1 }, value: [Number("18446744073709551615")], rawNumbers: ["18446744073709551615"] }];
  app.functions = [method("record", [{ name: "value", type: string }])]; app.values = [{ name: "filter", sourceName: "filter", type: integer, writable: false }];
  cargoFixture("styles-constants", emitVueAot(program([child, app])).files["app.rs"]!, `
#[derive(Default)] struct ChildModel; impl ChildViewModel for ChildModel {}
#[derive(Default)] struct Model { received: Vec<String> }
impl AppViewModel for Model { type Child = ChildModel; fn filter(&self) -> i32 { 1 } fn record(&mut self, value: String) { self.received.push(value); } }
#[test] fn style_and_constants() {
  assert_eq!(FILTERS, ["ALL", "ACTIVE", "DONE"]);
  assert_eq!(BIG_TABLE[0], u64::MAX);
  assert_eq!(Child_FILTERS, ["CHILD"]);
  let mut app = AppApp::new(pocket_vapor::CoreHost::new(), AppProps {}, Model::default());
  app.frame(&pocket_vapor::Input::default());
  app.frame(&pocket_vapor::Input { buttons: 1, ..Default::default() });
  assert_eq!(app.model.received, ["ACTIVE"]);
  let labels: Vec<_> = app.ui().core().node_children(pocket_vapor::NodeId::ROOT.0).iter().filter_map(|node| app.ui().core().node_text(*node)).filter(|text| !text.is_empty()).collect();
  assert_eq!(labels, ["ALL", "ACTIVE", "DONE"]);
  let child_view = app.ui().core().node_children(pocket_vapor::NodeId::ROOT.0)[0];
  let child_text = app.ui().core().node_children(child_view)[0];
  assert_eq!(app.ui().core().node_text(child_text), Some("CHILD"));
}
`);
}, 120_000);

test("hook queues preserve ownership through slots and descending destruction", () => {
  const child = component("Child"); child.factory = { name: "createChild", sourceName: "createChild", module: "./Child" };
  child.functions = [method("load"), method("release")]; child.hooks = { mount: call("load"), unmount: call("release") };
  const page = component("Page", [{ kind: "slot", id: 0, name: "default", fallback: [], loc }]);
  page.factory = { name: "createPage", sourceName: "createPage", module: "./Page" }; page.slots = ["default"];
  page.functions = [method("load"), method("release")]; page.hooks = { mount: call("load"), unmount: call("release") };
  const app = component("App", [{ ...childNode("Page"), slots: [{ name: "default", children: [childNode("Child")] }] } as AotNode]); app.children = ["Page", "Child"];
  app.functions = [method("load"), method("release")]; app.hooks = { mount: call("load"), unmount: call("release") };
  cargoFixture("lifecycle-slots", emitVueAot(program([child, page, app])).files["app.rs"]!, `
use std::cell::RefCell;
thread_local! { static TRACE: RefCell<Vec<&'static str>> = RefCell::new(Vec::new()); }
fn log(value: &'static str) { TRACE.with(|trace| trace.borrow_mut().push(value)); }
struct ChildModel; impl Default for ChildModel { fn default() -> Self { log("child created"); Self } }
impl ChildViewModel for ChildModel { fn load(&mut self) { log("child mount"); } fn release(&mut self) { log("child unmount"); } }
struct PageModel; impl Default for PageModel { fn default() -> Self { log("page created"); Self } }
impl PageViewModel for PageModel { fn load(&mut self) { log("page mount"); } fn release(&mut self) { log("page unmount"); } }
struct Model;
impl AppViewModel for Model { type Page = PageModel; type Child = ChildModel; fn load(&mut self) { log("root mount"); } fn release(&mut self) { log("root unmount"); } }
#[test] fn slots_and_destruction() {
  let mut app = AppApp::new(pocket_vapor::CoreHost::new(), AppProps {}, Model);
  app.frame(&pocket_vapor::Input::default());
  TRACE.with(|trace| assert_eq!(*trace.borrow(), ["page created", "child created", "root mount", "page mount", "child mount"]));
  app.unmount();
  TRACE.with(|trace| assert_eq!(&trace.borrow()[5..], ["child unmount", "page unmount", "root unmount"]));
}
#[test] fn unmount_without_frame_runs_cleanup_without_mounts() {
  let app = AppApp::new(pocket_vapor::CoreHost::new(), AppProps {}, Model);
  app.unmount();
  TRACE.with(|trace| assert_eq!(*trace.borrow(), ["page created", "child created", "child unmount", "page unmount", "root unmount"]));
}
`);
}, 120_000);

test("keyed hook instances are created in source order, retained on moves and recreated after removal", () => {
  const child = component("Child", [{ kind: "element", id: 0, tag: "Text", style: 0, props: [], focusable: false, children: [], events: [], text: { memo: 0, parts: [{ kind: "binding", scope: "prop", name: "value", type: integer, loc }, ":", read("token", integer)] }, loc }]);
  child.factory = { name: "createChild", sourceName: "createChild", module: "./Child" }; child.props = [{ name: "value", type: integer }];
  child.values = [{ name: "token", sourceName: "token", type: integer, writable: false }];
  child.functions = [method("load"), method("release")]; child.hooks = { mount: call("load"), unmount: call("release") };
  const row: AotExpr = { kind: "binding", scope: "local", name: "item", type: integer, loc };
  const list: AotNode = { kind: "for", id: 0, source: read("rows", { kind: "array", element: integer }), item: "item", itemType: integer, key: row, children: [{ kind: "if", id: 0, branches: [{ condition: read("visible", boolean), children: [{ ...childNode("Child"), props: [{ name: "value", value: row }] } as AotNode] }], loc }], loc };
  const app = component("App", [list]); app.children = ["Child"];
  app.values = [{ name: "rows", sourceName: "rows", type: { kind: "array", element: integer }, writable: false }, { name: "visible", sourceName: "visible", type: boolean, writable: false }];
  app.functions = [method("load")]; app.hooks = { mount: call("load") };
  cargoFixture("lifecycle-keyed", emitVueAot(program([child, app])).files["app.rs"]!, `
use std::cell::{Cell, RefCell};
thread_local! { static NEXT: Cell<i32> = const { Cell::new(0) }; static TRACE: RefCell<Vec<String>> = RefCell::new(Vec::new()); }
struct ChildModel(i32); impl Default for ChildModel { fn default() -> Self { Self(NEXT.with(|next| { next.set(next.get() + 1); next.get() })) } }
impl ChildViewModel for ChildModel { fn token(&self) -> i32 { self.0 } fn load(&mut self) { TRACE.with(|trace| trace.borrow_mut().push(format!("mount {}", self.0))); } fn release(&mut self) { TRACE.with(|trace| trace.borrow_mut().push(format!("unmount {}", self.0))); } }
struct Model { rows: Vec<i32>, visible: bool }
impl AppViewModel for Model { type Child = ChildModel; fn rows(&self) -> &[i32] { &self.rows } fn visible(&self) -> bool { self.visible } fn load(&mut self) { self.visible = true; } }
fn texts(ui: &pocket_vapor::Ui) -> Vec<String> { ui.core().node_children(pocket_vapor::NodeId::ROOT.0).iter().filter_map(|id| ui.core().node_text(*id).map(str::to_owned)).collect() }
#[test] fn retained_keyed_models() {
  let mut app = AppApp::new(pocket_vapor::CoreHost::new(), AppProps {}, Model { rows: vec![10,20], visible: false });
  app.frame(&pocket_vapor::Input::default()); assert_eq!(texts(app.ui()), ["10:1", "20:2"]);
  app.model.rows = vec![20,10]; app.invalidate(); app.frame(&pocket_vapor::Input::default()); assert_eq!(texts(app.ui()), ["20:2", "10:1"]);
  app.model.rows = vec![10]; app.invalidate(); app.frame(&pocket_vapor::Input::default()); assert_eq!(texts(app.ui()), ["10:1"]);
  app.model.rows = vec![10,20]; app.invalidate(); app.frame(&pocket_vapor::Input::default()); assert_eq!(texts(app.ui()), ["10:1", "20:3"]);
  app.unmount(); TRACE.with(|trace| assert_eq!(*trace.borrow(), ["mount 1", "mount 2", "unmount 2", "mount 3", "unmount 3", "unmount 1"]));
}
`);
}, 120_000);
