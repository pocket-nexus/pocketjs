import { expect, test } from "bun:test";
import { resolve } from "node:path";
test("PSP production guest uses canonical runtime, providers, input and shutdown", () => {
  const result = Bun.spawnSync([process.execPath, "tools/test-psp-runtime.ts"], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(result.success, `${result.stdout.toString()}\n${result.stderr.toString()}\nsignal=${result.signalCode}`).toBe(true);
}, 180_000);

import { pspLinkArguments, responseWords } from "../tools/psp-linker.ts";

test("PSP SDK fallback libraries follow Rust symbol owners without masking duplicates", () => {
  const args = ["-flavor", "gnu", "main.o", "-Bstatic", "quickjs.rlib", "-lc", "-lm", "-lpthread-psp", "-lcglue", "psp.rlib", "core.rlib", "-Bdynamic", "--gc-sections", "-o", "app.elf"];
  const linked = pspLinkArguments(args);
  expect(linked).toEqual(["-flavor", "gnu", "main.o", "-Bstatic", "quickjs.rlib", "psp.rlib", "core.rlib", "-Bstatic", "-lc", "-lm", "-lpthread-psp", "-lcglue", "-Bdynamic", "--gc-sections", "-o", "app.elf"]);
  expect(linked.some(arg => arg.includes("multiple-definition"))).toBe(false);
  expect(pspLinkArguments(["-flavor", "gnu", "stub.o", "-o", "stub.elf"])).toEqual(["-flavor", "gnu", "stub.o", "-o", "stub.elf"]);
  expect(() => pspLinkArguments(["-lc"])).toThrow("without Rust archives");
});

test("PSP linker response arguments preserve spaces and escaped path characters", () => {
  expect(responseWords('"/tmp/a b/psp.rlib" -lc \'x y.rlib\' plain\\ path.rlib ""')).toEqual(["/tmp/a b/psp.rlib", "-lc", "x y.rlib", "plain path.rlib", ""]);
  expect(() => responseWords('"unfinished')).toThrow("unterminated");
  expect(() => responseWords("unfinished\\")).toThrow("incomplete");
});
