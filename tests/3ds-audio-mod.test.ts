import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("3DS PCM module preserves the audio contract across its NDSP adapter", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pocket-3ds-audio-"));
  try {
    const binary = join(scratch, "audio-mod");
    const root = resolve(import.meta.dir, "..");
    const fixture = join(root, "tests/fixtures/3ds-audio");
    const compile = Bun.spawnSync([
      "cc",
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-fsanitize=address,undefined",
      `-I${fixture}`,
      `-I${root}/hosts/3ds/src`,
      `${fixture}/harness.c`,
      `${root}/hosts/3ds/src/audio_mod.c`,
      "-o",
      binary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);

    const run = Bun.spawnSync([binary], { timeout: 10000 });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString()).toContain(
      "3DS PCM formats, partial writes, ring wrap, credits, events, handles and cleanup verified",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
