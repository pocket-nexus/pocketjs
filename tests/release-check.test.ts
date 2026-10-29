import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkReleaseVersion,
  normalizeReleaseVersion,
} from "../tools/release-check.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

async function releaseFixture(versions: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pocketjs-release-check-"));
  temporaryDirectories.push(root);
  for (const [path, version] of Object.entries(versions)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), JSON.stringify({ version }));
  }
  return root;
}

describe("release version gate", () => {
  test("accepts a SemVer or v-prefixed tag when every artifact agrees", async () => {
    const root = await releaseFixture({
      "package.json": "0.4.0",
      "tools/cli/package.json": "0.4.0",
      "apps/hero/pocket.json": "0.4.0",
    });

    expect((await checkReleaseVersion("0.4.0", root)).version).toBe("0.4.0");
    expect((await checkReleaseVersion("v0.4.0", root)).version).toBe("0.4.0");
  });

  test("rejects malformed release refs before inspecting artifacts", () => {
    for (const value of ["", "v", "version-0.4.0", "v01.4.0", "v0.4", " v0.4.0"])
      expect(() => normalizeReleaseVersion(value)).toThrow("expected a SemVer");
  });

  test("reports every artifact that differs from the requested release", async () => {
    const root = await releaseFixture({
      "package.json": "0.4.0",
      "tools/cli/package.json": "0.3.0",
      "apps/hero/pocket.json": "0.3.1",
    });

    await expect(checkReleaseVersion("v0.4.0", root)).rejects.toThrow(
      "tools/cli/package.json: 0.3.0\n  apps/hero/pocket.json: 0.3.1",
    );
  });

  test("rejects missing, non-string, and invalid artifact versions", async () => {
    const missing = await releaseFixture({
      "package.json": "0.4.0",
      "tools/cli/package.json": "0.4.0",
    });
    await expect(checkReleaseVersion("0.4.0", missing)).rejects.toThrow("cannot read apps/hero/pocket.json");

    const nonString = await releaseFixture({
      "package.json": "0.4.0",
      "tools/cli/package.json": 4,
      "apps/hero/pocket.json": "0.4.0",
    });
    await expect(checkReleaseVersion("0.4.0", nonString)).rejects.toThrow(
      "tools/cli/package.json must contain a valid SemVer string",
    );

    const invalid = await releaseFixture({
      "package.json": "0.4.0",
      "tools/cli/package.json": "next",
      "apps/hero/pocket.json": "0.4.0",
    });
    await expect(checkReleaseVersion("0.4.0", invalid)).rejects.toThrow(
      "tools/cli/package.json must contain a valid SemVer string",
    );
  });
});
