import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(".pocket-build/validation/model-aot/codegen");
const protocol = resolve("tests/fixtures/aot-model/protocol");

test("memo protocol keeps render borrows and existing immutable implementations", () => {
  mkdirSync(output, { recursive: true });
  const binary = `${output}/read-only-render`;
  const check = Bun.spawnSync(["rustc", "--edition=2021", "--test", `${protocol}/read-only-render.rs`, "-o", binary]);
  expect(check.exitCode, check.stderr.toString()).toBe(0);
  const run = Bun.spawnSync([binary]);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
});

test.each([
  ["mutable-render-rejected", "E0502"],
  ["legacy-receiver-rejected", "E0053"],
])("rejected memo protocol alternative %s retains its compiler diagnostic", (fixture, code) => {
  mkdirSync(output, { recursive: true });
  const check = Bun.spawnSync(["rustc", "--edition=2021", "--crate-type=lib", `${protocol}/${fixture}.rs`, "--out-dir", output]);
  expect(check.exitCode).not.toBe(0);
  expect(check.stderr.toString()).toContain(code);
});

import type { ModelExpr, ModelModule, ModelProgram } from "../vapor/compiler/aot-model-ir.ts";
import { emptyLedger } from "../vapor/compiler/aot-model-ir.ts";
import { generateModelRust } from "../vapor/compiler/aot-model-codegen.ts";
import { I32, STRING, type AotType } from "../vapor/compiler/aot-ir.ts";
const loc = { file: "counter.ts", line: 1, column: 1, offset: 0 };
const lit = (value: number | string, type: AotType = typeof value === "string" ? STRING : I32): ModelExpr => ({ kind: "literal", value, type, ledger: emptyLedger(), loc });
const access = (kind: "signal" | "memo" | "local", id: number, type: AotType = I32): ModelExpr => ({ kind, id, type, ledger: { ...emptyLedger(), reads: [id] }, loc });
const plus = (left: ModelExpr, right: ModelExpr): ModelExpr => ({ kind: "binary", operator: "+", left, right, type: left.type, ledger: emptyLedger(), loc });
function counter(): ModelProgram {
  const model: ModelModule = {
    name: "Counter", file: "counter.ts", kind: "root", params: [], fields: [], refs: [], tasks: [],
    signals: [
      { id: 1, name: "count", exported: true, type: I32, seed: lit(0) },
      { id: 2, name: "history", exported: true, type: STRING, seed: lit("seed") },
      { id: 3, name: "runs", exported: true, type: I32, seed: lit(0) },
    ],
    memos: [{ id: 4, name: "double", exported: true, type: I32, inputs: [1], body: plus(access("signal", 1), access("signal", 1)) }],
    effects: [{ id: 5, subscriptions: [1], declared: true, defer: true, ledger: emptyLedger(), body: { stmts: [
      { kind: "set", signal: 3, pre: { id: 6, name: "old", type: I32, owned: true }, value: plus(access("local", 6), lit(1)) },
      { kind: "set", signal: 2, pre: { id: 7, name: "previous", type: STRING, owned: true }, value: plus(access("local", 7, STRING), lit("x")) },
    ] } }],
    functions: [{ id: 8, name: "press", exported: true, async: false, params: [], returns: { kind: "void" }, ledger: { ...emptyLedger(), writes: [1] }, body: { stmts: [{ kind: "set", signal: 1, pre: { id: 9, name: "before", type: I32, owned: true }, value: plus(access("local", 9), lit(1)) }] } }],
    schedule: [4, 5],
  };
  return { version: 1, modules: [model], types: [], diagnostics: [], recursionLimit: 256 };
}

export function checkModelRust(name: string, source: string, harness: string) {
  const directory = `${output}/${name}`;
  mkdirSync(`${directory}/src`, { recursive: true });
  writeFileSync(`${directory}/Cargo.toml`, `[package]\nname = "model-aot-${name}"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[dependencies]\npocket_vapor = { path = ${JSON.stringify(resolve("engine/crates/pocket-vapor"))}, features = ["std"] }\n`);
  writeFileSync(`${directory}/src/model.rs`, source);
  writeFileSync(`${directory}/src/lib.rs`, `mod model;\nuse model::*;\nuse pocket_vapor::{Cmd, Ready};\n${harness}`);
  const result = Bun.spawnSync(["cargo", "test", "--quiet", "--manifest-path", `${directory}/Cargo.toml`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: `${output}/target` } });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}

test("generated model implements seeds, once-per-reaction pre, on-demand memo and wrapping i32", () => {
  checkModelRust("counter", generateModelRust(counter()), `
#[test] fn counter_contract() {
    let mut m = CounterModel::default(); let mut cmds = Vec::new();
    assert_eq!(m.history(), "seed"); assert_eq!(m.double(), 0);
    m.react(true, &mut cmds); m.settle(); assert_eq!(m.runs(), 0);
    m.press(); m.press(); assert_eq!(m.double_now(), 4);
    m.react(false, &mut cmds); m.settle();
    assert_eq!(m.count(), 2); assert_eq!(m.double(), 4);
    assert_eq!(m.runs(), 1); assert_eq!(m.history(), "seedx");
    m.react(false, &mut cmds); m.settle(); assert_eq!(m.runs(), 1);
    m.set_count(i32::MAX); m.press(); assert_eq!(m.count(), i32::MIN);
}
`);
}, 120_000);

test("Rust emission is deterministic and rustfmt is idempotent", () => {
  const first = generateModelRust(counter());
  expect(generateModelRust(counter())).toBe(first);
  const file = `${output}/determinism.rs`;
  mkdirSync(output, { recursive: true }); writeFileSync(file, first);
  const format = () => Bun.spawnSync(["rustfmt", "--edition", "2021", file]);
  expect(format().exitCode).toBe(0);
  const once = readFileSync(file, "utf8"); expect(format().exitCode).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(once);
});
