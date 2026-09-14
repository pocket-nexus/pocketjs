import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native contact lifetimes survive pointer reuse and suppress cancelled tap latches", () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-contact-latch-"));
  try {
    const binary = join(directory, "test");
    const build = Bun.spawnSync(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
      "tests/fixtures/contact-latch.c", "-o", binary], { stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary], { stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
