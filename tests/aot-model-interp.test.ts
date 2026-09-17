import { expect, test } from "bun:test";
import { ModelInterpreter } from "../vapor/compiler/model-interp.ts";
import { lowerModelTasks } from "../vapor/compiler/aot-model-tasks.ts";
import type { ModelProgram, ModelModule, ModelExpr, ModelStmt } from "../vapor/compiler/aot-model-ir.ts";

// Expectations in this corpus are derived from MODEL_AOT.md §3, never from an emitter.
const I = { kind: "number", name: "i32" } as const;
const B = { kind: "boolean" } as const;
const S = { kind: "string" } as const;
const V = { kind: "void" } as const;
const loc = { file: "core.ts", line: 1, column: 1, offset: 0 };
const ledger = { reads: [], writes: [], subscriptions: [], external: false };
const e = (x: object, type: any = I): ModelExpr => ({ ...x, type, loc, ledger }) as ModelExpr;
const lit = (value: any) => e({ kind: "literal", value }, typeof value === "boolean" ? B : typeof value === "string" ? S : I);
const read = (id: number, kind = "signal", type: any = I) => e({ kind, id }, type);
const bin = (left: ModelExpr, operator: string, right: ModelExpr, type: any = I) => e({ kind: "binary", left, operator, right }, type);
const set = (signal: number, value: ModelExpr, rest = {}): ModelStmt => ({ kind: "set", signal, value, ...rest });
const binder = (id: number, name = `v${id}`, type: any = I) => ({ id, name, type, owned: true });
const block = (...stmts: any[]) => ({ stmts });
const signal = (id: number, seed: any = 0, type: any = typeof seed === "string" ? S : I) => ({ id, name: `s${id}`, exported: true, type, seed: lit(seed) });
const fn = (id: number, stmts: any[], async = false) => ({ id, name: `f${id}`, exported: true, async, params: [], returns: V, body: block(...stmts), ledger });
const effect = (id: number, subscriptions: number[], stmts: any[], defer = true) => ({ id, subscriptions, declared: true, defer, body: block(...stmts), ledger });
const memo = (id: number, inputs: number[], body: ModelExpr) => ({ id, name: `m${id}`, exported: true, type: body.type, inputs, body });
function program(parts: Partial<ModelModule> = {}): ModelProgram {
  return { version: 1, modules: [{ name: "App", file: "core.ts", kind: "root", params: [], signals: [], fields: [], memos: [], effects: [], functions: [], schedule: [], refs: [], tasks: [], ...parts }] } as ModelProgram;
}
const run = (p: ModelProgram, opts = {}) => new ModelInterpreter(lowerModelTasks(p), opts);
const dispatch = (model: ModelInterpreter, id: number, args: any[] = [], extra = {}) => model.frame({ dispatch: [{ fn: id, args }], ...extra });
const inc = (id: number) => set(id, bin(read(900, "local"), "+", lit(1)), { pre: binder(900) });
const events = (frame: any, kind: string) => frame.trace.filter((x: any) => x.kind === kind);

test("functional setter reads pre without subscribing; one effect run per reaction", () => {
  const m = run(program({ signals: [signal(1), signal(2)], effects: [effect(3, [1], [inc(2)])], functions: [fn(4, [inc(1), inc(1)])], schedule: [3] }));
  const frame = dispatch(m, 4);
  expect(frame.state.s1).toBe(2); expect(frame.state.s2).toBe(1);
  expect(events(frame, "effect").map((x: any) => x.id)).toEqual([3]);
  expect(m.frame().trace).toEqual([]);
});

test("initial effect runs once while defer skips initial reaction", () => {
  const m = run(program({ signals: [signal(1), signal(2)], effects: [effect(3, [], [inc(1)], false), effect(4, [], [inc(2)], true)], schedule: [3, 4] }));
  expect(m.state()).toMatchObject({ s1: 1, s2: 0 });
});

test("primitive memo equality gates subscribers", () => {
  const m = run(program({ signals: [signal(1), signal(2)], memos: [memo(3, [1], bin(read(1), ">", lit(0), B))], effects: [effect(4, [3], [inc(2)])], functions: [fn(5, [inc(1)])], schedule: [3, 4] }));
  expect(dispatch(m, 5).state.s2).toBe(1);
  expect(dispatch(m, 5).state.s2).toBe(1);
});

test("a handler observes on-demand memo after a write", () => {
  const m = run(program({ signals: [signal(1), signal(2)], memos: [memo(3, [1], bin(read(1), "*", lit(2)))], functions: [fn(4, [set(1, lit(3)), set(2, read(3, "memo"))])], schedule: [3] }));
  const f = dispatch(m, 4); expect(f.state.s2).toBe(6);
  expect(events(f, "memo").map((x: any) => x.mode)).toEqual(["demand"]);
});

