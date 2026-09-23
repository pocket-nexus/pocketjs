import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repository = join(import.meta.dir, "..");

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGit(args: string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

const retiredRoots = [
  ["engine", "apple"],
  ["engine", "symbian"],
  ["framework", "native"],
  ["hosts", "apple", "ns-shell"],
  ["hosts", "blackberry-android"],
  ["hosts", "blackberry-classic-android"],
  ["hosts", "blackberry-qnx"],
  ["hosts", "symbian"],
].map((segments) => segments.join("/"));

const retiredFiles = [
  ["tools", "blackberry-android.ts"],
  ["tools", "cli", "blackberry-android-toolchain.json"],
  ["hosts", "iphone2g", "compat.c"],
  ["hosts", "iphone2g", "crt_globals.c"],
  ["hosts", "iphone2g", "pocket_core.h"],
  ["hosts", "iphone2g", "pocket_input.c"],
  ["hosts", "iphone2g", "pocket_input.h"],
  ["hosts", "iphone2g", "pocket_runtime.c"],
  ["hosts", "iphone2g", "pocket_runtime.h"],
  ["hosts", "iphone2g", "pocket_spec.h"],
  ["hosts", "iphone2g", "runtime.c"],
  ["hosts", "iphone2g", "rust_eh_personality.c"],
].map((segments) => segments.join("/"));

describe("host layout ownership", () => {
  test("retired host paths do not return through tracked files or references", () => {
    const listed = runGit(["ls-files", "-z"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    const trackedFiles = listed.stdout.split("\0").filter(Boolean);

    for (const retiredPath of [...retiredRoots, ...retiredFiles]) {
      const trackedMatches = trackedFiles.filter(
        (file) => file === retiredPath || file.startsWith(`${retiredPath}/`),
      );
      expect(trackedMatches, `tracked path still uses ${retiredPath}`).toEqual([]);

      const referenced = runGit(["grep", "-n", "-F", "-e", retiredPath, "--", "."]);
      expect(
        referenced.exitCode,
        referenced.stdout || referenced.stderr,
      ).toBe(1);
    }

    const retiredIPodTouchRoot = ["hosts", "ipodtouch"].join("/");
    expect(
      trackedFiles.filter(
        (file) => file === retiredIPodTouchRoot || file.startsWith(`${retiredIPodTouchRoot}/`),
      ),
      `tracked path still uses ${retiredIPodTouchRoot}`,
    ).toEqual([]);
    const referencedIPodTouch = runGit([
      "grep",
      "-n",
      "-F",
      "-e",
      `${retiredIPodTouchRoot}/`,
      "--",
      ".",
    ]);
    expect(
      referencedIPodTouch.exitCode,
      referencedIPodTouch.stdout || referencedIPodTouch.stderr,
    ).toBe(1);
  });

  test("every release-workflow Cargo manifest exists", () => {
    const releaseWorkflow = readFileSync(
      join(repository, ".github/workflows/release.yml"),
      "utf8",
    );
    const manifestPaths = [...releaseWorkflow.matchAll(/--manifest-path\s+([^\s]+)/g)]
      .map((match) => match[1]);

    expect(manifestPaths).not.toHaveLength(0);
    for (const manifestPath of manifestPaths) {
      expect(existsSync(join(repository, manifestPath)), manifestPath).toBe(true);
    }
  });

  test("iOS build and NativeScript working state stay ignored", () => {
    const generatedPaths = [
      "engine/ios/dist/.ignore-probe",
      "hosts/ios-nativescript/platforms/.ignore-probe",
      "hosts/ios-nativescript/hooks/.ignore-probe",
      "hosts/ios-nativescript/src/assets/pocket/.ignore-probe",
      "hosts/ios-nativescript/package-lock.json",
    ];

    for (const generatedPath of generatedPaths) {
      const ignored = runGit(["check-ignore", "-q", "--no-index", generatedPath]);
      expect(ignored.exitCode, generatedPath).toBe(0);
    }
  });
});
