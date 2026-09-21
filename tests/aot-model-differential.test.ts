import { beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { AotCompileError } from "../microts/compiler/aot-ir.ts";
import { analyzeModel } from "../microts/compiler/aot-model-frontend.ts";
import { interpretModel } from "../microts/compiler/model-interp.ts";
import { assertModelObservations, executeModelJavaScript, executeModelRust, observeModelFrames, type ModelObservation } from "../microts/compiler/model-harness.ts";

const cases = ["core", "negative"].flatMap(group => {
  const root = resolve("tests/fixtures/aot-model", group);
  return readdirSync(root).sort().map(name => ({ name: `${group}/${name}`, entry: resolve(root, name, "App.ts"),
    tape: JSON.parse(readFileSync(resolve(root, name, "tape.json"), "utf8")), expected: JSON.parse(readFileSync(resolve(root, name, "expected.json"), "utf8")) }));
});
const fixtures = cases.filter(fixture => !fixture.expected.diagnostic && !fixture.expected.viewOnly).map(fixture => ({ ...fixture, program: analyzeModel(fixture.entry) }));
test.each(cases.filter(fixture => fixture.expected.diagnostic))("model negative $name reports its fixed source diagnostic", fixture => {
  try { analyzeModel(fixture.entry, { sources: new Map([[fixture.entry, readFileSync(fixture.entry, "utf8")]]) }); throw new Error("Accepted rejected model fixture"); }
  catch (error) { expect(error).toBeInstanceOf(AotCompileError); const diagnostic = (error as AotCompileError).diagnostics[0]!;
    expect(diagnostic.message).toContain(fixture.expected.diagnostic);
    expect([diagnostic.file, diagnostic.line, diagnostic.column]).toEqual([fixture.entry, fixture.expected.line, fixture.expected.column]); }
});
let native: Map<string, ModelObservation[]>;
beforeAll(async () => { native = await executeModelRust(fixtures); }, 120_000);

test.each(fixtures)("model core $name agrees on hand-written expectations and three executable classes", async fixture => {
  // Regenerate IR from TypeScript; the maintained baseline is the hand-written behavior.
  const reference = interpretModel(fixture.program, fixture.tape);
  expect(reference.at(-1)!.state).toMatchObject(fixture.expected.state);
  if(fixture.expected.work){expect(reference[0]!.counts).toMatchObject(fixture.expected.work);expect(native.get(fixture.name)![0]!.counts).toMatchObject(fixture.expected.work);}
  expect(reference[0]!.trace.filter(event => event.kind === "set").map(({name,value,changed}) => ({name,value,changed}))).toEqual(fixture.expected.writes);
  const effects = fixture.program.modules[0]!.effects;
  const operations = reference[0]!.trace.filter(event => event.kind !== "handler").map(event => event.kind === "set"
    ? { kind: event.kind, name: event.name, value: event.value, changed: event.changed }
    : event.kind === "memo" ? { kind: event.kind, name: event.name, value: event.value, changed: event.changed, mode: event.mode }
    : { kind: event.kind, effect: effects.findIndex(effect => effect.id === event.id), initial: event.initial });
  expect(operations).toEqual(fixture.expected.operations);
  expect(reference[1]!.trace).toEqual([]);
  const expected = observeModelFrames(reference);
  assertModelObservations(`${fixture.name}: Rust`, expected, native.get(fixture.name)!, fixture.tape);
  assertModelObservations(`${fixture.name}: Solid`, expected, await executeModelJavaScript(fixture, !!fixture.expected.vue), fixture.tape);
  assertModelObservations(`${fixture.name}: Solid replay`, expected, await executeModelJavaScript(fixture, !!fixture.expected.vue), fixture.tape);
  assertModelObservations(`${fixture.name}: replay`, expected, observeModelFrames(interpretModel(fixture.program, fixture.tape)), fixture.tape);
});


test.each([
  ["overflow-add", (source: string) => source.replace(/\| 0/g, "")],
  ["owned-twice", (source: string) => source.replace(/, false\)/g, ", true)")],
  ["pre-once", (source: string) => source + `
    const write=__modelRegion.write.bind(__modelRegion); let flushing=false;
    __modelRegion.write=(...args)=>{write(...args);if(!flushing){flushing=true;try{__modelRegion.react();}finally{flushing=false;}}};`],
] as const)("test power catches the %s backend mutation", async (name, transform) => {
  const fixture = fixtures.find(fixture => fixture.name === `core/${name}`)!;
  const expected = observeModelFrames(interpretModel(fixture.program, fixture.tape));
  const actual = await executeModelJavaScript(fixture, false, transform);
  expect(() => assertModelObservations(`mutated ${name}`, expected, actual, fixture.tape)).toThrow("first differs at frame");
});

test("test power rejects reversing a causality-constrained schedule", () => {
  const fixture = fixtures.find(fixture => fixture.name === "core/atomic-chain")!;
  const changed = structuredClone(fixture.program); changed.modules[0]!.schedule.reverse();
  expect(() => interpretModel(changed, fixture.tape)).toThrow("schedule edge");
});

const foundRoot = resolve("tests/fixtures/aot-model/found");
for (const name of existsSync(foundRoot) ? readdirSync(foundRoot).sort() : []) {
  test(`reduced grammar regression ${name} remains fixed`, async () => {
    const program = JSON.parse(readFileSync(resolve(foundRoot, name, "model.json"), "utf8"));
    const source=resolve(foundRoot,name,"App.ts");
    if(existsSync(source)){const analyzed=analyzeModel(source);const relativeProgram=JSON.parse(JSON.stringify(analyzed,(key,value)=>key==="file"&&typeof value==="string"?relative(process.cwd(),value):value));expect(relativeProgram).toEqual(program);}
    const tape = JSON.parse(readFileSync(resolve(foundRoot, name, "tape.json"), "utf8"));
    const optionsFile=resolve(foundRoot,name,"options.json");
    const options=existsSync(optionsFile)?JSON.parse(readFileSync(optionsFile,"utf8")):{};
    const fixture = { name, program, tape, ...options }, expected = observeModelFrames(interpretModel(program, tape, options));
    const saved=JSON.parse(readFileSync(resolve(foundRoot,name,"expected.json"),"utf8"));
    assertModelObservations(`regression ${name}: reference`,saved.reference,expected,tape);
    assertModelObservations(`regression ${name}: JS`, expected, await executeModelJavaScript(fixture), tape);
    const native = await executeModelRust([fixture]);
    assertModelObservations(`regression ${name}: Rust`, expected, native.get(name)!, tape);
  }, 120_000);
}
