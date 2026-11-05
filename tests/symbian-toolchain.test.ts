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
import { BUILD_STD_NIGHTLY } from "../tools/build/toolchains/rust.ts";
import {
SYMBIAN_DOWNLOADS,
SYMBIAN_TOOLCHAIN,
inspectSymbianRustHost,
receiptMatchesSymbianManifest,
symbianDockerBuildArguments,
symbianDockerDoctorArguments,
symbianDockerRunArguments,
symbianDockerSetupArguments,
symbianDownloadsRoot,
withSymbianGuestBuildLock,
withSymbianRuntimeBuildLock
} from "../tools/build/toolchains/symbian.ts";
import { withArtifactLock } from "../tools/targets/lock.ts";

const repository = new URL("..", import.meta.url).pathname;
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("canonical Symbian E7 toolchain", () => {

  test("resolves shared cache and an explicit downloads override", () => {
    expect(symbianDownloadsRoot({
      HOME: "/tmp/home",
      XDG_CACHE_HOME: "/tmp/cache",
    })).toBe("/tmp/cache/pocket-nexus/symbian/downloads");
    expect(symbianDownloadsRoot({
      HOME: "/tmp/home",
      POCKET_NEXUS_CACHE_DIR: "/tmp/pocket-cache",
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
    expect(receiptMatchesSymbianManifest({ ...receipt, platform: "linux/arm64" })).toBe(false);
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

  test("uses the shared explicit build-std compiler", () => {
    expect(SYMBIAN_TOOLCHAIN.runtime.rustToolchain).toBe(BUILD_STD_NIGHTLY);
  });

  test("serializes the complete shared runtime payload transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-symbian-runtime-lock-"));
    temporary.push(root);
    const output = join(root, "dist/symbian");
    const payload = join(output, "build/shared-app");
    const env = { POCKET_NEXUS_CACHE_DIR: join(root, "cache") };
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


  });

  test("serializes guest compilation across independent output roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-symbian-guest-lock-"));
    temporary.push(root);
    const env = { POCKET_NEXUS_CACHE_DIR: join(root, "cache") };
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
    cpSync(join(repository, "tools/build/toolchains/symbian"), join(root, "tools/build/toolchains/symbian"), { recursive: true });
    cpSync(join(repository, "tools/symbian"), join(root, "tools/symbian"), {
      recursive: true,
    });
    const output = join(root, "dist/symbian");
    mkdirSync(output, { recursive: true });
    const build = symbianDockerBuildArguments(root);
    expect(build).toEqual(expect.arrayContaining([
      "build",
      "--platform=linux/amd64",
      "--progress=plain",
      "--build-arg",
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
