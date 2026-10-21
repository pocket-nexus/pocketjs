import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
const root=resolve(import.meta.dir,"..");
test("IDF touch cancellation and GPIO/ADC debounce use canonical input frames",()=>{
  const out=join(root,".pocket-build/validation/packaging-stage9/idf-input");mkdirSync(out,{recursive:true});
  const include=join(root,"tests/fixtures/idf-input/include");
  const compile=Bun.spawnSync(["cc","-std=c11","-Wall","-Wextra","-Werror","-I",include,"-I",join(root,"contracts/generated"),
    ...["touch","gpio"].flatMap(n=>["-I",join(root,`platforms/esp-idf/pocket_input_${n}/include`)]),
    join(root,"tests/fixtures/idf-input/input.c"),...["touch","gpio"].map(n=>join(root,`platforms/esp-idf/pocket_input_${n}/src/input.c`)),"-o",join(out,"input")],{stdout:"pipe",stderr:"pipe"});
  expect(compile.success,compile.stderr.toString()).toBe(true);
  const run=Bun.spawnSync([join(out,"input")],{stdout:"pipe",stderr:"pipe"});expect(run.success,run.stderr.toString()).toBe(true);expect(run.stdout.toString()).toContain("IDF input contracts passed");
});
