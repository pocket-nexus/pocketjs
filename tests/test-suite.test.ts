import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repository = join(import.meta.dir, "..");
const suiteSource = readFileSync(join(repository, "tools/test.ts"), "utf8");

function unitTestFiles(): Set<string> {
  const unitStage = suiteSource.match(
    /name: "unit",[\s\S]*?tests: \[(.*?)\n\s*\],\n\s*},/s,
  )?.[1];
  if (!unitStage)
    throw new Error("tools/test.ts does not define the unit test stage");

  return new Set(
    [...unitStage.matchAll(/"(tests\/[^"\n]+\.test\.ts)"/g)].map(
      ([, path]) => path,
    ),
  );
}

function stageTestFiles(): Set<string> {
  return new Set(
    [...suiteSource.matchAll(/"(tests\/[^"\n]+\.test\.ts)"/g)].map(
      ([, path]) => path,
    ),
  );
}

// Tests outside the default suite must name their dedicated workflow or an
// explicit local command and reason. Neither kind is skipped by omission.
const STAGE_EXCLUSIONS: Readonly<Record<string,
  { workflow: string } | { localCommand: readonly string[]; reason: string }
>> = {
  "tests/ui-cabi-allocator.test.ts": {
    workflow: ".github/workflows/native-c-harness.yml",
  },
  "tests/ui-cabi-psm-draw.test.ts": {
    workflow: ".github/workflows/native-c-harness.yml",
  },
  "tests/aot-model-fuzz.test.ts": {
    localCommand: ["bun", "test", "tests/aot-model-fuzz.test.ts"],
    reason: "Model AOT fuzz runs are opt-in local checks, excluded from CI.",
  },
};

describe("declared test suite", () => {
  test("runs every tests/*.test.ts file in some stage or registers its exclusion", () => {
    const declared = stageTestFiles();
    const onDisk = readdirSync(join(repository, "tests"))
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => `tests/${file}`)
      .sort();

    expect(onDisk).not.toHaveLength(0);

    const stray = onDisk.filter(
      (file) => !declared.has(file) && !(file in STAGE_EXCLUSIONS),
    );
    expect(stray).toEqual([]);

    for (const [file, exclusion] of Object.entries(STAGE_EXCLUSIONS)) {
      expect(onDisk).toContain(file);
      if ("workflow" in exclusion) {
        const workflowPath = join(repository, exclusion.workflow);
        expect(existsSync(workflowPath)).toBe(true);
        expect(readFileSync(workflowPath, "utf8")).toContain(file);
      } else {
        expect(exclusion.localCommand).toEqual(["bun", "test", file]);
        expect(exclusion.reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("runs every Nintendo 3DS test in the CI unit stage", () => {
    const declared = unitTestFiles();
    const threeDsTests = readdirSync(join(repository, "tests"))
      .filter((file) => /^3ds-.*\.test\.ts$/.test(file))
      .map((file) => `tests/${file}`)
      .sort();

    expect(threeDsTests).not.toHaveLength(0);
    expect(threeDsTests.filter((file) => !declared.has(file))).toEqual([]);
  });

  test("device program suites are included in the repository validation", () => {
    const declared = stageTestFiles();
    for (const file of ["device-program-build", "android-platform-integration", "iphone2g-profile", "iphone4s-profile", "ipodtouch-profile", "ipodtouch4-profile", "symbian-runtime", "moto-g-play-profile", "redmi-1s-profile", "blackberry-classic", "meizu-m8-profile", "launcher-symbian"]) {
      expect(declared.has(`tests/${file}.test.ts`), file).toBe(true);
    }
  });






});