test("on-demand read refreshes unread memo ancestors", () => {
  const m = run(program({ signals: [signal(1), signal(2)], memos: [memo(3, [1], bin(read(1), "+", lit(1))), memo(4, [3], bin(read(3, "memo"), "*", lit(2)))], functions: [fn(5, [set(1, lit(4)), set(2, read(4, "memo"))])], schedule: [3, 4] }));
  const f = dispatch(m, 5); expect(f.state.s2).toBe(10);
  expect(events(f, "memo").map((x: any) => x.id)).toEqual([3, 4]);
});

test("an effect can read two memo values between two writes", () => {
  const m = run(program({ signals: [signal(1), signal(2), signal(3), signal(4)], memos: [memo(5, [2], bin(read(2), "*", lit(2)))], effects: [effect(6, [1], [set(2, lit(1)), set(3, read(5, "memo")), set(2, lit(2)), set(4, read(5, "memo"))])], functions: [fn(7, [inc(1)])], schedule: [6, 5] }));
  const f = dispatch(m, 7); expect(f.state).toMatchObject({ s3: 2, s4: 4 });
  expect(events(f, "memo")).toHaveLength(2);
});

for (const intermediateRead of [false, true]) test(`memo read timing retains changed flag: read=${intermediateRead}`, () => {
  const m = run(program({ signals: [signal(1), signal(2), signal(3)], memos: [memo(4, [2], read(2))], effects: [effect(5, [1], [set(2, lit(1)), ...(intermediateRead ? [{ kind: "let", binder: binder(10), init: read(4, "memo") }] : []), set(2, lit(0))]), effect(6, [4], [inc(3)])], functions: [fn(7, [inc(1)])], schedule: [5, 4, 6] }));
  expect(dispatch(m, 7).state.s3).toBe(intermediateRead ? 1 : 0);
});

test("effect chain is settled before a view update", () => {
  const observed: any[] = [];
  const m = run(program({ signals: [signal(1), signal(2), signal(3)], effects: [effect(4, [1], [set(2, lit(1))]), effect(5, [2], [set(3, read(2))])], functions: [fn(6, [inc(1)])], schedule: [4, 5] }), { update: (x: any) => observed.push(x.state()) });
  dispatch(m, 6); expect(observed.at(-1)).toMatchObject({ s2: 1, s3: 1 });
  expect(observed.every(x => x.s2 === x.s3)).toBe(true);
});

test("equal owned arrays are changes on every write, write-back is not", () => {
  const array = { kind: "array", element: I } as const;
  const value = e({ kind: "array", element: I, items: [lit(1)] }, array);
  const m = run(program({ signals: [{ ...signal(1), type: array, seed: value }], functions: [fn(2, [{ kind: "let", binder: binder(3, "items", array), init: value }, set(1, read(3, "local", array)), set(1, read(3, "local", array)), set(1, read(1, "signal", array), { writeBack: true })])] }));
  expect(events(dispatch(m, 2), "set").map((x: any) => x.changed)).toEqual([true, true, false]);
});

test("equal non-primitive memo recomputation changes its version", () => {
  const array = { kind: "array", element: I } as const;
  const body = e({ kind: "array", element: I, items: [lit(0)] }, array);
  const m = run(program({ signals: [signal(1), signal(2)], memos: [memo(3, [1], body)], effects: [effect(4, [3], [inc(2)])], functions: [fn(5, [inc(1)])], schedule: [3, 4] }));
  expect(dispatch(m, 5).state.s2).toBe(1);
});

test("owned arguments and local assignments have value semantics", () => {
  const array = { kind: "array", element: I } as const;
  const a = binder(3, "a", array), b = binder(4, "b", array);
  const m = run(program({ signals: [signal(1)], functions: [fn(2, [{ kind: "let", binder: a, init: e({ kind: "array", element: I, items: [lit(1)] }, array) }, { kind: "let", binder: b, init: read(3, "local", array) }, { kind: "assign", target: { kind: "element", owner: 4, index: lit(0) }, value: lit(9) }, set(1, e({ kind: "index", object: read(3, "local", array), index: lit(0) }))])] }));
  expect(dispatch(m, 2).state.s1).toBe(1);
});

test("regions are independent, reset on remount, and memo caches exist at construction", () => {
  const p = program({ signals: [signal(1, 7)], memos: [memo(2, [1], bin(read(1), "*", lit(2)))], functions: [fn(3, [inc(1)])], schedule: [2] });
  p.modules.push({ ...p.modules[0]!, name: "Child", kind: "factory" });
  const m = run(p); const a = m.mount("Child"), b = m.mount("Child");
  expect(m.state(a)).toMatchObject({ s1: 7, m2: 14 });
  m.frame({ dispatch: [{ fn: 3, region: a }] }); expect(m.state(a).s1).toBe(8); expect(m.state(b).s1).toBe(7);
  m.unmount(a); const c = m.mount("Child"); expect(c).not.toBe(a); expect(m.state(c).s1).toBe(7);
});

