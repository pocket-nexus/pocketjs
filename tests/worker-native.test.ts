import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = join(root, ".pocket-build/validation/worker", `native-${process.pid}`);
mkdirSync(output, { recursive: true });
/** engine/worker/tests/run.sh holds the compile recipe; this test runs it. */
function run(engineSource: string | undefined, name: string): void {
  const result = Bun.spawnSync(["sh", join(root, "engine/worker/tests/run.sh"), engineSource ?? "",
    join(output, name), process.env.POCKET_WORKER_QUICKJS_ENGINE ?? "ng"]);
  writeFileSync(join(output, `${name}.log`), result.stdout.toString() + result.stderr.toString());
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

describe("native worker contract", () => {
  test("bounded resources, stream ordering, cancellation, fairness and concurrent channels", () => {
    run(undefined, "core");
  });
  // Explicit source selection avoids fetching or changing the pinned engine in
  // the normal test suite. The script accepts NG and Bellard.
  test.skipIf(!process.env.POCKET_WORKER_QUICKJS_SOURCE)("isolated QuickJS realm, event runner and UI bridge", () => {
    run(process.env.POCKET_WORKER_QUICKJS_SOURCE, "quickjs");
  }, 120_000);
});
