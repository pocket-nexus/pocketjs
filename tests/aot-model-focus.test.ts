import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeModelView } from "../microts/compiler/model-view-harness.ts";

test("negative row 05 releases nested Show focus targets when the outer block unmounts", async () => {
  const fixture = resolve("tests/fixtures/aot-model/negative/05-nested-show");
  const expected = JSON.parse(readFileSync(resolve(fixture, "expected.json"), "utf8"));
  const { javascript, rust } = await executeModelView(fixture);
  expect(javascript.frames).toEqual(expected.frames);
  expect(rust).toEqual(javascript);
}, 120_000);