test("i32 arithmetic wraps at each operation", () => {
  const m = run(program({ signals: [signal(1)], functions: [fn(2, [set(1, bin(lit(2147483647), "+", lit(1)))])] }));
  expect(dispatch(m, 2).state.s1).toBe(-2147483648);
});

test("dynamic out-of-range read supplies element default", () => {
  const array = { kind: "array", element: I } as const;
  const m = run(program({ signals: [signal(1, 9)], functions: [fn(2, [set(1, e({ kind: "index", object: e({ kind: "array", element: I, items: [lit(2)] }, array), index: lit(8) }))])] }));
  expect(dispatch(m, 2).state.s1).toBe(0);
});

for (const development of [false, true]) test(`capacity uses UTF-8 boundaries: development=${development}`, () => {
  const m = run(program({ signals: [{ ...signal(1, ""), capacity: 4 }], functions: [fn(2, [set(1, lit("ééé"))])] }), { development });
  if (development) expect(() => dispatch(m, 2)).toThrow("s1");
  else expect(dispatch(m, 2).state.s1).toBe("éé");
});

test("development recursion guard names function", () => {
  const m = run(program({ functions: [fn(1, [{ kind: "call", callee: 1, args: [] }])] }), { recursionLimit: 4 });
  expect(() => dispatch(m, 1)).toThrow("f1");
});

test("helper return does not escape caller", () => {
  const m = run(program({ signals: [signal(1)], functions: [fn(2, [{ kind: "call", callee: 3, args: [] }, set(1, lit(2))]), fn(3, [{ kind: "return" }, set(1, lit(9))])] }));
  expect(dispatch(m, 2).state.s1).toBe(2);
});

const wait = (source: any, target?: any) => ({ kind: "await", source, binder: target });
const frames = (n: number) => ({ kind: "frames", count: lit(n) });
const start = (task: number) => ({ kind: "start", task, args: [] });

test("task segment zero runs immediately, frames continuation runs before dispatch", () => {
  const m = run(program({ signals: [signal(1), signal(2)], functions: [fn(3, [set(1, lit(1)), wait(frames(1)), set(1, lit(2))], true), fn(4, [start(3)]), fn(5, [set(2, read(1))])] }));
  expect(dispatch(m, 4).state.s1).toBe(1);
  const f = dispatch(m, 5); expect(f.state).toMatchObject({ s1: 2, s2: 2 });
  expect(f.trace.findIndex((x: any) => x.kind === "task-resume")).toBeLessThan(f.trace.findIndex((x: any) => x.kind === "handler"));
});

test("until uses one boundary snapshot for all tasks", () => {
  const m = run(program({ signals: [signal(1), signal(2)], functions: [fn(3, [wait(frames(1)), set(1, lit(1))], true), fn(4, [wait({ kind: "until", predicate: bin(read(1), ">", lit(0), B) }), set(2, lit(1))], true), fn(5, [start(3), start(4)])] }));
  dispatch(m, 5); expect(m.frame().state).toMatchObject({ s1: 1, s2: 0 });
  expect(m.frame().state.s2).toBe(1);
});

test("until made true in dispatch resumes at following boundary", () => {
  const m = run(program({ signals: [signal(1), signal(2)], functions: [fn(3, [wait({ kind: "until", predicate: bin(read(1), ">", lit(0), B) }), set(2, lit(1))], true), fn(4, [start(3), set(1, lit(1))])] }));
  expect(dispatch(m, 4).state.s2).toBe(0); expect(m.frame().state.s2).toBe(1);
});

test("restart keeps writes and commands of cancelled segment", () => {
  const m = run(program({ signals: [signal(1)], functions: [fn(2, [inc(1), { kind: "external", op: "jump", args: [lit(1)] }, wait(frames(3)), inc(1)], true), fn(3, [start(2), start(2)])] }));
  const f = dispatch(m, 3); expect(f.state.s1).toBe(2);
  expect(events(f, "command")).toHaveLength(2);
  expect(f.trace.filter((x: any) => ["task-start", "task-cancel"].includes(x.kind)).map((x: any) => x.kind)).toEqual(["task-start", "task-cancel", "task-start"]);
});

test("TaskId includes function and region identities", () => {
  const p = program({ functions: [fn(1, [wait(frames(5))], true), fn(2, [wait(frames(5))], true), fn(3, [start(1), start(2)])] });
  p.modules.push({ ...p.modules[0]!, name: "Child", kind: "factory" });
  const m = run(p); const a = m.mount("Child");
  const f = m.frame({ dispatch: [{ fn: 3 }, { fn: 3, region: a }] });
  expect(new Set(events(f, "task-start").map((x: any) => JSON.stringify(x.task))).size).toBe(4);
});

