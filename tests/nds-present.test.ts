import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test("NDS presentation preserves damage on both VRAM pages and skips idle copies", () => {
  const directory = resolve(".pocket-build/validation/nds-present", `${Date.now()}-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const binary = resolve(directory, "present");
  const compile = Bun.spawnSync([process.env.CC ?? "cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
    "-Ihosts/nds/include", "hosts/nds/tests/present.c", "-o", binary], { stdout: "pipe", stderr: "pipe" });
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
  const check = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe" });
  expect(check.exitCode, check.stdout.toString() + check.stderr.toString()).toBe(0);
});
