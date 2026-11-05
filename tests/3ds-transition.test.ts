// tests/3ds-transition.test.ts — the 3DS host's app-switch overlay
// (products/3ds/src/transition.c), compiled for the build machine: the phases'
// timing, the scrim's opacity, and the indicator's dots.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Nintendo 3DS switch transition", () => {
  test("leaves, loads and arrives with the scrim and indicator it promises", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-3ds-transition-"));
    temporary.push(directory);
    const binary = join(directory, "transition-test");
    const compiler = Bun.which("cc");
    expect(compiler).not.toBeNull();
    const compile = Bun.spawnSync([
      compiler!,
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-I${join(ROOT, "products/3ds/src")}`,
      join(ROOT, "tests/fixtures/3ds-transition.c"),
      join(ROOT, "products/3ds/src/transition.c"),
      "-lm",
      "-o",
      binary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  });
});
