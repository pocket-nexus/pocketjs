import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as redmi } from "../tools/build/programs/redmi-1s.ts";
import { build as moto } from "../tools/build/programs/moto-g-play.ts";

const root = join(import.meta.dir, "..");
const repositoryPath = (...parts: string[]) => join(root, ...parts);

test("Android recipes fingerprint the shared platform and the device shell", () => {
  for (const recipe of [redmi, moto]) {
    const sources = recipe.sourceInputs;
    if (!Array.isArray(sources)) throw new Error("Android recipes must declare their native source files");
    for (const path of sources) expect(existsSync(path), path).toBe(true);
    expect(sources).toContain(repositoryPath("platforms/android/src"));
    expect(sources).toContain(repositoryPath("programs/android/app"));
  }
});
const headers = process.env.POCKET_TEST_JNI_INCLUDE;
test.skipIf(!headers)("Android shell uses real JNI tables across retry, GLES reset and contact sampling", () => {
  const temp = mkdtempSync(join(tmpdir(), "pocket-android-shell-"));
  try {
    const executable = join(temp, "shell");
    const compiled = Bun.spawnSync(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-DPOCKET_OFFLOAD_POSIX",
      `-I${headers}`, `-I${repositoryPath("platforms/android/include")}`, `-I${repositoryPath("engine/runtime/include")}`,
      ...(process.env.POCKET_TEST_JNI_PLATFORM_INCLUDE ? ["-I", process.env.POCKET_TEST_JNI_PLATFORM_INCLUDE] : []),
      ...(process.env.POCKET_TEST_ANDROID_INCLUDE ? ["-I", process.env.POCKET_TEST_ANDROID_INCLUDE] : []),
      `-I${repositoryPath("programs/native/quickjs")}`, `-I${repositoryPath("contracts/generated")}`,
      ...["input", "jni", "hooks"].map(name => repositoryPath(`platforms/android/src/${name}.c`)),
      repositoryPath("engine/runtime/compat/input.c"), repositoryPath("tests/fixtures/android/shell.c"),
      "-pthread", "-lm", "-o", executable], { cwd: root });
    expect(compiled.success, compiled.stderr.toString()).toBe(true);
    if (!compiled.success) return;
    const ran = Bun.spawnSync([executable], { cwd: root });
    expect(ran.success, ran.stderr.toString()).toBe(true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
