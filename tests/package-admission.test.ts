import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { admitPlan, cadenceFor, describeRejection, selectVariant } from "../contracts/spec/admission.ts";
import { decodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { admissionCorpus, type AdmissionCase } from "../tools/package-corpus.ts";

const directory = resolve(import.meta.dir, "../engine/package/tests/fixtures/admission");

test("the committed admission corpus is the generator's output", () => {
  const corpus = admissionCorpus();
  expect(Buffer.from(readFileSync(resolve(directory, "package.pocket"))).equals(Buffer.from(corpus.package))).toBe(true);
  expect(JSON.parse(readFileSync(resolve(directory, "cases.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(corpus.cases)));
});

test("tool admission matches every corpus case", () => {
  const pkg = decodePocketPackage(readFileSync(resolve(directory, "package.pocket")));
  const cases: AdmissionCase[] = JSON.parse(readFileSync(resolve(directory, "cases.json"), "utf8"));
  for (const item of cases) {
    const selection = selectVariant(pkg, item.host);
    if (item.admitted) {
      expect(selection, item.name).toEqual({ ok: true, index: item.admitted.variant, variant: pkg.variants[item.admitted.variant]!, timing: item.admitted.timing });
    } else {
      const { variant, ...rest } = item.rejected!;
      expect(selection, item.name).toEqual({ ok: false, index: variant, ...rest });
    }
  }
});

test("superset hosts admit; missing items are named", () => {
  const { cases } = admissionCorpus();
  const names = new Set(cases.map(item => item.name));
  for (const name of ["added-capability", "added-viewport", "changed-id", "reordered-capabilities"]) {
    expect(cases.find(item => item.name === name)?.admitted, name).toBeDefined();
  }
  for (const name of ["missing-capability", "raster-density", "rate-not-divisible"]) {
    expect(cases.find(item => item.name === name)?.rejected, name).toBeDefined();
  }
  expect(names.size).toBe(cases.length);
  const pkg = decodePocketPackage(admissionCorpus().package);
  const rejected = selectVariant(pkg, cases.find(item => item.name === "missing-capability")!.host);
  if (rejected.ok) throw new Error("admitted");
  expect(describeRejection(rejected)).toBe("variant 0 is not admitted: capability text.glyphs.baked");
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
