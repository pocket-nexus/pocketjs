import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Nintendo 3DS Pocket Runtime storage", () => {
  test("stages immutable packages and appends active/last-good generations", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-3ds-runtime-"));
    temporary.push(directory);
    const binary = join(directory, "runtime-state-test");
    const compiler = Bun.which("cc");
    expect(compiler).not.toBeNull();
    const compile = Bun.spawnSync([
      compiler!,
      "-std=c11",
      "-D_POSIX_C_SOURCE=200809L",
      '-DPOCKETJS_TARGET_ID="3ds-dev"',
      `-DPOCKETJS_HOST_ABI=${POCKET_BINDING_GENERATION}`,
      `-I${join(ROOT, "products/3ds/include")}`,
      `-I${join(ROOT, "contracts/generated")}`,
      `-I${join(ROOT, "products/3ds/src")}`,
      join(ROOT, "tests/fixtures/3ds-runtime-state.c"),
      join(ROOT, "products/3ds/src/runtime.c"),
      // runtime_slot_remove deletes a slot with fs.c's tree removal.
      join(ROOT, "products/3ds/src/fs.c"),
      join(ROOT, "products/3ds/src/jscan.c"),
      "-o",
      binary,
    ]);
    expect(compile.success, `exit=${compile.exitCode}, signal=${compile.signalCode}\n${compile.stderr}`).toBe(true);

    const run = Bun.spawnSync([binary, directory]);
    expect(run.success, `exit=${run.exitCode}, signal=${run.signalCode}\n${run.stderr}`).toBe(true);
  });
});
