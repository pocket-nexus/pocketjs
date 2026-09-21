import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("PSP worker private heap coalesces, honors alignment and isolates exhaustion", () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-worker-heap-"));
  try {
    const path = join(directory, "heap-tests");
    const build = Bun.spawnSync(["rustc", "--edition=2021", "--test", "hosts/psp/src/worker_heap.rs", "-o", path]);
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([path]);
    expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);