test("task resume order is region creation then task start", () => {
  const p = program({ functions: [fn(1, [wait(frames(1))], true), fn(2, [wait(frames(1))], true), fn(3, [start(2), start(1)])] });
  p.modules.push({ ...p.modules[0]!, name: "Child", kind: "factory" });
  const m = run(p), a = m.mount("Child");
  m.frame({ dispatch: [{ fn: 3, region: a }, { fn: 3 }] });
  expect(events(m.frame(), "task-resume").map((x: any) => [x.task.region, x.task.fn])).toEqual([[1, 2], [1, 1], [a, 2], [a, 1]]);
});

test("unmount cancels child task and retains app task", () => {
  const p = program({ signals: [signal(1)], functions: [fn(2, [wait(frames(1)), inc(1)], true)] });
  p.modules.push({ ...p.modules[0]!, name: "Child", kind: "factory" });
  const m = run(p), a = m.mount("Child"); m.frame({ dispatch: [{ fn: 2 }, { fn: 2, region: a }] });
  m.unmount(a); expect(m.frame().state.s1).toBe(1);
});

for (const rate of [30, 60]) test(`after deadline uses virtual time at ${rate} Hz`, () => {
  const m = run(program({ signals: [signal(1)], functions: [fn(2, [wait({ kind: "after", ms: lit(100) }), inc(1)], true)] }));
  dispatch(m, 2, [], { clock: 0 });
  for (let n = 1; n < rate / 10; n++) expect(m.frame({ clock: n * 1000 / rate }).state.s1).toBe(0);
  expect(m.frame({ clock: 100 }).state.s1).toBe(1);
});

test("any selects lowest ready leaf; nested wait leaves have distinct RequestIds", () => {
  const source = { kind: "any", members: [{ kind: "all", members: [frames(1), frames(1)] }, frames(1)] };
  const m = run(program({ signals: [signal(1)], functions: [fn(2, [wait(source), inc(1)], true)] }));
  const f = dispatch(m, 2); const ids = events(f, "wait").map((x: any) => x.request.member);
  expect(ids).toEqual([0, 1, 2]); expect(m.frame().state.s1).toBe(1);
});

for (const wrapped of [false, true]) test(`join cancellation propagation: wrapped=${wrapped}`, () => {
  const result = binder(6, "joined", { kind: "named", name: "Join" });
  const m = run(program({ signals: [signal(1)], functions: [fn(2, [wait(frames(8))], true), fn(3, [wait({ kind: "join", task: 2, wrapped, args: [] }, result), inc(1)], true), fn(4, [start(3)]), fn(5, [{ kind: "external", op: "cancel", args: [lit(2)] }])] }));
  dispatch(m, 4); dispatch(m, 5); expect(m.frame().state.s1).toBe(wrapped ? 1 : 0);
});

test("a local live across await is hoisted and snapshotted", () => {
  const array = { kind: "array", element: I } as const;
  const p = program({ signals: [{ ...signal(1), type: array, seed: e({ kind: "array", element: I, items: [lit(7)] }, array) }, signal(2)], functions: [fn(3, [{ kind: "let", binder: { ...binder(4, "old", array), owned: false }, init: read(1, "signal", array) }, wait(frames(1)), set(2, e({ kind: "index", object: read(4, "local", array), index: lit(0) }))], true), fn(5, [start(3), set(1, e({ kind: "array", element: I, items: [lit(9)] }, array))])] });
  const lowered = lowerModelTasks(p); expect(lowered.modules[0]!.tasks[0]!.fields).toEqual([expect.objectContaining({ id: 4, owned: true })]);
  const m = new ModelInterpreter(lowered); dispatch(m, 5); expect(m.frame().state.s2).toBe(7);
});

test("coroutine lowering cuts nested branches and bounded loops", () => {
  const counter = binder(4);
  const m = run(program({ signals: [signal(1)], functions: [fn(2, [{ kind: "for", binder: counter, bound: lit(3), body: block({ kind: "if", condition: bin(read(4, "local"), ">=", lit(0), B), then: block(wait(frames(1)), inc(1)) }) }], true)] }));
  dispatch(m, 2); expect(m.frame().state.s1).toBe(1); expect(m.frame().state.s1).toBe(2); expect(m.frame().state.s1).toBe(3);
});

test("65 signals do not share a fixed-width dirty mask", () => {
  const signals = Array.from({ length: 65 }, (_, i) => signal(i + 1));
  const m = run(program({ signals, functions: [fn(100, [inc(65)])], effects: [effect(101, [65], [inc(1)])], schedule: [101] }));
  expect(dispatch(m, 100).state).toMatchObject({ s1: 1, s65: 1 });
});
