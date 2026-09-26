import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const build = mkdtempSync(join(tmpdir(), "pocketjs-quickjs-c-harness-"));
const runtime = join(repository, "engine/quickjs-c/pocket_runtime.c");
const fixture = join(
  repository,
  "tests/fixtures/quickjs-c-harness/runtime_harness.c",
);

afterAll(() => rmSync(build, { recursive: true, force: true }));

function run(command: string, args: readonly string[]): string {
  const result = Bun.spawnSync([command, ...args], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  expect(
    result.exitCode,
    `${command} ${args.join(" ")}\n${stdout}${stderr}`,
  ).toBe(0);
  return stdout;
}

describe("portable QuickJS C harness contract", () => {
  test("links and executes every capability combination", () => {
    const cc = Bun.which("cc");
    expect(cc).not.toBeNull();

    const common = [
      "-std=c99",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Wno-unused-parameter",
      '-DPOCKETJS_TARGET_ID="harness-test"',
      "-DPOCKETJS_HOST_ABI=0",
      "-I",
      join(repository, "tests/fixtures/quickjs-c-harness"),
      "-I",
      join(repository, "engine/quickjs-c"),
      "-I",
      join(repository, "engine/ui-cabi/include"),
      "-I",
      join(repository, "contracts/generated"),
      "-I",
      join(repository, "hosts/nokia-e7/runtime"),
    ];
    const runVariant = (name: string, defines: readonly string[]) => {
      const binary = join(build, name);
      run(cc!, [...common, ...defines, runtime, fixture, "-o", binary]);
      expect(run(binary, [])).toBe("quickjs-c harness: ok\n");
    };

    runVariant("production", []);
    runVariant("native-extension", ["-std=c11", "-DPOCKET_RUNTIME_EXTENSION"]);
    runVariant("stages", ["-DPOCKET_RUNTIME_STAGE_HOOKS"]);
    runVariant("harness", ["-DPOCKET_RUNTIME_HARNESS"]);
    runVariant("stages-and-harness", [
      "-DPOCKET_RUNTIME_STAGE_HOOKS",
      "-DPOCKET_RUNTIME_HARNESS",
    ]);
  });
});
