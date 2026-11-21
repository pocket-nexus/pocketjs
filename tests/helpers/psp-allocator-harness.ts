import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Compile production allocator modules with substituted platform boundaries.
 * Every case gets its own process so no test-only arena reset enters production. */
export function allocatorCases(fixture: string, cases: readonly string[]): void {
  const root = join(import.meta.dir, "../..");
  const build = mkdtempSync(join(tmpdir(), "pocketjs-psp-allocator-"));
  afterAll(() => rmSync(build, { recursive: true, force: true }));
  for (const profile of ["debug", "release"] as const) {
    const binary = join(build, profile);
    beforeAll(() => {
      const result = Bun.spawnSync([
        "rustc", "--edition=2021", "--test",
        `tests/fixtures/psp-allocator/${fixture}.rs`,
        ...(profile === "release" ? ["-O"] : []), "-o", binary,
      ], {
        cwd: root, env: { ...process.env, POCKETJS_ARENA_BYTES: "0" },
        stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
    }, 60_000);
    for (const name of cases) {
      test(`PSP ${fixture} ${profile}: ${name}`, () => {
        const result = Bun.spawnSync([binary, "--exact", name, "--nocapture"], {
          cwd: root, stdout: "pipe", stderr: "pipe",
        });
        expect(result.exitCode, `signal=${result.signalCode}\n${result.stdout}${result.stderr}`).toBe(0);
        expect(result.stdout.toString()).toContain("1 passed; 0 failed");
      });
    }
  }
}
