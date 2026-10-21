import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("3DS transports share SOC without waiting on a competing initializer", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pocket-soc-"));
  try {
    const binary = join(scratch, "soc");
    const root = resolve(import.meta.dir, "..");
    const compile = Bun.spawnSync(["cc", "-std=c11", "-O2", "-pthread", "-fsanitize=address,undefined",
      `-I${root}/tests/fixtures/3ds-soc`, `${root}/tests/fixtures/3ds-soc/harness.c`,
      `${root}/platforms/3ds/soc.c`, "-o", binary]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary], { timeout: 10000 });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString()).toContain("SOC concurrent init, cooldown, recovery and shutdown verified");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
