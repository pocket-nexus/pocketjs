import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
const root=resolve(import.meta.dir,"..");
test("Zephyr display strips and synchronized input preserve driver contracts",()=>{
  const out=join(root,".pocket-build/validation/packaging-stage9/zephyr-contract");mkdirSync(out,{recursive:true});
  const compile=Bun.spawnSync(["cc","-std=c11","-Wall","-Wextra","-Werror","-I",join(root,"tests/fixtures/zephyr/include"),"-I",join(root,"contracts/generated"),"-I",join(root,"platforms/zephyr/include"),
    join(root,"tests/fixtures/zephyr/contracts.c"),join(root,"platforms/zephyr/display/display.c"),join(root,"platforms/zephyr/input/input.c"),"-o",join(out,"contracts")],{stdout:"pipe",stderr:"pipe"});
  expect(compile.success,compile.stderr.toString()).toBe(true);
  const run=Bun.spawnSync([join(out,"contracts")],{stdout:"pipe",stderr:"pipe"});expect(run.success,run.stderr.toString()).toBe(true);expect(run.stdout.toString()).toContain("Zephyr driver contracts passed");
});
