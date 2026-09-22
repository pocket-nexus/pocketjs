// The live Solid build is the oracle: bun test --conditions=browser tests/solid-for.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createRoot, createSignal, Show, type JSX } from "solid-js";
import { BTN } from "../contracts/spec/spec.ts";
import { ActionHandler, AxisHandler, For, Text, View } from "../framework/src/components.ts";
import { render } from "../framework/src/index.ts";
import { resetRendererState, rootMirror, type NodeMirror } from "../framework/src/renderer-solid.ts";
import { focusNode, resetInput } from "../framework/src/input.ts";
import { runFrameHooks, resetFrameHooks } from "../framework/src/frame.ts";
import { onCleanup, onMount } from "../framework/src/lifecycle.ts";
import { flushLifecycleHooks } from "../framework/src/lifecycle-solid-aot.ts";
import { feedAxisDelta, RelativeAxis } from "../framework/src/relative-axis.ts";
import type { HostOps } from "../framework/src/host.ts";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) throw new Error("Run Solid oracle tests with --conditions=browser");

let dispose: (() => void) | undefined;
beforeEach(() => { resetRendererState(); resetInput(); resetFrameHooks(); });
afterEach(() => { dispose?.(); dispose = undefined; });
function ops(): HostOps {
  let next = 2;
  const noop = () => {};
  return { createNode: () => next++, destroyNode: noop, insertBefore: noop, removeChild: noop,
    setStyle: noop, setProp: noop, setText: noop, replaceText: noop, uploadTexture: () => 0,
    setImage: noop, setSprite: noop, animate: () => 1, cancelAnim: noop, setFocus: noop, measureText: () => 0 };
}
function mount(code: () => unknown): void { dispose = render(code, { ops: ops(), styles: {} }); }
function press(): void { runFrameHooks(0); runFrameHooks(BTN.SELECT); }
function text(node: NodeMirror = rootMirror): string { return (node.text ?? "") + node.children.map(child => text(child)).join(""); }
const action = (onPress: () => void): JSX.Element => ActionHandler({ button: BTN.SELECT, onPress });
const Conditional = Show as (props: { when: boolean; children: JSX.Element }) => JSX.Element;

test("numeric text reaches both the host and mirror as a string", () => {
  const [value, setValue] = createSignal(0);
  let node: NodeMirror | undefined;
  mount(() => Text({ nodeRef: current => { node = current; }, get children() { return value(); } }));
  expect(node!.children[0]!.text).toBe("0");
  setValue(2);
  expect(node!.children[0]!.text).toBe("2");
});

test("For retains a row's state and native nodes when an object is replaced under its key", () => {
  const [rows, setRows] = createSignal([{ id: "a", label: "old" }, { id: "b", label: "B" }]);
  const ids: number[] = [];
  const events: string[] = [];
  mount(() => View({ get children() {
    return For({ get each() { return rows(); }, by: row => row.id, children: (item, index) => {
      const [presses, setPresses] = createSignal(0);
      return View({ nodeRef: node => ids.push(node.id), get children() { return [
        Text({ get children() { return `${item().label}:${presses()}`; } }),
        action(() => { setPresses(presses() + 1); events.push(`${item().id}:${index()}:${presses()}`); }),
      ]; } });
    } });
  } }));
  press();
  const original = [...ids];
  setRows([{ id: "b", label: "new B" }, { id: "a", label: "new A" }]);
  expect(ids).toEqual(original);
  expect(text()).toBe("new B:1new A:1");
  events.length = 0;
  press();
  expect(events).toEqual(["b:0:2", "a:1:2"]);
});

test("each handler resolves current keyed values then freezes its whole row chain", () => {
  const [rows, setRows] = createSignal([{ id: "a", label: "old" }]);
  const events: string[] = [];
  mount(() => View({ get children() { return [
    action(() => setRows([{ id: "a", label: "before row" }])),
    For({ get each() { return rows(); }, by: row => row.id, children: item => [
      action(() => { events.push(item().label); setRows([{ id: "a", label: "inside row" }]); events.push(item().label); }),
      action(() => events.push(item().label)),
    ] }),
  ]; } }));
  press();
  expect(events).toEqual(["before row", "before row", "inside row"]);
  expect(rows()[0]!.label).toBe("inside row");
});

