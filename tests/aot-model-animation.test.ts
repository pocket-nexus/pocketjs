import { expect, test } from "bun:test";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { installHost } from "../framework/src/host.ts";
import { ModelRegion } from "../framework/src/model-reactive.ts";
import { ModelTasks, disposeModelTasks, drainModelCommands, resumeModelTasks } from "../framework/src/model-tasks.ts";
import { createNodeRef, installModelAnimationCommands, pollModelAnimations } from "../framework/src/model-animation.ts";
import { clearNodeReferences } from "../framework/src/model-node-ref.ts";
import type { NodeMirror } from "../framework/src/native-tree.ts";
import { PROP } from "../contracts/spec/spec.ts";

test("JS awaited animations use core track identity and completion reasons", async () => {
  const wasm = await createWasmUi(await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer());
  installHost({ ops: wasm.ops, kind: "injected", target: "model-animation-test", strict: true });
  installModelAnimationCommands();
  const id = wasm.ops.createNode(0);
  wasm.ops.insertBefore(1, id, 0); wasm.ops.setProp(id, PROP.width, 10);
  const node = { id, type: 0, parent: {} as NodeMirror, children: [] } as NodeMirror;
  const slot = createNodeRef(); slot(node);
  const region = new ModelRegion(<T>(value: T): [() => T, (next: T) => void] => [() => value, next => { value = next; }]);
  region.refs.set("bar", slot); region.finish([]);
  const tasks = new ModelTasks(region), results: unknown[] = [];
  const start = (fn: number, duration: number) => tasks.start(fn, [], (state, locals) => state === 0
    ? { next: 1, bind: 9, suspend: { kind: "animate", args: ["bar", "width", 50, { dur: duration, easing: "linear" }] } }
    : (results.push(locals[9]), { done: true }));
  start(1, 1); drainModelCommands(); wasm.tick(); pollModelAnimations(); resumeModelTasks(1, 16);
  expect(results).toEqual(["ended"]);
  start(2, 1000); drainModelCommands();
  tasks.command("jump", ["bar", "width", 25]); drainModelCommands(); wasm.tick(); pollModelAnimations(); resumeModelTasks(2, 32);
  expect(results).toEqual(["ended", "replaced"]);
  start(3, 1000); drainModelCommands(); wasm.ops.destroyNode(id); clearNodeReferences(node); wasm.tick(); pollModelAnimations(); resumeModelTasks(3, 48);
  expect(results).toEqual(["ended", "replaced", "dropped"]);
  expect(slot.current).toBeNull();
  start(4, 100); drainModelCommands(); resumeModelTasks(4, 64);
  expect(results).toEqual(["ended", "replaced", "dropped", "dropped"]);
  disposeModelTasks(region); region.dispose();
});

test("cancelling a model animation wait preserves motion without resuming the task", async () => {
  const wasm = await createWasmUi(await Bun.file("hosts/web/pocketjs.wasm").arrayBuffer());
  installHost({ ops: wasm.ops, kind: "injected", target: "model-animation-cancel-test", strict: true });
  installModelAnimationCommands();
  const id = wasm.ops.createNode(0);
  wasm.ops.insertBefore(1, id, 0);
  wasm.ops.setProp(id, PROP.width, 10); wasm.ops.setProp(id, PROP.height, 20);
  const node = { id, type: 0, parent: {} as NodeMirror, children: [] } as NodeMirror;
  const slot = createNodeRef(); slot(node);
  const region = new ModelRegion(<T>(value: T): [() => T, (next: T) => void] => [() => value, next => { value = next; }]);
  region.refs.set("bar", slot); region.finish([]);
  const tasks = new ModelTasks(region), results: unknown[] = [];
  tasks.start(1, [], (state, locals) => state === 0
    ? { next: 1, bind: 9, suspend: { kind: "animate", args: ["bar", "width", 50, { dur: 1000, easing: "linear" }] } }
    : (results.push(locals[9]), { done: true }));
  drainModelCommands();
  const width = () => { wasm.ops.debugInspect!(id); wasm.render(); return wasm.ops.debugRectWH!() & 0xffff; };
  const frame = (instant: number) => { wasm.tick(); pollModelAnimations(); resumeModelTasks(instant, instant * 1000 / 60); };
  for (let instant = 1; instant <= 6; instant++) frame(instant);
  const beforeCancel = width();
  expect(beforeCancel).toBeGreaterThan(10); expect(beforeCancel).toBeLessThan(50);
  tasks.cancel(1); drainModelCommands();
  for (let instant = 7; instant <= 12; instant++) frame(instant);
  expect(width()).toBeGreaterThan(beforeCancel);
  for (let instant = 13; instant <= 72; instant++) frame(instant);
  expect(width()).toBe(50); expect(results).toEqual([]);
  disposeModelTasks(region); region.dispose(); clearNodeReferences(node); wasm.ops.destroyNode(id);
});
