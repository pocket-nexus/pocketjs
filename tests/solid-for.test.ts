// The live Solid build is the oracle: bun test --conditions=browser tests/solid-for.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createRoot, createSignal, Show, type JSX } from "solid-js";
import { BTN } from "../contracts/spec/spec.ts";
import { ActionHandler, AxisHandler, For, MotionHandler, Text, View } from "../framework/src/components.ts";
import { render } from "../framework/src/index.ts";
import { resetRendererState, rootMirror, type NodeMirror } from "../framework/src/renderer-solid.ts";
import { focusNode, resetInput } from "../framework/src/input.ts";
import { runFrameHooks, resetFrameHooks } from "../framework/src/frame.ts";
import { onCleanup, onMotion, onMount } from "../framework/src/lifecycle.ts";
import { flushLifecycleHooks } from "../framework/src/lifecycle-solid-aot.ts";
import { feedAxisDelta, RelativeAxis } from "../framework/src/relative-axis.ts";
import { feedMotionState, MotionQuality, MotionReferenceFrame, type MotionState } from "../framework/src/input-api.ts";
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

function motion(state: MotionState | null): void { runFrameHooks(0, undefined, undefined, undefined, state); }

test("MotionHandler delivers driver values at its minimum quality with metadata, gated by active", () => {
  const [active, setActive] = createSignal(true);
  const calls: (string | number)[][] = [];
  mount(() => {
    onMotion("tilt", (beta, gamma, quality) => calls.push(["tilt", beta, gamma, quality]), { minQuality: "high" });
    return View({ get children() { return [
      MotionHandler({ value: "rotationRate", minQuality: "high", onUpdate: (...payload) => calls.push(["spin", ...payload]) }),
      MotionHandler({ value: "screenRotation", get active() { return active(); }, onUpdate: (...payload) => calls.push(["upright", ...payload]) }),
      MotionHandler({ value: "angles", onUpdate: (...payload) => calls.push(["angles", ...payload]) }),
    ]; } });
  });
  motion(null);
  runFrameHooks(0);
  expect(calls).toEqual([]);
  // Derived values arrive from the driver as fed; the runtime does not recompute them from gravity.
  motion({ timestamp: 2_000, gravityDirection: { value: [0, -1, 0], quality: MotionQuality.Medium },
    rotationRate: { value: [0, 0, 90], quality: MotionQuality.Medium },
    screenRotation: { value: 90, quality: MotionQuality.Medium },
    angles: { value: [90, 0.1, 0], quality: MotionQuality.Medium, referenceFrame: MotionReferenceFrame.Local, epoch: 3 } });
  expect(calls).toEqual([["upright", 90, MotionQuality.Medium, 2_000], ["angles", 90, Math.fround(0.1), 0, MotionQuality.Medium, MotionReferenceFrame.Local, 3, 2_000]]);
  calls.length = 0;
  // An unreliable value stays below the default minimum quality; high-quality values pass, zeros unsigned.
  motion({ timestamp: 3_000, screenRotation: { value: 0, quality: MotionQuality.Unreliable }, tilt: { value: [0, -0], quality: MotionQuality.High },
    rotationRate: { value: [1.5, -2, 0.1], quality: MotionQuality.High } });
  expect(calls).toEqual([["tilt", 0, 0, MotionQuality.High], ["spin", 1.5, -2, Math.fround(0.1), MotionQuality.High, 3_000]]);
  calls.length = 0;
  setActive(false);
  motion({ timestamp: 4_000, screenRotation: { value: 0, quality: MotionQuality.High }, tilt: { value: [90, 0], quality: MotionQuality.High } });
  expect(calls.map(call => call.slice(0, 2))).toEqual([["tilt", 90]]);
});

test("MotionHandler dispatch follows document order, not mount order", () => {
  const [early, setEarly] = createSignal(false);
  const order: string[] = [];
  mount(() => View({ get children() { return [
    Conditional({ get when() { return early(); }, get children() { return MotionHandler({ value: "inclination", onUpdate: () => order.push("first") }); } }),
    ActionHandler({ button: BTN.SELECT, onPress: () => order.push("press") }),
    MotionHandler({ value: "gravityDirection", onUpdate: () => order.push("last") }),
  ]; } }));
  setEarly(true);
  runFrameHooks(BTN.SELECT, undefined, undefined, undefined,
    { timestamp: 1, gravityDirection: { value: [0, -1, 0], quality: MotionQuality.Low }, inclination: { value: 90, quality: MotionQuality.Low } });
  expect(order).toEqual(["first", "press", "last"]);
});

test("fed motion states: the newest replaces the queue, a frame argument (including null) overrides it, validation throws", () => {
  const seen: number[] = [];
  mount(() => View({ get children() { return MotionHandler({ value: "inclination", onUpdate: (degrees, quality, timestamp) => seen.push(timestamp) }); } }));
  const at = (timestamp: number): MotionState => ({ timestamp, inclination: { value: 45, quality: MotionQuality.Low } });
  feedMotionState(at(1)); feedMotionState(at(2));
  runFrameHooks(0); runFrameHooks(0);
  feedMotionState(at(3)); motion(null); runFrameHooks(0);
  feedMotionState(at(4)); motion(at(5)); runFrameHooks(0);
  expect(seen).toEqual([2, 5]);
  expect(() => feedMotionState({ timestamp: -1 })).toThrow("timestamp");
  expect(() => feedMotionState({ timestamp: 1.5 })).toThrow("timestamp");
  expect(() => feedMotionState({ timestamp: 1, inclination: { value: NaN, quality: MotionQuality.Low } })).toThrow("inclination.value");
  expect(() => feedMotionState({ timestamp: 1, gravityDirection: { value: [0, 1e39, 0], quality: MotionQuality.Low } })).toThrow("gravityDirection.value[1]");
  expect(() => feedMotionState({ timestamp: 1, rotationRate: { value: [0, 0] as never, quality: MotionQuality.Low } })).toThrow("rotationRate.value");
  expect(() => feedMotionState({ timestamp: 1, rotationRate: { value: new Array(3) as never, quality: MotionQuality.High } })).toThrow("rotationRate.value[0]");
  expect(() => feedMotionState({ timestamp: 1, inclination: { value: 1, quality: 5 as never } })).toThrow("inclination.quality");
  expect(() => feedMotionState({ timestamp: 1, heading: { value: 1, accuracy: -1, quality: MotionQuality.Low, referenceFrame: 4 as never } })).toThrow("heading.referenceFrame");
  expect(() => feedMotionState({ timestamp: 1, orientation: { value: [1, 0, 0, 0], quality: MotionQuality.Low, referenceFrame: MotionReferenceFrame.Local, epoch: -1 } })).toThrow("orientation.epoch");
  expect(() => feedMotionState({ timestamp: 1, tilt: { value: [0, 0, 0] as never, quality: MotionQuality.Low } })).toThrow("tilt.value");
  expect(() => feedMotionState({ timestamp: 1, angles: { value: [0, 0, 0], quality: MotionQuality.Low, referenceFrame: MotionReferenceFrame.Local, epoch: 1.5 } })).toThrow("angles.epoch");
  expect(() => MotionHandler({ value: "gravity" as never })).toThrow("Unknown motion value gravity");
  runFrameHooks(0);
  expect(seen).toEqual([2, 5]);
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