test("row snapshots also freeze records mutated in place before a signal write", () => {
  const [rows, setRows] = createSignal([{ id: "a", nested: { label: "old" } }]);
  const events: string[] = [];
  mount(() => For({ get each() { return rows(); }, by: row => row.id, children: item => [
    Text({ get children() { return item().nested.label; } }),
    action(() => { rows()[0]!.nested.label = "new"; setRows([...rows()]); events.push(item().nested.label); }),
    action(() => events.push(item().nested.label)),
  ] }));
  press();
  expect(events).toEqual(["old", "new"]);
  expect(text()).toBe("new");
});

test("removing an enclosing key skips every nested row handler", () => {
  const [groups, setGroups] = createSignal([{ id: "outer", rows: [{ id: "inner" }] }]);
  const events: string[] = [];
  mount(() => View({ get children() { return [
    action(() => setGroups([])),
    For({ get each() { return groups(); }, by: group => group.id, children: group =>
      For({ get each() { return group().rows; }, by: row => row.id, children: item => action(() => events.push(item().id)) }),
    }),
  ]; } }));
  press();
  expect(events).toEqual([]);
});

test("a nested list resolves its source from the latest enclosing row snapshot", () => {
  const [groups, setGroups] = createSignal([{ id: "outer", rows: [{ id: "inner", label: "old" }] }]);
  const events: string[] = [];
  mount(() => View({ get children() { return [
    action(() => setGroups([{ id: "outer", rows: [{ id: "inner", label: "new" }] }])),
    For({ get each() { return groups(); }, by: group => group.id, children: group =>
      For({ get each() { return group().rows; }, by: row => row.id, children: item => action(() => events.push(item().label)) }),
    }),
  ]; } }));
  press();
  expect(events).toEqual(["new"]);
});

test("a reorder during dispatch preserves handler order but refreshes each row index", () => {
  const [rows, setRows] = createSignal([{ id: "a" }, { id: "b" }]);
  const events: string[] = [];
  mount(() => View({ get children() { return [
    action(() => setRows([...rows()].reverse())),
    For({ get each() { return rows(); }, by: row => row.id, children: (item, index) =>
      action(() => events.push(`${item().id}:${index()}`)),
    }),
  ]; } }));
  press();
  expect(events).toEqual(["a:1", "b:0"]);
  events.length = 0;
  press();
  expect(events).toEqual(["b:1", "a:0"]);
});

test("focusable View presses participate in row snapshots and document ordering", () => {
  const [rows, setRows] = createSignal([{ id: "a", label: "old" }]);
  const events: string[] = [];
  let focused: NodeMirror | undefined;
  mount(() => View({ get children() { return [
    ActionHandler({ button: BTN.CIRCLE, onPress: () => setRows([{ id: "a", label: "new" }]) }),
    For({ get each() { return rows(); }, by: row => row.id, children: item => View({ focusable: true, nodeRef: node => { focused = node; },
      onPress: () => { events.push(item().label); setRows([{ id: "a", label: "later" }]); events.push(item().label); },
    }) }),
  ]; } }));
  const frame = (globalThis as unknown as { frame: (buttons: number) => void }).frame;
  focusNode(focused!);
  frame(0); frame(BTN.CIRCLE);
  expect(events).toEqual(["new", "new"]);
});

test("one whole dispatch keeps a Show instance across off/on writes", () => {
  const [open, setOpen] = createSignal(true);
  let created = 0;
  let removed = 0;
  mount(() => View({ get children() { return [
    action(() => setOpen(false)), action(() => setOpen(true)),
    Conditional({ get when() { return open(); }, get children() {
      created++;
      onCleanup(() => removed++);
      return Text({ children: "child" });
    } }),
  ]; } }));
  press();
  expect([created, removed]).toEqual([1, 0]);
});

