import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  IPHONE2G_TOOLCHAIN,
  artifactMatches,
  inspectIPhone2GToolchain,
  iphone2gBootstrapPath,
  iphone2gCacheRoot,
  iphone2gCsuPath,
  iphone2gFirmwarePath,
  iphone2gRootFilesystemPath,
  iphone2gQuickJsPath,
  iphone2gLegacyKitPath,
  iphone2gRamdiskPath,
  iphone2gSysrootPath,
  sha256File,
} from "../tools/iphone2g-toolchain.ts";

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
  test("pins the exact stock device, firmware, compiler, transport, and bootstrap", () => {
    expect(IPHONE2G_TOOLCHAIN).toMatchObject({
      schemaVersion: 1,
      toolchainVersion: "iphoneos-3.1.3-armv6-v2",
      device: {
        productType: "iPhone1,1",
        productVersion: "3.1.3",
        buildVersion: "7E18",
      },
      deployment: {
        rootMount: "/",
        dataMount: "/private/var",
        mountPolicy: "read-write",
        devicePort: 22,
        localPort: 2222,
        bootstrapUser: "root",
      },
      compiler: {
        target: "armv6-apple-darwin8",
        minimumVersion: "1.1.4",
        linker: "ld-classic",
        csu: {
          tag: "Csu-76",
          revision: "a02bd5830f6fbe841d5b0bd54b90ee5f35b99a4e",
        },
        quickJsRevision: "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b",
        quickJsVersion: "2026-06-04",
        rustToolchain: "nightly-2026-07-02",
      },
      firmware: {
        sha1: "000811bac096011b50ebf6ec1ec2285b62fda4cb",
        sha256:
          "25fa72bc07e1879646a690e49090ff376904128cfa333b606a19337d4d02b586",
      },
      transport: {
        usbmuxd: { revision: "3ded00c9985a5108cfc7591a309f9a23d57a8cba" },
        libimobiledevice: {
          revision: "149f7623c672c1fa73122c7119a12bfc0012f2ac",
        },
      },
    });
    expect(Object.keys(IPHONE2G_TOOLCHAIN.compiler.sysrootFiles)).toEqual([
      "usr/lib/libSystem.B.dylib",
      "usr/lib/libgcc_s.1.dylib",
      "usr/lib/libobjc.A.dylib",
      "System/Library/Frameworks/UIKit.framework/UIKit",
      "System/Library/Frameworks/Foundation.framework/Foundation",
      "System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
    ]);
    for (const digest of Object.values(
      IPHONE2G_TOOLCHAIN.compiler.sysrootFiles,
    )) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(IPHONE2G_TOOLCHAIN.bootstrap.files)).toEqual([
      "usr/sbin/sshd",
      "usr/lib/libcrypto.0.9.8.dylib",
      "private/etc/ssh/moduli",
    ]);
    expect(JSON.stringify(IPHONE2G_TOOLCHAIN.bootstrap.files)).not.toContain(
      "sftp",
    );
  });

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
    expect(iphone2gQuickJsPath(env)).toEndWith(
      "/iphone2g/sources/quickjs-rs-ba5bdd0dc013518768e76cd9e05cd30ed53dd35b",
    );
    expect(
      iphone2gLegacyKitPath({
        ...env,
        POCKETJS_IPHONE2G_LEGACY_KIT: " /opt/legacy-kit ",
      }),
    ).toBe("/opt/legacy-kit");
    expect(iphone2gLegacyKitPath(env)).toEndWith(
      "/iphone2g/sources/Legacy-iOS-Kit-1e982b7f2a27ff0f77fe138b9bd48bd7cf431ca6",
    );
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

  test("requires every pinned linked image in the stock sysroot byte-exactly", () => {
    const root = tempRoot();
    const env = { HOME: root, POCKETJS_IPHONE2G_ROOT: root };
    const fixture = join(root, "fixture");
    writeFileSync(fixture, "iphone2g");
    const digest = sha256File(fixture);
    expect(artifactMatches(fixture, digest)).toBe(true);
    expect(artifactMatches(fixture, "0".repeat(64))).toBe(false);
    expect(artifactMatches(join(root, "missing"), digest)).toBe(false);

    const sysroot = iphone2gSysrootPath(env);
    const pinned = IPHONE2G_TOOLCHAIN.compiler.sysrootFiles as Record<
      string,
      string
    >;
    const originals = { ...pinned };
    const entries = Object.keys(pinned);
    try {
      for (const relative of entries) {
        const path = join(sysroot, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `fixture:${relative}`);
        pinned[relative] = sha256File(path);
      }

      const last = join(sysroot, entries.at(-1)!);
      rmSync(last);
      expect(inspectIPhone2GToolchain(env).sysroot).toBe(false);
      writeFileSync(last, `fixture:${entries.at(-1)!}`);
      expect(inspectIPhone2GToolchain(env).sysroot).toBe(true);

      writeFileSync(join(sysroot, entries[0]), "corrupt");
      expect(inspectIPhone2GToolchain(env).sysroot).toBe(false);
      expect(inspectIPhone2GToolchain(env).firmware).toBe(false);
    } finally {
      Object.assign(pinned, originals);
    }
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
