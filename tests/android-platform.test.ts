import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
function compileRun(sources: string[], flags: string[], negative = false) {
  const directory = mkdtempSync(join(tmpdir(), "pocket-android-"));
  try {
    const executable = join(directory, "test");
    const compiled = Bun.spawnSync(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-Iplatforms/android/include", "-Iengine/runtime/include", "-Icontracts/generated",
      ...flags, ...sources, "-o", executable], { cwd: root });
    expect(compiled.success, compiled.stderr.toString()).toBe(true);
    if (!compiled.success) return;
    const ran = Bun.spawnSync([executable], { cwd: root });
    expect(ran.success, ran.stderr.toString()).toBe(true);
    if (negative) {
      const rejected = Bun.spawnSync([executable, "negative"], { cwd: directory });
      expect(rejected.success).toBe(false);
      expect(Boolean(rejected.signalCode) || rejected.exitCode !== 0).toBe(true);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test("Android source isolates contexts and retains failed frames without locking callbacks", () => {
  compileRun(["platforms/android/src/input.c", "engine/runtime/compat/input.c", "tests/fixtures/android-input-test.c"], ["-pthread", "-lm"], true);
});
// JNI headers must come from a real JDK/NDK. CI can set this to the NDK sysroot
// include directory; no reduced mock ABI stands in for the JNI function table.
const jni = process.env.POCKET_TEST_JNI_INCLUDE;
test.skipIf(!jni)("Android JNI copies caller-owned binary arrays and contains allocation/VM failures", () => {
  compileRun(["platforms/android/src/jni.c", "tests/fixtures/android-jni-test.c"], ["-I", jni!,
    ...(process.env.POCKET_TEST_JNI_PLATFORM_INCLUDE ? ["-I", process.env.POCKET_TEST_JNI_PLATFORM_INCLUDE] : [])]);
});