test("ActionHandler active remains reactive and axis delivery uses frame millidegrees", () => {
  const [active, setActive] = createSignal(false);
  const deltas: number[] = [];
  let presses = 0;
  mount(() => View({ get children() { return [
    ActionHandler({ button: BTN.SELECT, get active() { return active(); }, onPress: () => presses++ }),
    AxisHandler({ axis: "primary", get active() { return active(); }, onDelta: delta => deltas.push(delta) }),
  ]; } }));
  runFrameHooks(BTN.SELECT, [{ axis: RelativeAxis.Primary, delta: 12_000 }]);
  setActive(true);
  runFrameHooks(BTN.SELECT);
  expect(presses).toBe(0);
  press();
  feedAxisDelta(RelativeAxis.Primary, -15_000);
  runFrameHooks(0);
  runFrameHooks(0);
  expect(presses).toBe(1);
  expect(deltas).toEqual([-15_000]);
});

test("a parent hook closing a child still mounts then unmounts that child", () => {
  const trace: string[] = [];
  const [open, setOpen] = createSignal(true);
  mount(() => {
    onMount(() => { trace.push("parent mount"); setOpen(false); });
    return View({ get children() { return Conditional({ get when() { return open(); }, get children() {
      trace.push("child created");
      onMount(() => trace.push("child mount"));
      onCleanup(() => trace.push("child unmount"));
      return Text({ children: "child" });
    } }); } });
  });
  expect(trace).toEqual(["child created", "parent mount", "child mount", "child unmount"]);
  expect(text()).toBe("");
});

test("a parent hook opening an earlier sibling creates it in the next round", () => {
  const trace: string[] = [];
  const [open, setOpen] = createSignal(false);
  const child = (name: string) => {
    trace.push(`${name} created`);
    onMount(() => trace.push(`${name} mount`));
    return Text({ children: name });
  };
  mount(() => {
    onMount(() => { trace.push("parent mount"); setOpen(true); });
    return View({ get children() { return [
      Conditional({ get when() { return open(); }, get children() { return child("A"); } }),
      child("B"),
    ]; } });
  });
  expect(trace).toEqual(["B created", "parent mount", "B mount", "A created", "A mount"]);
});

test("root disposal runs unmount hooks in reverse creation order without another frame", () => {
  const trace: string[] = [];
  const child = (name: string, children?: () => JSX.Element) => {
    onCleanup(() => trace.push(name));
    return View({ get children() { return children?.(); } });
  };
  mount(() => child("P", () => [child("A", () => child("X")), child("B")]));
  dispose!(); dispose = undefined;
  expect(trace).toEqual(["B", "X", "A", "P"]);
});

test("an unmount-only round updates surviving text before the frame returns", () => {
  const [open, setOpen] = createSignal(true);
  const [count, setCount] = createSignal(1);
  mount(() => View({ get children() { return [
    Text({ get children() { return count(); } }), action(() => setOpen(false)),
    Conditional({ get when() { return open(); }, get children() {
      onCleanup(() => setCount(count() - 1));
      return Text({ children: "child" });
    } }),
  ]; } }));
  press();
  expect(text()).toBe("0");
});

test("disposing a plain Solid root drains cleanup even before mount hooks ran", () => {
  const trace: string[] = [];
  const close = createRoot(close => {
    onMount(() => trace.push("mount"));
    onCleanup(() => trace.push("cleanup"));
    return close;
  });
  close(); flushLifecycleHooks();
  expect(trace).toEqual(["cleanup"]);
});

test("root cleanup waits for Key row disposers registered before the first hook", () => {
  const trace: string[] = [];
  const close = createRoot(close => {
    For({ each: ["a", "b"], by: item => item, children: item => {
      onCleanup(() => trace.push(item()));
      return null;
    } });
    return close;
  });
  close();
  expect(trace).toEqual(["b", "a"]);
});

test("oscillating lifecycle hooks stop after eight rounds", () => {
  const [open, setOpen] = createSignal(true);
  createRoot(close => {
    dispose = close;
    Conditional({ get when() { return open(); }, get children() {
      onMount(() => setOpen(false));
      onCleanup(() => setOpen(true));
      return "child";
    } });
  });
  expect(() => flushLifecycleHooks()).toThrow("eight hook rounds");
});

test("duplicate sibling keys fail with the offending key", () => {
  expect(() => mount(() => For({ each: [{ id: "same" }, { id: "same" }], by: row => row.id, children: () => null }))).toThrow("duplicate For key same");
});
