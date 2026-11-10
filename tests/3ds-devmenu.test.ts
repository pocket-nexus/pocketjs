// The 3DS program's development menu (products/3ds/src/devmenu.c), compiled
// for this machine: its page is a list of rectangles inside the touch screen.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

describe("Nintendo 3DS development menu", () => {
  test("the native menu emits one bounded rectangle-only DrawList", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-3ds-devmenu-"));
    temporary.push(directory);
    const binary = join(directory, "devmenu-test");
    const compiler = Bun.which("cc");
    expect(compiler).not.toBeNull();
    const compile = Bun.spawnSync([
      compiler!,
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-I${join(ROOT, "products/3ds/src")}`,
      `-I${join(ROOT, "products/3ds/include")}`,
      `-I${join(ROOT, "contracts/generated")}`,
      join(ROOT, "tests/fixtures/3ds-devmenu.c"),
      join(ROOT, "products/3ds/src/devmenu.c"),
      "-o",
      binary,
    ]);
    expect(compile.success, `exit=${compile.exitCode}, signal=${compile.signalCode}\n${compile.stderr}`).toBe(true);
    const run = Bun.spawnSync([binary]);
    expect(run.success, `exit=${run.exitCode}, signal=${run.signalCode}\n${run.stderr}`).toBe(true);
  });
});
