import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = join(root, ".pocket-build/validation/worker", `native-${process.pid}`);
mkdirSync(output, { recursive: true });

describe("native worker contract", () => {
  test("bounded resources, stream ordering, cancellation, fairness and concurrent channels", () => {
    const binary = join(output, "core");
    const compile = Bun.spawnSync([
      process.env.CC ?? "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-g",
      "-fsanitize=address,undefined", `-I${join(root, "engine/worker/include")}`,
      join(root, "engine/worker/src/worker.c"), join(root, "engine/worker/tests/core.c"),
      "-lpthread", "-o", binary,
    ]);
    writeFileSync(join(output, "compile.log"), compile.stdout.toString() + compile.stderr.toString());
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary]);
    writeFileSync(join(output, "core.log"), run.stdout.toString() + run.stderr.toString());
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  });

  // Explicit source selection avoids fetching or changing the pinned engine in
  // the normal test suite. The standalone script accepts NG and Bellard.
  test.skipIf(!process.env.POCKET_WORKER_QUICKJS_SOURCE)("isolated QuickJS realm and event runner", () => {
    const run = Bun.spawnSync([
      "sh", join(root, "engine/worker/tests/run.sh"), process.env.POCKET_WORKER_QUICKJS_SOURCE!,
      join(output, "quickjs"), process.env.POCKET_WORKER_QUICKJS_ENGINE ?? "ng",
    ]);
    writeFileSync(join(output, "quickjs.log"), run.stdout.toString() + run.stderr.toString());
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  }, 120_000);
});
