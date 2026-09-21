import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { interpretModel } from "../microts/compiler/model-interp.ts";
import { assertModelObservations, executeModelJavaScript, executeModelRust, observeModelFrames } from "../microts/compiler/model-harness.ts";

test("nested any cancels a losing service at its own boundary and drops its late result", async () => {
  const folder = resolve("tests/fixtures/aot-model/services/nested-any");
  const expected = JSON.parse(readFileSync(resolve(folder,"expected.json"),"utf8"));
  const fixture = { name:"nested-any", program:analyzeModel(resolve(folder,"App.ts")), tape:JSON.parse(readFileSync(resolve(folder,"tape.json"),"utf8")), services:expected.services };
  const reference = observeModelFrames(interpretModel(fixture.program,fixture.tape,{services:fixture.services}));
  expect(reference.map(frame=>frame.state.result)).toEqual(expected.states);
  expect(reference[expected.cancelFrame-1]!.trace.filter(event=>event.kind==="request-cancel")).toHaveLength(1);
  expect(reference[expected.dropFrame-1]!.trace.filter(event=>event.kind==="delivery-drop")).toHaveLength(1);
  expect(reference.at(-1)!.trace.filter(event=>event.kind==="request-cancel")).toEqual([]);
  assertModelObservations("nested any JS",reference,await executeModelJavaScript(fixture),fixture.tape);
  const native=await executeModelRust([fixture]);
  assertModelObservations("nested any Rust",reference,native.get(fixture.name)!,fixture.tape);
},120_000);
