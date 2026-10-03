import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  POCKET_SECTION,
  decodePocketPackage,
  encodePocketPackage,
  findSection,
} from "../contracts/spec/pocket-package.ts";
import {
  WII_DEV_HOST_ABI,
  WII_DEV_TARGET_ID,
} from "../tools/wii-profile.ts";

const ROOT = resolve(import.meta.dir, "..");

function runPack(...args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, "tools/pocket-pack.ts", ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("pocket-pack private Wii profile", () => {
  test("builds and verifies a wii-dev package with the profile ABI", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocket-pack-wii-"));
    const packagePath = join(directory, "hero.pocket");
    try {
      const build = runPack(
        "build",
        "--manifest",
        "apps/hero/pocket.json",
        "--target",
        WII_DEV_TARGET_ID,
        "-o",
        packagePath,
      );
      if (build.exitCode !== 0) throw new Error(new TextDecoder().decode(build.stderr));

      const pkg = decodePocketPackage(new Uint8Array(readFileSync(packagePath)));
      expect(pkg.variants).toHaveLength(1);
      const variant = pkg.variants[0]!;
      expect(variant.target).toBe(WII_DEV_TARGET_ID);
      expect(variant.hostAbi).toBe(WII_DEV_HOST_ABI);
      const plan = JSON.parse(
        new TextDecoder().decode(findSection(variant, POCKET_SECTION.plan)!),
      );
      expect(plan.target).toEqual({ id: WII_DEV_TARGET_ID, hostAbi: WII_DEV_HOST_ABI });

      const verify = runPack("verify", packagePath);
      if (verify.exitCode !== 0) throw new Error(new TextDecoder().decode(verify.stderr));
      expect(new TextDecoder().decode(verify.stdout)).toContain("verify: OK");

      variant.hostAbi++;
      const driftedPath = join(directory, "wrong-abi.pocket");
      writeFileSync(driftedPath, encodePocketPackage(pkg));
      const drifted = runPack("verify", driftedPath);
      expect(drifted.exitCode).toBe(1);
      expect(new TextDecoder().decode(drifted.stderr)).toContain("hostAbi drifted");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
