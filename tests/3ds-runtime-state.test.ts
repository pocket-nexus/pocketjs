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
      "-DPOCKETJS_HOST_ABI=8",
      `-I${join(ROOT, "hosts/3ds/include")}`,
      `-I${join(ROOT, "hosts/3ds/src")}`,
      join(ROOT, "tests/fixtures/3ds-runtime-state.c"),
      join(ROOT, "hosts/3ds/src/runtime.c"),
      "-o",
      binary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);

    const run = Bun.spawnSync([binary, directory]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  });
});
