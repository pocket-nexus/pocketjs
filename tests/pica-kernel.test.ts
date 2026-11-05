import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("PICA allocation failures clean up; exact mip uploads publish every level", () => {
  const output = mkdtempSync(join(tmpdir(), "pica-kernel-"));
  try {
    const binary = join(output, "texture");
    const result = Bun.spawnSync([process.env.CC || "cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-I", resolve("tests/fixtures/pica-kernel"), "-I", resolve("devices/3ds/pocket-3ds-pica/include"),
      resolve("tests/fixtures/pica-kernel/texture.c"), "-o", binary]);
    expect(result.success, `exit=${result.exitCode} signal=${result.signalCode} ${result.stderr}`).toBe(true);
    const run = Bun.spawnSync([binary]);
    expect(run.success, `exit=${run.exitCode} signal=${run.signalCode} ${run.stderr}`).toBe(true);
  } finally { rmSync(output, { recursive: true, force: true }); }
});
