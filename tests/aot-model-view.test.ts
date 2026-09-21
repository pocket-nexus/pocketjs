import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeModelView } from "../microts/compiler/model-view-harness.ts";

test.each(["view-frame","negative/04-region-reset"])("generated model and view %s preserve frame atomicity, dispatch memo reads, command order and remount reset", async name => {
  const fixture=resolve("tests/fixtures/aot-model",name);
  const expected=JSON.parse(readFileSync(resolve(fixture,"expected.json"),"utf8"));
  const {javascript,rust}=await executeModelView(fixture);
  expect(javascript.frames).toEqual(expected.frames??expected);
  expect(rust).toEqual(javascript);
},120_000);
