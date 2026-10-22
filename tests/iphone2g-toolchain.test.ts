import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPHONE2G_TOOLCHAIN, inspectIPhone2GToolchain, iphone2gBootstrapPath, iphone2gCacheRoot, iphone2gCsuPath, iphone2gFirmwarePath, iphone2gRootFilesystemPath, iphone2gQuickJsPath, iphone2gLegacyKitPath, iphone2gRamdiskPath, iphone2gSysrootPath } from "../tools/build/toolchains/iphone2g.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function tempRoot(): string {
  const path = `/tmp/pocketjs-iphone2g-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(path, { recursive: true });
  temporary.push(path);
  return path;
}

function git(repository: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "PocketJS test",
      GIT_AUTHOR_EMAIL: "pocketjs-test@example.invalid",
      GIT_COMMITTER_NAME: "PocketJS test",
      GIT_COMMITTER_EMAIL: "pocketjs-test@example.invalid",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function commitFixture(repository: string): string {
  git(repository, ["init", "--quiet"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "fixture"]);
  return git(repository, ["rev-parse", "HEAD"]);
}

describe("canonical iPhone 2G toolchain", () => {

  test("resolves only explicit overrides or the shared cache", () => {
    const env = { HOME: "/home/test", XDG_CACHE_HOME: "/var/cache/test" };
    expect(iphone2gCacheRoot(env)).toBe(
      "/var/cache/test/pocket-nexus/iphone2g",
    );
    expect(iphone2gFirmwarePath(env)).toEndWith(
      "/iphone2g/downloads/iPhone1,1_1.1.4_4A102_Restore.ipsw",
    );
    expect(iphone2gRootFilesystemPath(env)).toEndWith(
      "/iphone2g/sysroot-1.1.4/iPhoneOS-1.1.4-rootfs.raw",
    );
    expect(
      iphone2gSysrootPath({
        ...env,
        POCKETJS_IPHONE2G_SYSROOT: " /opt/iphone114 ",
      }),
    ).toBe("/opt/iphone114");
    expect(
      iphone2gCsuPath({ ...env, POCKETJS_IPHONE2G_CSU: " /opt/Csu-76 " }),
    ).toBe("/opt/Csu-76");
    expect(
      iphone2gQuickJsPath({
        ...env,
        POCKETJS_IPHONE2G_QUICKJS: " /opt/quickjs ",
      }),
    ).toBe("/opt/quickjs");
    expect(
      iphone2gLegacyKitPath({
        ...env,
        POCKETJS_IPHONE2G_LEGACY_KIT: " /opt/legacy-kit ",
      }),
    ).toBe("/opt/legacy-kit");
    expect(iphone2gRamdiskPath(env)).toEndWith(
      "/saved/iPhone1,1/ramdisk_7E18/saved",
    );
    expect(
      iphone2gCacheRoot({
        ...env,
        POCKETJS_IPHONE2G_ROOT: " /opt/device-lab ",
      }),
    ).toBe("/opt/device-lab");
  });

  test("requires pinned source HEADs with no tracked checkout changes", () => {
    const root = tempRoot();
    const quickjs = join(root, "quickjs");
    const legacyKit = join(root, "legacy-kit");
    const quickjsSource = join(quickjs, "libquickjs-sys/embed/quickjs");
    mkdirSync(quickjsSource, { recursive: true });
    for (const name of ["quickjs.c", "quickjs.h", "libunicode.c"]) {
      writeFileSync(join(quickjsSource, name), `${name}\n`);
    }
    mkdirSync(legacyKit, { recursive: true });
    writeFileSync(join(legacyKit, "restore.sh"), "#!/bin/sh\n");
    const quickjsHead = commitFixture(quickjs);
    const legacyKitHead = commitFixture(legacyKit);
    const compiler = IPHONE2G_TOOLCHAIN.compiler as unknown as {
      quickJsRevision: string;
    };
    const ramdisk = IPHONE2G_TOOLCHAIN.ramdisk as unknown as {
      revision: string;
    };
    const originalQuickJsRevision = compiler.quickJsRevision;
    const originalLegacyKitRevision = ramdisk.revision;
    const env = {
      HOME: root,
      POCKETJS_IPHONE2G_ROOT: root,
      POCKETJS_IPHONE2G_QUICKJS: quickjs,
      POCKETJS_IPHONE2G_LEGACY_KIT: legacyKit,
    };

    try {
      compiler.quickJsRevision = quickjsHead;
      ramdisk.revision = legacyKitHead;
      expect(inspectIPhone2GToolchain(env).quickjs).toBe(true);
      expect(inspectIPhone2GToolchain(env).legacyKit).toBe(true);

      writeFileSync(join(quickjsSource, "quickjs.c"), "tracked change\n");
      expect(inspectIPhone2GToolchain(env).quickjs).toBe(false);
      writeFileSync(join(quickjsSource, "quickjs.c"), "quickjs.c\n");
      expect(inspectIPhone2GToolchain(env).quickjs).toBe(true);

      writeFileSync(
        join(legacyKit, "restore.sh"),
        "#!/bin/sh\n# new revision\n",
      );
      git(legacyKit, ["add", "restore.sh"]);
      git(legacyKit, ["commit", "--quiet", "-m", "new revision"]);
      expect(inspectIPhone2GToolchain(env).legacyKit).toBe(false);
    } finally {
      compiler.quickJsRevision = originalQuickJsRevision;
      ramdisk.revision = originalLegacyKitRevision;
    }
  });

  test("keeps historical device bootstrap packages out of the repository", () => {
    const env = { HOME: "/home/test", XDG_CACHE_HOME: "/cache" };
    expect(
      iphone2gBootstrapPath(IPHONE2G_TOOLCHAIN.bootstrap.openssh, env),
    ).toBe(
      "/cache/pocket-nexus/iphone2g/downloads/bootstrap/openssh_4.7p1-1_iphoneos-arm.deb",
    );
    expect(
      iphone2gBootstrapPath(IPHONE2G_TOOLCHAIN.bootstrap.openssl, env),
    ).toBe(
      "/cache/pocket-nexus/iphone2g/downloads/bootstrap/openssl_0.9.8g-1_iphoneos-arm.deb",
    );
  });
});
