import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Nintendo 3DS .3dsx installation", () => {
  test("stages, verifies and swaps .3dsx files, deferring the running one to its own file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-3ds-native-"));
    temporary.push(directory);
    const binary = join(directory, "native-install-test");
    const compiler = Bun.which("cc");
    expect(compiler).not.toBeNull();
    const compile = Bun.spawnSync([
      compiler!,
      "-std=c11",
      "-D_POSIX_C_SOURCE=200809L",
      `-I${join(ROOT, "hosts/3ds/include")}`,
      `-I${join(ROOT, "hosts/3ds/src")}`,
      join(ROOT, "tests/fixtures/3ds-native-install.c"),
      join(ROOT, "hosts/3ds/src/native.c"),
      join(ROOT, "hosts/3ds/src/dev_protocol.c"),
      "-o",
      binary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);

    const run = Bun.spawnSync([binary, directory]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  });
});
