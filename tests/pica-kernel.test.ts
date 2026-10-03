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
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  } finally { rmSync(output, { recursive: true, force: true }); }
});
