import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UI_OPS, UI_IDF_OPS, UI_LEGACY_C_OPS, validateUiOps } from "../contracts/spec/ui-ops.ts";
import { OP } from "../contracts/spec/spec.ts";
import { generatedUiBindings } from "../tools/ui-bindings.ts";

const root = resolve(import.meta.dir, "..");
describe("generated UI call contract", () => {
  test("covers every HostOps method without numbering private hooks", () => {
    validateUiOps();
    const source=readFileSync(resolve(root,"framework/src/host.ts"),"utf8").split("export interface HostOps {")[1]!.split("\n}\n")[0]!;
    const methods=[...source.matchAll(/^  (\w+)\??\(/gm)].map(match=>match[1]).sort();
    expect(UI_OPS.map((op):string=>op.name).sort()).toEqual(methods);
    expect(UI_OPS.length).toBe(67);
    expect(UI_OPS.filter(op=>op.id===null).map(op=>op.name)).toEqual(["__dbgActive","__dbgConnected","__dbgPoll","__dbgSend","__dbgShot","__reportAppAction"]);
    expect(UI_OPS.filter(op=>op.id!==null).map((op):number|null=>op.id)).toEqual(Array.from({length:61},(_,i)=>i+1));
    expect(OP.physicsQuery).toBe(56);
    expect([OP.setPropBatch,OP.takeAnimationCompletions,OP.fontStreamBatch,OP.captureTexts,OP.capturedTexts]).toEqual([57,58,59,60,61]);
  });
  test("preserves legacy mount subsets and excludes lifecycle APIs", () => {
    expect([...UI_IDF_OPS] as number[]).toEqual([...Array.from({length:17},(_,i)=>i+1),24,25,26,27,28,29,42,43]);
    expect([...UI_LEGACY_C_OPS] as number[]).toEqual([...Array.from({length:22},(_,i)=>i+1),24,25,26,27,28,29,42,57,58]);
    for(const name of ["tick","render","setViewport","alloc","free","initialize","shutdown"]) expect(UI_OPS.some(op=>op.name===name)).toBe(false);
  });
  test("generated dispatcher and QuickJS binding descriptors have no drift", () => {
    for(const [path,content] of generatedUiBindings()) expect(readFileSync(resolve(root,path),"utf8"),path).toBe(content);
  });
});
