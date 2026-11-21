import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { admitBundle, admitPlan, cadenceFor, describeRejection } from "../contracts/spec/admission.ts";
import { decodeBundle } from "../contracts/spec/bundle.ts";
import { admissionCorpus, type AdmissionCase } from "../tools/bundle-corpus.ts";

const directory = resolve(import.meta.dir, "../engine/package/tests/fixtures/admission");

test("the committed admission corpus is the generator's output", () => {
  const corpus = admissionCorpus();
  expect(Buffer.from(readFileSync(resolve(directory, "bundle.pkb"))).equals(Buffer.from(corpus.bundle))).toBe(true);
  expect(JSON.parse(readFileSync(resolve(directory, "cases.json"), "utf8"))).toEqual(corpus.cases);
});

test("tool admission matches every corpus case", () => {
  const bundle = decodeBundle(readFileSync(resolve(directory, "bundle.pkb")));
  const cases: AdmissionCase[] = JSON.parse(readFileSync(resolve(directory, "cases.json"), "utf8"));
  for (const item of cases) {
    const admission = admitBundle(bundle, item.host);
    if (item.admitted) expect(admission, item.name).toEqual({ ok: true, timing: item.admitted.timing });
    else expect(admission, item.name).toEqual({ ok: false, ...item.rejected! });
  }
});

test("superset hosts admit; missing items are named; the host contract hash is provenance", () => {
  const { cases, bundle } = admissionCorpus();
  const names = new Set(cases.map(item => item.name));
  for (const name of ["added-capability", "added-viewport", "changed-id", "reordered-capabilities"]) {
    expect(cases.find(item => item.name === name)?.admitted, name).toBeDefined();
  }
  for (const name of ["missing-capability", "compiled-profile-missing-capability", "raster-density", "rate-not-divisible"]) {
    expect(cases.find(item => item.name === name)?.rejected, name).toBeDefined();
  }
  expect(names.size).toBe(cases.length);
  const rejected = admitBundle(decodeBundle(bundle), cases.find(item => item.name === "missing-capability")!.host);
  if (rejected.ok) throw new Error("admitted");
  expect(describeRejection(rejected)).toBe("not admitted: capability text.glyphs.baked");
});

test("rates need a dividing cadence within sixty core ticks per frame", () => {
  expect(cadenceFor(60, [60, 30])).toBe(60);
  expect(cadenceFor(60, [30, 20])).toBe(30);
  expect(cadenceFor(30, [60])).toBeNull();
  expect(cadenceFor(120, [1])).toBeNull();
  expect(cadenceFor(241, [241])).toBeNull();
  const host = { bindingGeneration: 1, profileHash: "", rasterDensity: 1, cadences: [60], logicalViewports: [[4, 4]] as [number, number][], capabilities: [] };
  expect(admitPlan(host, 1, new TextEncoder().encode("{}"))).toEqual({ ok: false, items: ["plan"] });
  expect(admitPlan(host, 2, new Uint8Array())).toEqual({ ok: false, items: ["bindingGeneration", "plan"] });
  expect(admitPlan(host, 1, { profile: { tickHz: 60 }, viewport: { logical: [4, 4], rasterDensity: 1 } }))
    .toEqual({ ok: true, timing: { tickHz: 60, cadenceHz: 60 } });
});
