import { expect, test } from "bun:test";
import { generateModelCase, MODEL_FUZZ_DIAGNOSTICS, MODEL_FUZZ_COVERAGE, MODEL_FUZZ_PROBES, MODEL_FUZZ_SEEDS, runModelFuzz, shrinkModelFailure } from "../microts/compiler/model-fuzz.ts";

test("grammar generation is deterministic and honors disabled construct weights", () => {
  expect(generateModelCase(431)).toEqual(generateModelCase(431));
  const reduced = generateModelCase(431, { weights: { task: 0, array: 0, memo: 0 } });
  expect(reduced.coverage).not.toContain("task");
  expect(reduced.coverage).not.toContain("owned-array");
  expect(reduced.coverage).not.toContain("memo");
});

test("fixed model grammar seeds obey three-way trace equality, replay and scheduler invariants", async () => {
  const result = await runModelFuzz(MODEL_FUZZ_SEEDS);
  expect(result.programs).toBe(new Set([...MODEL_FUZZ_PROBES, ...MODEL_FUZZ_SEEDS]).size);
  expect(result.coverage).toEqual([...MODEL_FUZZ_COVERAGE]);
}, 60_000);

test("invalid grammar mode rejects each of its seven semantic violations", async () => {
  const result = await runModelFuzz([0, 1, 2, 3, 4, 5, 6], { invalid: true, requiredCoverage: MODEL_FUZZ_DIAGNOSTICS.map(d => `diagnostic:${d}`) });
  expect(result.programs).toBe(7);
}, 60_000);

import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { interpretModel } from "../microts/compiler/model-interp.ts";
test("failure reduction reaches a fixed point over irrelevant statements and tape entries", async () => {
  const generated = generateModelCase(1, { weights: { array: 0, memo: 0, task: 0 } });
  const source = `import { createSignal } from "solid-js"; export const [n,setN]=createSignal(0); export function press(){setN(1);setN(2);setN(3);}`;
  const program = analyzeModel(generated.entry, { source });
  const fails = (candidate: typeof program, tape: typeof generated.tape) => interpretModel(candidate, tape).some(frame => frame.trace.some(event => event.kind === "set" && event.value === 2));
  const reduced = await shrinkModelFailure(program, [{dispatch:[{fn:"press"}]}, {}, {}], fails);
  expect(reduced.tape).toHaveLength(1);
  expect(reduced.program.modules[0]!.functions[0]!.body.stmts).toHaveLength(1);
  expect(reduced.program.modules[0]!.functions[0]!.body.stmts[0]).toMatchObject({kind:"set",value:{kind:"literal",value:2}});
  expect(await shrinkModelFailure(reduced.program, reduced.tape, fails)).toEqual(reduced);
});


test("deterministic grammar probes cover every required generated row",()=>{
 const coverage=new Set(MODEL_FUZZ_PROBES.flatMap(seed=>generateModelCase(seed).coverage));
 expect([...coverage].sort()).toEqual([...MODEL_FUZZ_COVERAGE]);
});

import { generateModelViewCase, runModelViewFuzz } from "../microts/compiler/model-view-fuzz.ts";
test("generated view probes exercise atomic Show and independent factory mounts on three classes",async()=>{
 expect(generateModelViewCase(431)).toEqual(generateModelViewCase(431));
 const result=await runModelViewFuzz([431]);expect(result.coverage).toContain("atomic-show");
},120_000);
