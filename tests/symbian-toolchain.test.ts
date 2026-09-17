import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SYMBIAN_DOWNLOADS,
  SYMBIAN_RUNTIME_DOWNLOADS,
  SYMBIAN_SETUP_DOWNLOADS,
  SYMBIAN_TOOLCHAIN,
  inspectSymbianRustHost,
  receiptMatchesSymbianManifest,
  symbianDockerBuildArguments,
  symbianDockerDoctorArguments,
  symbianDockerRunArguments,
  symbianDockerSetupArguments,
  symbianDownloadsRoot,
  symbianImplementationDigest,
  withSymbianGuestBuildLock,
  withSymbianRuntimeBuildLock,
} from "../tools/symbian-toolchain.ts";
import { withArtifactLock } from "../tools/psp-toolchain.ts";

const repository = new URL("..", import.meta.url).pathname;
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("canonical Symbian E7 toolchain", () => {
  test("pins every historical and upstream input by SHA-256", () => {
    expect(SYMBIAN_TOOLCHAIN).toMatchObject({
      schemaVersion: 1,
      toolchainVersion: "sr1-qt474-v1",
      container: {
        platform: "linux/amd64",
        debianSnapshot: "20260712T202631Z",
        debianSecuritySnapshot: "20260712T194830Z",
        signingVolume: "pocketjs-symbian-signing-v1",
      },
      gcce: { version: "4.6.3" },
      qtSource: { version: "4.7.4" },
      device: {
        usbVendorId: "0421",
        usbProductId: "0335",
        deployStorage: "Mass memory",
        deployFolder: "Installs",
      },
    });
    expect(SYMBIAN_TOOLCHAIN.container.baseImage).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(SYMBIAN_TOOLCHAIN.container.debianSnapshot).toMatch(
      /^\d{8}T\d{6}Z$/,
    );
    expect(SYMBIAN_TOOLCHAIN.container.debianSecuritySnapshot).toMatch(
      /^\d{8}T\d{6}Z$/,
    );
    expect(SYMBIAN_DOWNLOADS).toHaveLength(4);
    expect(SYMBIAN_RUNTIME_DOWNLOADS).toHaveLength(1);
    expect(SYMBIAN_SETUP_DOWNLOADS).toHaveLength(5);
    for (const artifact of SYMBIAN_SETUP_DOWNLOADS) {
      expect(artifact.url).toMatch(/^https:\/\//);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(SYMBIAN_TOOLCHAIN.quickjs).toMatchObject({
      version: "2026-06-04",
      rev: "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b",
    });
    expect(SYMBIAN_TOOLCHAIN.runtime).toEqual({
      sisVersion: "1.0.0",
      rustToolchain: "nightly-2026-07-02",
      frameRate: 30,
    });
    expect(SYMBIAN_TOOLCHAIN.markers).toEqual(expect.arrayContaining([
      "sdk/epoc32/include/e32base.h",
      "gcce/arm-2012.03/bin/arm-none-symbianelf-g++",
      "sdk/bin/qmake",
      "sdk/bin/moc",
      "sdk/bin/rcc",
      "sdk/bin/uic",
      "sdk/bin/elf2e32_qtwrapper",
      "bin/symbian-gcce-link",
      "bin/elf2e32",
      "bin/makesis",
      "bin/mifconv",
      "bin/rcomp",
      "bin/signsis",
    ]));
    expect(SYMBIAN_TOOLCHAIN.signing).toEqual({
      certificate: "current/pocketjs-e7-development.cer",
      privateKey: "current/pocketjs-e7-development.key",
      legacyCertificate: "signing/pocketjs-e7-development.cer",
      legacyPrivateKey: "signing/pocketjs-e7-development.key",
    });
  });

  test("resolves shared cache and an explicit downloads override", () => {
    expect(symbianDownloadsRoot({
      HOME: "/tmp/home",
      XDG_CACHE_HOME: "/tmp/cache",
    })).toBe("/tmp/cache/pocket-stack/symbian/downloads");
    expect(symbianDownloadsRoot({
      HOME: "/tmp/home",
      POCKET_STACK_CACHE_DIR: "/tmp/pocket-cache",
    })).toBe("/tmp/pocket-cache/symbian/downloads");
    expect(symbianDownloadsRoot({
      HOME: "/tmp/home",
      POCKETJS_SYMBIAN_DOWNLOADS: "/tmp/historical-inputs",
    })).toBe("/tmp/historical-inputs");
  });

  test("accepts only a receipt for the exact manifest inputs", () => {
    const downloads = Object.fromEntries(
      SYMBIAN_DOWNLOADS.map((artifact) => [artifact.asset, artifact.sha256]),
    );
    const receipt = {
      schemaVersion: 1,
      toolchainVersion: SYMBIAN_TOOLCHAIN.toolchainVersion,
      platform: SYMBIAN_TOOLCHAIN.container.platform,
      gnupocRev: SYMBIAN_TOOLCHAIN.gnupoc.rev,
      implementationSha256: "1".repeat(64),
      certificateSha256: "2".repeat(64),
      downloads,
      markersSha256: Object.fromEntries(
        SYMBIAN_TOOLCHAIN.markers.map((marker) => [marker, "3".repeat(64)]),
      ),
    };
    expect(receiptMatchesSymbianManifest(receipt)).toBe(true);
    expect(receiptMatchesSymbianManifest({
      ...receipt,
      downloads: { ...downloads, [SYMBIAN_TOOLCHAIN.sdk.asset]: "0".repeat(64) },
    })).toBe(false);
    expect(receiptMatchesSymbianManifest({
      ...receipt,
      markersSha256: {},
    })).toBe(false);
    expect(receiptMatchesSymbianManifest({ ...receipt, platform: "linux/arm64" })).toBe(false);
  });

  test("strict validation owns native tools, signatures, UID, and atomic output", () => {
    const setup = readFileSync(
      join(repository, "tools/symbian/container/pocketjs-symbian-setup"),
      "utf8",
    );
    const doctor = readFileSync(
      join(repository, "tools/symbian/container/pocketjs-symbian-doctor"),
      "utf8",
    );
    const codaUsbProbe = readFileSync(
      join(repository, "tools/symbian/coda-usb-probe.c"),
      "utf8",
    );
    const buildProbe = readFileSync(
      join(repository, "tools/symbian/container/pocketjs-symbian-build-probe"),
      "utf8",
    );
    const buildApp = readFileSync(
      join(repository, "tools/symbian/container/pocketjs-symbian-build-app"),
      "utf8",
    );
    const probeProject = readFileSync(
      join(repository, "hosts/nokia-e7/probe/pocketjs-e7-probe.pro"),
      "utf8",
    );
    const dockerfile = readFileSync(
      join(repository, "tools/symbian/Dockerfile"),
      "utf8",
    );

    expect(setup).not.toContain("install_eka2_tools");
    expect(setup).toContain("Makefile.local-libelf");
    expect(setup).toContain("tools/mifconv.cpp");
    expect(setup).toContain("markersSha256: $markers");
    expect(setup).toContain("pocketjs-symbian-doctor");
    expect(setup).toContain(
      "for alias_pair in GLES2:gles2 EGL:egl GLES:gles; do",
    );
    expect(setup).toContain(
      'ln -s "$target_name" "$stage/sdk/epoc32/include/$alias_name"',
    );
    expect(doctor).toContain("sha256sum --check --status");
    expect(doctor).toContain("signsis -o");
    expect(doctor).toContain(
      'test "$(readlink "$root/sdk/epoc32/include/GLES2")" = gles2',
    );
    expect(doctor).toContain(
      'test "$(readlink "$root/sdk/epoc32/include/EGL")" = egl',
    );
    expect(doctor).toContain(
      'test -s "$root/sdk/include/QtOpenGL/QGLWidget"',
    );
    expect(doctor).toContain(
      'test -s "$root/sdk/epoc32/release/armv5/lib/QtOpenGL.dso"',
    );
    expect(doctor).toContain(
      'test -s "$root/sdk/epoc32/release/armv5/lib/libGLESv2.dso"',
    );
    expect(doctor).toContain(
      'test -s "$root/sdk/epoc32/release/armv5/lib/libEGL.dso"',
    );
    expect(doctor).toContain("#include <QtOpenGL/QGLWidget>");
    expect(doctor).toContain("class PocketJsGlSmoke : public QGLWidget");
    expect(doctor).toContain("glClear(GL_COLOR_BUFFER_BIT);");
    expect(doctor).toContain("QT += core gui opengl");
    expect(doctor).toContain('cd "$smoke"');
    expect(doctor).toContain("make -j2 >/dev/null");
    expect(doctor).toContain('test -s "$smoke/PocketJsDoctorSmoke.exe"');
    expect(doctor).toContain("makesis smoke.pkg smoke-unsigned.sis");
    expect(codaUsbProbe).toContain("NokiaVendorId = 0x0421");
    expect(codaUsbProbe).toContain("NokiaE7SuiteProductId = 0x0335");
    expect(codaUsbProbe).toContain("CodaControlInterface = 3");
    expect(codaUsbProbe).toContain("CodaDataInterface = 4");
    expect(codaUsbProbe).toContain("libusb_attach_kernel_driver");
    expect(codaUsbProbe).toContain("static int read_until(");
    expect(codaUsbProbe).toContain("CODA Locator: ready");
    expect(codaUsbProbe).toContain("\"Processes\"");
    expect(codaUsbProbe).toContain("\"start\"");
    expect(codaUsbProbe).toContain("\"false\"");
    expect(codaUsbProbe).toContain("match_command_reply");
    expect(codaUsbProbe).toContain("command_reply_has_error");
    expect(codaUsbProbe).toContain("CODA launch: started");
    expect(codaUsbProbe).not.toMatch(/imei|serial number/i);
    expect(buildProbe).toContain("output_stage=$(mktemp -d /out/");
    expect(buildProbe).toContain('mv -f "$candidate" "$output"');
    expect(buildProbe).toContain("actual_uid=$(od ");
    expect(buildApp).toContain("quickjs-symbian-gcce.patch");
    expect(buildApp).toContain("-std=gnu99");
    expect(buildApp).toContain("-O2");
    expect(buildApp).toContain("-fwrapv");
    expect(buildApp).toContain("-fno-strict-aliasing");
    expect(buildApp).toContain("POCKETJS_CORE_LIBRARY");
    expect(buildApp).toContain("POCKETJS_SYMBIAN_TARGET");
    expect(buildApp).toContain("POCKETJS_SYMBIAN_CAPTION");
    expect(buildApp).toContain('package_json="$payload/package.json"');
    expect(buildApp).toContain('catalog_index="$payload/catalog.tsv"');
    expect(buildApp).toContain('cp "$catalog_blob" "$build/catalog.bin"');
    expect(buildApp).toContain("catalogIndex: (if $catalogIndexSha256");
    expect(buildApp).toContain(
      'data_manifest="$data_stage/manifest.json"',
    );
    expect(buildApp).toContain('keys == ["bytes", "path", "sha256"]');
    expect(buildApp).toContain("expected_bytes=$(jq -er '.bytes'");
    expect(buildApp).toContain(
      "Staged Symbian mass-storage data failed verification",
    );
    expect(buildApp).toContain(
      'printf \'"%s"-"E:\\\\private\\\\%s\\\\data\\\\%s"\\n\'',
    );
    expect(buildApp).toContain(
      '"QMAKE_${executable}_LFLAGS=-Ttext 0x80000 -Tdata $data_base"',
    );
    expect(buildApp).toContain("embeddedBytes: ($embeddedBytes | tonumber)");
    expect(buildApp).toContain('schemaVersion: 3');
    expect(buildApp).toContain("data: $data[0]");
    expect(buildApp).toContain("output_stage=$(mktemp -d /out/");
    expect(buildApp).toContain('mv -f "$candidate" "$output"');
    const sisPattern = buildApp.match(
      /\.sisFile \| strings \| select\(test\("([^"]+)"\)\)/,
    )?.[1];
    const receiptPattern = buildApp.match(
      /\.receiptFile \| strings \| select\(test\("([^"]+)"\)\)/,
    )?.[1];
    expect(sisPattern).toBeDefined();
    expect(receiptPattern).toBeDefined();
    expect(new RegExp(JSON.parse(`"${sisPattern}"`)).test("launcher-main.sis"))
      .toBe(true);
    expect(
      new RegExp(JSON.parse(`"${receiptPattern}"`)).test(
        "launcher-main.receipt.json",
      ),
    ).toBe(true);
    expect(buildApp).toContain("actual_uid=$(od ");
    expect(buildApp).toContain("sha256sum --check --status");
    expect(buildApp).toContain("SIS version must be three decimal components");
    expect(probeProject).toContain("QMAKE_LINK = /toolchain/current/bin/symbian-gcce-link");
    expect(probeProject).toContain("TARGET.UID3 = $$POCKETJS_SYMBIAN_UID");
    expect(probeProject).not.toContain(SYMBIAN_TOOLCHAIN.probe.uid);
    expect(dockerfile).toContain(
      `ARG POCKETJS_SYMBIAN_BASE_IMAGE=${SYMBIAN_TOOLCHAIN.container.baseImage}`,
    );
    expect(dockerfile).toContain("ARG POCKETJS_DEBIAN_SNAPSHOT");
    expect(dockerfile).toContain("ARG POCKETJS_DEBIAN_SECURITY_SNAPSHOT");
    expect(dockerfile.match(/\[check-valid-until=no\]/g)).toHaveLength(3);
    expect(dockerfile).not.toContain("deb.debian.org");
    expect(dockerfile).not.toContain("trusted=yes");
    expect(dockerfile).not.toContain("Check-Date=false");
    expect(dockerfile).toContain("rm -f /etc/apt/sources.list.d/*");
    expect(dockerfile.match(/Acquire::Retries=5/g)).toHaveLength(4);
    expect(dockerfile).not.toContain(SYMBIAN_TOOLCHAIN.container.debianSnapshot);
    expect(dockerfile).not.toContain(
      SYMBIAN_TOOLCHAIN.container.debianSecuritySnapshot,
    );
    expect(dockerfile).toContain("pocketjs-symbian-build-app");
  });

  test("inspects only the locally installed pinned Rust toolchain", async () => {
    const commands: string[] = [];
    const ready = await inspectSymbianRustHost(
      (tool) => tool === "rustup" ? "/host/bin/rustup" : undefined,
      async (command, args) => {
        commands.push([command, ...args].join(" "));
        if (args.join(" ") === "toolchain list") {
          return {
            exitCode: 0,
            stdout:
              `stable-aarch64-apple-darwin (default)\n${SYMBIAN_TOOLCHAIN.runtime.rustToolchain}-aarch64-apple-darwin\n`,
            stderr: "",
          };
        }
        if (args[0] === "run") {
          return { exitCode: 0, stdout: "cargo 1.98.0-nightly\n", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: "cargo-aarch64-apple-darwin\nrust-src\n",
          stderr: "",
        };
      },
    );
    expect(ready).toEqual({
      cargo: true,
      rustup: true,
      pinnedToolchain: true,
      rustSrc: true,
      rustupPath: "/host/bin/rustup",
      toolchainName:
        `${SYMBIAN_TOOLCHAIN.runtime.rustToolchain}-aarch64-apple-darwin`,
    });
    expect(commands).toEqual([
      "/host/bin/rustup toolchain list",
      `/host/bin/rustup run ${SYMBIAN_TOOLCHAIN.runtime.rustToolchain}-aarch64-apple-darwin cargo --version`,
      `/host/bin/rustup component list --toolchain ${SYMBIAN_TOOLCHAIN.runtime.rustToolchain}-aarch64-apple-darwin --installed`,
    ]);
  });

  test("does not ask rustup to run an absent pinned nightly", async () => {
    const commands: string[] = [];
    const missing = await inspectSymbianRustHost(
      (tool) => tool === "rustup" ? "/host/bin/rustup" : undefined,
      async (command, args) => {
        commands.push([command, ...args].join(" "));
        return {
          exitCode: 0,
          stdout: "stable-aarch64-apple-darwin (default)\n",
          stderr: "",
        };
      },
    );
    expect(missing.pinnedToolchain).toBe(false);
    expect(missing.rustSrc).toBe(false);
    expect(commands).toEqual(["/host/bin/rustup toolchain list"]);
  });

  test("requires exact rust-src instead of a similarly named component", async () => {
    const status = await inspectSymbianRustHost(
      (tool) => tool === "rustup" ? "/host/bin/rustup" : undefined,
      async (_command, args) => {
        if (args.join(" ") === "toolchain list") {
          return {
            exitCode: 0,
            stdout: `${SYMBIAN_TOOLCHAIN.runtime.rustToolchain}\n`,
            stderr: "",
          };
        }
        if (args[0] === "run") {
          return { exitCode: 0, stdout: "cargo nightly\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "rust-src-preview\n", stderr: "" };
      },
    );
    expect(status.pinnedToolchain).toBe(true);
    expect(status.rustSrc).toBe(false);
  });

  test("rejects an installed nightly whose Cargo component cannot run", async () => {
    const status = await inspectSymbianRustHost(
      (tool) => tool === "rustup" ? "/host/bin/rustup" : undefined,
      async (_command, args) => {
        if (args.join(" ") === "toolchain list") {
          return {
            exitCode: 0,
            stdout: `${SYMBIAN_TOOLCHAIN.runtime.rustToolchain}\n`,
            stderr: "",
          };
        }
        if (args[0] === "run") {
          return { exitCode: 1, stdout: "", stderr: "cargo is unavailable" };
        }
        return { exitCode: 0, stdout: "rust-src\n", stderr: "" };
      },
    );
    expect(status.pinnedToolchain).toBe(true);
    expect(status.cargo).toBe(false);
    expect(status.rustSrc).toBe(true);
  });

  test("keeps the Rust override synchronized with the manifest pin", () => {
    const override = Bun.TOML.parse(readFileSync(
      join(repository, "engine/ui-cabi/rust-toolchain.toml"),
      "utf8",
    )) as {
      toolchain: {
        channel: string;
        components: string[];
        profile: string;
      };
    };
    expect(override.toolchain).toEqual({
      channel: SYMBIAN_TOOLCHAIN.runtime.rustToolchain,
      components: ["rust-src"],
      profile: "minimal",
    });
  });

  test("serializes the complete shared runtime payload transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-symbian-runtime-lock-"));
    temporary.push(root);
    const output = join(root, "dist/symbian");
    const payload = join(output, "build/shared-app");
    const env = { POCKET_STACK_CACHE_DIR: join(root, "cache") };
    let active = 0;
    let maxActive = 0;
    const snapshots: string[][] = [];
    const build = (id: string) => withSymbianRuntimeBuildLock(
      output,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          rmSync(payload, { recursive: true, force: true });
          mkdirSync(payload, { recursive: true });
          for (const file of ["plan", "app", "core"]) {
            writeFileSync(join(payload, file), id);
            await Bun.sleep(10);
          }
          snapshots.push(
            ["plan", "app", "core"].map((file) =>
              readFileSync(join(payload, file), "utf8")
            ),
          );
        } finally {
          active -= 1;
        }
      },
      env,
    );
    await Promise.all([build("first"), build("second")]);
    expect(maxActive).toBe(1);
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(new Set(snapshot).size).toBe(1);
    }

    const orchestrator = readFileSync(join(repository, "tools/symbian.ts"), "utf8");
    const transaction = orchestrator.indexOf(
      "const transaction = async () =>",
    );
    expect(transaction).toBeGreaterThan(-1);
    expect(orchestrator.indexOf("rmSync(payload", transaction)).toBeGreaterThan(
      transaction,
    );
    expect(orchestrator.indexOf('resolve(payload, "plan.json")', transaction))
      .toBeGreaterThan(transaction);
    expect(
      orchestrator.indexOf(
        "stageSymbianMassStorageData(massStorageDataRoot, payload)",
        transaction,
      ),
    ).toBeGreaterThan(transaction);
    expect(
      orchestrator.indexOf(
        "return await withSymbianRuntimeBuildLock(outputRoot, transaction)",
        transaction,
      ),
    ).toBeGreaterThan(transaction);
    expect(orchestrator).toContain(
      "!activeBuildTransactions.has(options.transaction)",
    );
  });

  test("serializes guest compilation across independent output roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-symbian-guest-lock-"));
    temporary.push(root);
    const env = { POCKET_STACK_CACHE_DIR: join(root, "cache") };
    let active = 0;
    let maxActive = 0;
    const compile = () => withSymbianGuestBuildLock(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(20);
      active -= 1;
    }, env);
    await Promise.all([compile(), compile()]);
    expect(maxActive).toBe(1);

    const orchestrator = readFileSync(
      join(repository, "tools/symbian.ts"),
      "utf8",
    );
    expect(orchestrator).toContain(
      "await withSymbianGuestBuildLock(async () =>",
    );
    const launcher = readFileSync(
      join(repository, "tools/launcher.ts"),
      "utf8",
    );
    expect(launcher).toContain(
      "await withSymbianGuestBuildLock(async () =>",
    );
    expect(launcher).toContain(
      "await withSymbianBuildTransaction(paths.output",
    );
  });

  test("changes the implementation digest when a repository snapshot changes", () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-symbian-snapshot-digest-"));
    temporary.push(root);
    cpSync(join(repository, "tools/cli"), join(root, "tools/cli"), {
      recursive: true,
    });
    cpSync(join(repository, "tools/symbian"), join(root, "tools/symbian"), {
      recursive: true,
    });
    const before = symbianImplementationDigest(root);
    const manifestPath = join(root, "tools/cli/symbian-toolchain.json");
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, "utf8").replace(
        SYMBIAN_TOOLCHAIN.container.debianSnapshot,
        "20260712T202632Z",
      ),
    );
    expect(symbianImplementationDigest(root)).not.toBe(before);
  });

  test("CODA launch wire and reply parser stay byte-exact", async () => {
    const compiler = Bun.which("cc");
    expect(compiler, "cc is required to validate the shipped CODA client").toBeTruthy();
    const fixture = join(repository, "tests/fixtures/coda-usb-protocol-test.c");
    const implementation = join(repository, "tools/symbian/coda-usb-probe.c");
    const digest = createHash("sha256")
      .update(readFileSync(fixture))
      .update(readFileSync(implementation))
      .update(`${compiler}\0${process.platform}\0${process.arch}`)
      .digest("hex");
    const build = join(
      tmpdir(),
      "pocketjs-coda-protocol-cache",
      digest,
    );
    const binary = join(build, "coda-usb-protocol-test");
    await withArtifactLock(`${build}.lock`, async () => {
      if (existsSync(binary)) return;
      mkdirSync(build, { recursive: true });
      const staged = `${binary}.tmp-${process.pid}-${Date.now()}`;
      const compiled = Bun.spawn({
        cmd: [
          compiler!,
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-Wno-unused-function",
          fixture,
          "-o",
          staged,
        ],
        cwd: repository,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [compiledExit, compiledStderr] = await Promise.all([
        compiled.exited,
        new Response(compiled.stderr).text(),
      ]);
      expect(compiledExit, compiledStderr).toBe(0);
      renameSync(staged, binary);
      rmSync(staged, { force: true });
    });

    // Bun 1.3 on macOS can wait indefinitely in spawnSync while endpoint
    // security validates a freshly linked executable. Cache by exact C source
    // and use an explicit watchdog so the protocol proof is fast after its
    // first launch and can never strand the whole test process.
    const tested = Bun.spawn({
      cmd: [binary],
      cwd: repository,
      stdout: "ignore",
      stderr: "pipe",
    });
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      tested.kill();
    }, 55_000);
    const [testedExit, testedStderr] = await Promise.all([
      tested.exited,
      new Response(tested.stderr).text(),
    ]);
    clearTimeout(watchdog);
    expect(timedOut, "CODA protocol fixture did not start within 55 seconds").toBe(false);
    expect(testedExit, testedStderr).toBe(0);
  }, 60_000);

  test("Docker invocations are amd64, pinned, and narrowly mounted", () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-symbian-repository-"));
    temporary.push(root);
    cpSync(join(repository, "tools/cli"), join(root, "tools/cli"), { recursive: true });
    cpSync(join(repository, "tools/symbian"), join(root, "tools/symbian"), {
      recursive: true,
    });
    const output = join(root, "dist/symbian");
    mkdirSync(output, { recursive: true });
    const build = symbianDockerBuildArguments(root);
    const implementation = symbianImplementationDigest(root);
    expect(implementation).toMatch(/^[a-f0-9]{64}$/);
    expect(build).toEqual(expect.arrayContaining([
      "build",
      "--platform=linux/amd64",
      "--progress=plain",
      "--build-arg",
      `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
      "--build-arg",
      `POCKETJS_SYMBIAN_BASE_IMAGE=${SYMBIAN_TOOLCHAIN.container.baseImage}`,
      "--build-arg",
      `POCKETJS_DEBIAN_SNAPSHOT=${SYMBIAN_TOOLCHAIN.container.debianSnapshot}`,
      "--build-arg",
      `POCKETJS_DEBIAN_SECURITY_SNAPSHOT=${SYMBIAN_TOOLCHAIN.container.debianSecuritySnapshot}`,
      "--build-arg",
      `POCKETJS_SYMBIAN_TOOLCHAIN_VERSION=${SYMBIAN_TOOLCHAIN.toolchainVersion}`,
      "--tag",
      SYMBIAN_TOOLCHAIN.container.image,
    ]));

    const run = symbianDockerRunArguments("/usr/local/bin/build-probe", [], {
      repository: root,
      output,
      downloads: "/tmp/pocketjs-symbian-downloads",
    });
    expect(run).toEqual(expect.arrayContaining([
      "run",
      "--rm",
      "--platform=linux/amd64",
      "--network=none",
      "--env",
      `POCKETJS_SYMBIAN_IMPLEMENTATION_SHA256=${implementation}`,
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain,readonly`,
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing,readonly`,
      `type=bind,src=${root},dst=/workspace,readonly`,
      `type=bind,src=${output},dst=/out`,
      "type=bind,src=/tmp/pocketjs-symbian-downloads,dst=/downloads,readonly",
    ]));
    expect(run.join(" ")).not.toMatch(/--privileged|\/dev(?:\/|\s)|\/tmp\/home|\/Users\//);

    const setup = symbianDockerSetupArguments(
      "/tmp/pocketjs-symbian-downloads",
      root,
    );
    expect(setup).toEqual(expect.arrayContaining([
      "run",
      "--rm",
      "--platform=linux/amd64",
      "--network=none",
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain`,
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing`,
      "type=bind,src=/tmp/pocketjs-symbian-downloads,dst=/downloads,readonly",
    ]));

    const doctor = symbianDockerDoctorArguments(root);
    expect(doctor).toEqual(expect.arrayContaining([
      "run",
      "--rm",
      "--platform=linux/amd64",
      "--network=none",
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.volume},dst=/toolchain,readonly`,
      `type=volume,src=${SYMBIAN_TOOLCHAIN.container.signingVolume},dst=/signing,readonly`,
    ]));
  });
});
