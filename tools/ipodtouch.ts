import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import { bakeIPodTouchArtwork } from "./ipodtouch-icon.ts";
import {
  IPODTOUCH_DEV_TARGET_ID,
  resolveIPodTouchBuildPlan,
} from "./ipodtouch-profile.ts";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const DEVICE_TYPE = "iPod7,1";
const DEVICE_VERSION = "12.5.8";
const DEVICE_BUILD = "16H88";
const DEVICE_PORT = 44;
const LOCAL_PORT = Number(process.env.POCKETJS_IPODTOUCH_PORT ?? "2223");
const KEY_PATH =
  process.env.POCKETJS_IPODTOUCH_KEY ??
  join(homedir(), ".cache/pocket-nexus/ipodtouch/keys/pocketjs_ed25519");
const BUNDLE_NAME = "PocketJSiPod.app";
const BUNDLE_ID = "dev.pocket-nexus.ipodtouch-demo";
const INSTALL_PATH = `/Applications/${BUNDLE_NAME}`;
const STATUS_PATH = "/private/var/tmp/pocketjs-ipodtouch.status.json";
const FRAME_PATH = "/private/var/tmp/pocketjs-ipodtouch.frame.png";
const DEPLOYMENT_TARGET = "12.0";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface BuildReceipt {
  readonly schema: 1;
  readonly buildId: string;
  readonly bundleId: string;
  readonly target: string;
  readonly hostAbi: number;
  readonly deploymentTarget: string;
  readonly files: Readonly<Record<string, string>>;
}

interface DeviceStatus {
  readonly schema: number;
  readonly build_id: string;
  readonly bundle_id: string;
  readonly state: string;
  readonly pid: number;
  readonly written_at: number;
  readonly guest_frames: number;
  readonly completed_touch_sequences: number;
  readonly action_name: string;
  readonly action_value: number;
  readonly action_sequence: number;
  readonly screen_points: [number, number];
  readonly screen_scale: number;
  readonly error: string;
}

function run(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Uint8Array } = {},
): CommandResult {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    cwd: options.cwd ?? REPOSITORY,
    env: options.env ?? process.env,
    stdin: options.input,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function mustRun(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Uint8Array } = {},
): string {
  const result = run(executable, args, options);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(
      `pocket ipodtouch: ${executable} ${args.join(" ")} failed (${result.exitCode})${
        detail ? `:\n${detail}` : ""
      }`,
    );
  }
  return result.stdout.trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface BuildIdentityInput {
  readonly label: string;
  readonly path: string;
}

function hashInputs(inputs: readonly (string | BuildIdentityInput)[]): string {
  const hash = createHash("sha256");
  for (const input of inputs) {
    const path = typeof input === "string" ? input : input.path;
    const label = typeof input === "string" ? path.slice(REPOSITORY.length) : input.label;
    const bytes = readFileSync(path);
    hash.update(`${Buffer.byteLength(label)}:`);
    hash.update(label);
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return hash.digest("hex").slice(0, 32);
}

function commandPath(name: string): string | undefined {
  return Bun.which(name) ?? undefined;
}

function check(label: string, ok: boolean, detail: string): boolean {
  console.log(`[${ok ? "ok" : "missing"}] ${label}: ${detail}`);
  return ok;
}

function manifestPath(): string {
  return join(REPOSITORY, "apps/ipodtouch-demo/pocket.json");
}

function planPath(): string {
  return join(REPOSITORY, ".pocket/ipodtouch/ipodtouch-demo.plan.json");
}

function guestDirectory(): string {
  return join(REPOSITORY, "dist/ipodtouch/guest");
}

function bundleDirectory(): string {
  return join(REPOSITORY, `dist/ipodtouch/${BUNDLE_NAME}`);
}

function receiptPath(): string {
  return join(bundleDirectory(), "build-receipt.json");
}

function readReceipt(): BuildReceipt {
  if (!existsSync(receiptPath())) {
    throw new Error("pocket ipodtouch: no built bundle; run `bun ipodtouch build`");
  }
  return JSON.parse(readFileSync(receiptPath(), "utf8")) as BuildReceipt;
}

function deviceUdid(): string {
  const requested = process.env.POCKETJS_IPODTOUCH_UDID?.trim();
  if (requested) return requested;
  const ids = mustRun("idevice_id", ["-l"])
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length !== 1) {
    throw new Error(
      `pocket ipodtouch: expected exactly one paired USB device, found ${ids.length}; set POCKETJS_IPODTOUCH_UDID`,
    );
  }
  return ids[0];
}

function deviceValue(udid: string, key: string): string {
  return mustRun("ideviceinfo", ["-u", udid, "-k", key]);
}

function verifyDeviceIdentity(): string {
  const udid = deviceUdid();
  const observed = {
    type: deviceValue(udid, "ProductType"),
    version: deviceValue(udid, "ProductVersion"),
    build: deviceValue(udid, "BuildVersion"),
    activation: deviceValue(udid, "ActivationState"),
  };
  if (
    observed.type !== DEVICE_TYPE ||
    observed.version !== DEVICE_VERSION ||
    observed.build !== DEVICE_BUILD ||
    observed.activation !== "Activated"
  ) {
    throw new Error(
      `pocket ipodtouch: refusing device ${observed.type} ${observed.version} (${observed.build}) ` +
        `activation=${observed.activation}; expected ${DEVICE_TYPE} ${DEVICE_VERSION} (${DEVICE_BUILD}) Activated`,
    );
  }
  return udid;
}

function sshArgs(port: number, command: string): string[] {
  return [
    "-i",
    KEY_PATH,
    "-p",
    String(port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=3",
    "-o",
    `HostKeyAlias=[127.0.0.1]:${LOCAL_PORT}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "root@127.0.0.1",
    command,
  ];
}

function remote(port: number, command: string): CommandResult {
  return run("ssh", sshArgs(port, command));
}

function mustRemote(port: number, command: string): string {
  const result = remote(port, command);
  if (result.exitCode !== 0) {
    throw new Error(
      `pocket ipodtouch: device command failed (${result.exitCode}):\n${
        [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
      }`,
    );
  }
  return result.stdout.trim();
}

async function availableLocalPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("pocket ipodtouch: could not allocate a loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function withTunnel<T>(
  operation: (port: number, udid: string) => Promise<T> | T,
): Promise<T> {
  // Always bind a fresh iproxy to the verified UDID. A listener already using
  // LOCAL_PORT may point at another device, so it is only the known-host alias
  // for SSH verification and for the explicit long-running `tunnel` command.
  const udid = verifyDeviceIdentity();
  const port = await availableLocalPort();
  const tunnel = Bun.spawn({
    cmd: ["iproxy", "-u", udid, `${port}:${DEVICE_PORT}`],
    cwd: REPOSITORY,
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Bun.sleep(200);
      if (remote(port, "true").exitCode === 0) return await operation(port, udid);
      if (tunnel.exitCode !== null) break;
    }
    if (tunnel.exitCode === null) tunnel.kill();
    await tunnel.exited;
    const stderr = await new Response(tunnel.stderr as ReadableStream).text();
    throw new Error(`pocket ipodtouch: USB SSH tunnel did not become ready${stderr ? `:\n${stderr}` : ""}`);
  } finally {
    if (tunnel.exitCode === null) {
      tunnel.kill();
      await tunnel.exited;
    }
  }
}

async function doctor(): Promise<void> {
  let ok = true;
  const required = ["bun", "cargo", "rustup", "xcrun", "ldid", "idevice_id", "ideviceinfo", "iproxy", "ssh", "scp"];
  for (const name of required) {
    const path = commandPath(name);
    ok = check(name, path !== undefined, path ?? "not found") && ok;
  }
  const targets = commandPath("rustup") ? run("rustup", ["target", "list", "--installed"]).stdout : "";
  ok = check(
    "Rust aarch64-apple-ios target",
    targets.includes("aarch64-apple-ios\n"),
    targets.includes("aarch64-apple-ios\n") ? "installed" : "rustup target add aarch64-apple-ios",
  ) && ok;
  ok = check("USB deployment key", existsSync(KEY_PATH), KEY_PATH) && ok;
  if (!ok) {
    process.exitCode = 1;
    return;
  }

  await withTunnel((port, udid) => {
    console.log(
      `[ok] device identity: ${DEVICE_TYPE} ${DEVICE_VERSION} (${DEVICE_BUILD}), ${udid.slice(0, 8)}…`,
    );
    const remoteInfo = mustRemote(
      port,
      "set -eu; test \"$(uname -m)\" = iPod7,1; test -x /usr/bin/ldid; test -x /usr/bin/uicache; test -x /usr/bin/uiopen; test -w /Applications; echo jailbreak-usb-ready",
    );
    console.log(`[ok] jailbreak transport: ${remoteInfo}`);
  });
}

async function build(): Promise<void> {
  const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
  const plan = resolveIPodTouchBuildPlan(manifest);
  mkdirSync(dirname(planPath()), { recursive: true });
  writeFileSync(planPath(), JSON.stringify(plan, null, 2) + "\n");
  const inputs = extractHostBuildInputs(plan, { expectedTarget: IPODTOUCH_DEV_TARGET_ID });

  rmSync(guestDirectory(), { recursive: true, force: true });
  mkdirSync(guestDirectory(), { recursive: true });
  mustRun("bun", [
    "tools/build.ts",
    `--plan=${planPath()}`,
    `--project-root=${REPOSITORY}`,
    `--outdir=${guestDirectory()}`,
  ]);
  const guestJavaScript = join(guestDirectory(), `${inputs.appOutput}.js`);
  const guestPak = join(guestDirectory(), `${inputs.appOutput}.pak`);
  if (!existsSync(guestJavaScript) || !existsSync(guestPak)) {
    throw new Error("pocket ipodtouch: guest build did not produce its JS and pak artifacts");
  }

  const rustTarget = join(homedir(), ".cache/pocket-nexus/ipodtouch/rust-target");
  mkdirSync(rustTarget, { recursive: true });
  const rustEnv = {
    ...process.env,
    CARGO_TARGET_DIR: rustTarget,
    IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
  };
  mustRun(
    "cargo",
    ["build", "-p", "pocket-apple", "--release", "--locked", "--target", "aarch64-apple-ios"],
    {
      cwd: join(REPOSITORY, "engine"),
      env: rustEnv,
    },
  );
  const rustLibrary = join(rustTarget, "aarch64-apple-ios/release/libpocket_apple.a");
  if (!existsSync(rustLibrary)) {
    throw new Error(`pocket ipodtouch: missing Rust static library at ${rustLibrary}`);
  }

  const bundle = bundleDirectory();
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });
  cpSync(join(REPOSITORY, "hosts/ipodtouch6/Info.plist"), join(bundle, "Info.plist"));
  cpSync(join(REPOSITORY, "hosts/ipodtouch6/PkgInfo"), join(bundle, "PkgInfo"));
  cpSync(guestJavaScript, join(bundle, `${inputs.appOutput}.js`));
  cpSync(guestPak, join(bundle, `${inputs.appOutput}.pak`));
  await bakeIPodTouchArtwork(bundle);

  const buildId = hashInputs([
    planPath(),
    guestJavaScript,
    guestPak,
    join(REPOSITORY, "hosts/ipodtouch6/Info.plist"),
    join(REPOSITORY, "hosts/ipodtouch6/PkgInfo"),
    join(REPOSITORY, "hosts/ipodtouch6/runtime.m"),
    join(REPOSITORY, "hosts/ipodtouch6/Icon.svg"),
    join(REPOSITORY, "tools/ipodtouch.ts"),
    join(REPOSITORY, "tools/ipodtouch-icon.ts"),
    join(REPOSITORY, "engine/ios/include/pocket_apple.h"),
    join(REPOSITORY, "engine/ios/uikit/PocketSurfaceView.h"),
    join(REPOSITORY, "engine/ios/uikit/PocketSurfaceView.m"),
    join(REPOSITORY, "engine/ios/src/lib.rs"),
    {
      label: "native/libpocket_apple.a",
      path: rustLibrary,
    },
  ]);
  const executable = join(bundle, "PocketJSiPod");
  mustRun("xcrun", [
    "--sdk",
    "iphoneos",
    "clang",
    "-target",
    `arm64-apple-ios${DEPLOYMENT_TARGET}`,
    "-fobjc-arc",
    "-fblocks",
    "-O2",
    `-DPOCKETJS_BUILD_ID=\"${buildId}\"`,
    `-DPOCKETJS_APP_OUTPUT=\"${inputs.appOutput}\"`,
    "-I",
    join(REPOSITORY, "engine/ios/uikit"),
    "-I",
    join(REPOSITORY, "engine/ios/include"),
    join(REPOSITORY, "hosts/ipodtouch6/runtime.m"),
    join(REPOSITORY, "engine/ios/uikit/PocketSurfaceView.m"),
    rustLibrary,
    "-framework",
    "Foundation",
    "-framework",
    "UIKit",
    "-framework",
    "QuartzCore",
    "-framework",
    "CoreGraphics",
    "-lresolv",
    "-Wl,-dead_strip",
    "-o",
    executable,
  ]);
  mustRun("chmod", ["755", executable]);
  mustRun("ldid", ["-S", executable]);
  mustRun("plutil", ["-lint", join(bundle, "Info.plist")]);

  const fileNames = [
    "PocketJSiPod",
    "Info.plist",
    "PkgInfo",
    `${inputs.appOutput}.js`,
    `${inputs.appOutput}.pak`,
    "Icon.png",
    "Icon@2x.png",
    "Icon-60@2x.png",
    "Icon-60@3x.png",
    "Default@2x.png",
    "Default-568h@2x.png",
  ];
  const files = Object.fromEntries(fileNames.map((name) => [name, sha256(join(bundle, name))]));
  const receipt: BuildReceipt = {
    schema: 1,
    buildId,
    bundleId: BUNDLE_ID,
    target: inputs.target,
    hostAbi: inputs.hostAbi,
    deploymentTarget: DEPLOYMENT_TARGET,
    files,
  };
  writeFileSync(receiptPath(), JSON.stringify(receipt, null, 2) + "\n");

  console.log(`built ${bundle}`);
  console.log(mustRun("file", [executable]));
  console.log(`build_id=${buildId}`);
}

interface DeploymentPaths {
  readonly archive: string;
  readonly unpack: string;
  readonly stage: string;
  readonly backup: string;
  readonly lock: string;
}

export function ipodTouchDeploymentPaths(transactionId: string): DeploymentPaths {
  if (!/^[0-9a-f]{24}$/.test(transactionId)) {
    throw new Error("pocket ipodtouch: deployment transaction id must be 24 lowercase hex digits");
  }
  return {
    archive: `/private/var/tmp/pocketjs-ipodtouch-${transactionId}.app.tar`,
    unpack: `/Applications/.PocketJSiPod.app.pocketjs-unpack-${transactionId}`,
    stage: `/Applications/.PocketJSiPod.app.pocketjs-stage-${transactionId}`,
    backup: `/Applications/.PocketJSiPod.app.pocketjs-backup-${transactionId}`,
    lock: "/private/var/tmp/pocketjs-ipodtouch.deploy.lock",
  };
}

export function deploymentInstallCommand(transactionId: string, paths: DeploymentPaths): string {
  return (
    "set -eu; " +
    `dest=${INSTALL_PATH}; stage=${paths.stage}; backup=${paths.backup}; ` +
    "had_previous=0; installed_new=0; " +
    "rollback() { status=$?; trap - EXIT HUP INT TERM; set +e; " +
    "if [ \"$installed_new\" -eq 1 ]; then rm -rf \"$dest\"; fi; " +
    "if [ \"$had_previous\" -eq 1 ] && [ -e \"$backup\" ]; then " +
    "mv \"$backup\" \"$dest\"; " +
    "chown -R root:wheel \"$dest\"; chmod 755 \"$dest/PocketJSiPod\"; " +
    "/usr/bin/uicache -p \"$dest\"; fi; exit \"$status\"; }; " +
    "trap rollback EXIT HUP INT TERM; " +
    "if [ -e \"$dest\" ]; then mv \"$dest\" \"$backup\"; had_previous=1; fi; " +
    "mv \"$stage\" \"$dest\"; installed_new=1; chown -R root:wheel \"$dest\"; " +
    "chmod 755 \"$dest/PocketJSiPod\"; test -x \"$dest/PocketJSiPod\"; " +
    "/usr/bin/ldid -e \"$dest/PocketJSiPod\" >/dev/null; " +
    "/usr/bin/uicache -p \"$dest\"; trap - EXIT HUP INT TERM; " +
    "rm -rf \"$backup\"; " +
    `echo installed-${transactionId}`
  );
}

async function deploy(): Promise<void> {
  await build();
  const receipt = readReceipt();
  const transactionId = randomBytes(12).toString("hex");
  const paths = ipodTouchDeploymentPaths(transactionId);
  const archive = join(REPOSITORY, `.pocket-build/ipodtouch/PocketJSiPod.app-${transactionId}.tar`);
  mkdirSync(dirname(archive), { recursive: true });
  mustRun(
    "tar",
    ["-cf", archive, "-C", dirname(bundleDirectory()), BUNDLE_NAME],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );

  try {
    await withTunnel(async (port) => {
      mustRun("scp", [
        "-O",
        "-i",
        KEY_PATH,
        "-P",
        String(port),
        "-o",
        "BatchMode=yes",
        "-o",
        `HostKeyAlias=[127.0.0.1]:${LOCAL_PORT}`,
        "-o",
        "StrictHostKeyChecking=yes",
        archive,
        `root@127.0.0.1:${paths.archive}`,
      ]);

      let lockHeld = false;
      let operationError: unknown;
      try {
        mustRemote(
          port,
          "set -eu; " +
            `lock=${paths.lock}; tx=${transactionId}; ` +
            "if mkdir \"$lock\" 2>/dev/null; then printf '%s\\n' \"$tx\" > \"$lock/owner\"; " +
            "else owner=$(cat \"$lock/owner\" 2>/dev/null || echo unknown); " +
            "echo \"deployment busy (owner $owner)\" >&2; exit 73; fi",
        );
        lockHeld = true;
        mustRemote(
          port,
          "set -eu; " +
            `stage=${paths.stage}; unpack=${paths.unpack}; archive=${paths.archive}; ` +
            "rm -rf \"$stage\" \"$unpack\"; mkdir -p \"$unpack\"; " +
            "tar -xf \"$archive\" -C \"$unpack\"; " +
            "test -d \"$unpack/PocketJSiPod.app\"; " +
            "mv \"$unpack/PocketJSiPod.app\" \"$stage\"; rmdir \"$unpack\"; " +
            "test -x \"$stage/PocketJSiPod\"; " +
            "/usr/bin/ldid -e \"$stage/PocketJSiPod\" >/dev/null",
        );
        const fileNames = Object.keys(receipt.files);
        if (fileNames.some((name) => !/^[A-Za-z0-9@._-]+$/.test(name))) {
          throw new Error("pocket ipodtouch: receipt contains an unsafe bundle file name");
        }
        const hashes = mustRemote(
          port,
          `cd ${paths.stage} && /usr/bin/sha256sum ${fileNames.join(" ")}`,
        );
        const remoteFiles = new Map(
          hashes.split("\n").map((line) => {
            const match = line.match(/^([0-9a-f]{64})\s+(.+)$/);
            if (!match) throw new Error(`pocket ipodtouch: malformed device hash line: ${line}`);
            return [match[2], match[1]];
          }),
        );
        for (const [name, expected] of Object.entries(receipt.files)) {
          if (remoteFiles.get(name) !== expected) {
            throw new Error(`pocket ipodtouch: device readback mismatch for ${name}`);
          }
        }
        mustRemote(port, deploymentInstallCommand(transactionId, paths));
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        const cleanup = remote(
          port,
          "set +e; " +
            `rm -rf ${paths.stage} ${paths.unpack} ${paths.archive}; ` +
            (lockHeld
              ? `lock=${paths.lock}; tx=${transactionId}; ` +
                "if [ -f \"$lock/owner\" ] && [ \"$(cat \"$lock/owner\")\" = \"$tx\" ]; then rm -rf \"$lock\"; fi"
              : "true"),
        );
        if (cleanup.exitCode !== 0 && operationError === undefined) {
          throw new Error(
            `pocket ipodtouch: deployment cleanup failed (${cleanup.exitCode}):\n${cleanup.stderr.trim()}`,
          );
        }
      }
    });
  } finally {
    rmSync(archive, { force: true });
  }
  console.log(`deployed ${receipt.buildId} to ${INSTALL_PATH} with byte-exact readback`);
}

async function launch(): Promise<void> {
  const receipt = readReceipt();
  await withTunnel(async (port) => {
    const installed = mustRemote(port, `cat ${INSTALL_PATH}/build-receipt.json`);
    const installedReceipt = JSON.parse(installed) as BuildReceipt;
    if (installedReceipt.buildId !== receipt.buildId) {
      throw new Error(
        `pocket ipodtouch: installed build ${installedReceipt.buildId} does not match local ${receipt.buildId}`,
      );
    }
    mustRemote(
      port,
      `killall PocketJSiPod 2>/dev/null || true; rm -f ${STATUS_PATH} ${FRAME_PATH}; ` +
        "/usr/bin/uiopen pocketjs-ipodtouch://launch; echo launch-requested",
    );
    await Bun.sleep(2500);
  });
  await status(false);
}

async function readDeviceStatus(port: number): Promise<DeviceStatus> {
  const raw = mustRemote(port, `cat ${STATUS_PATH}`);
  return JSON.parse(raw) as DeviceStatus;
}

async function status(requireAction: boolean): Promise<void> {
  const receipt = readReceipt();
  await withTunnel(async (port) => {
    const first = await readDeviceStatus(port);
    await Bun.sleep(1200);
    const current = await readDeviceStatus(port);
    if (current.schema !== 1 || current.bundle_id !== BUNDLE_ID) {
      throw new Error("pocket ipodtouch: malformed device status identity");
    }
    if (current.build_id !== receipt.buildId) {
      throw new Error(
        `pocket ipodtouch: status build ${current.build_id} does not match local ${receipt.buildId}`,
      );
    }
    if (current.state !== "running" || current.error !== "") {
      throw new Error(`pocket ipodtouch: guest state=${current.state} error=${current.error || "none"}`);
    }
    if (current.guest_frames <= first.guest_frames) {
      throw new Error("pocket ipodtouch: guest frame counter did not advance");
    }
    if (Date.now() / 1000 - current.written_at > 5) {
      throw new Error("pocket ipodtouch: status heartbeat is stale");
    }
    mustRemote(port, `kill -0 ${current.pid}`);
    if (
      current.screen_points[0] !== 320 ||
      current.screen_points[1] !== 568 ||
      current.screen_scale !== 2
    ) {
      throw new Error(
        `pocket ipodtouch: unexpected screen ${current.screen_points.join("x")} @${current.screen_scale}`,
      );
    }
    if (
      requireAction &&
      (current.completed_touch_sequences < 1 ||
        current.action_name !== "hero_tap" ||
        current.action_value < 1 ||
        current.action_sequence < 1)
    ) {
      throw new Error("pocket ipodtouch: no completed Hero touch/action receipt yet");
    }
    console.log(JSON.stringify(current, null, 2));
  });
}

async function capture(): Promise<void> {
  const destination = join(REPOSITORY, "dist/ipodtouch/device-frame.png");
  await withTunnel((port) => {
    mustRemote(port, `test -s ${FRAME_PATH}`);
    mustRun("scp", [
      "-O",
      "-i",
      KEY_PATH,
      "-P",
      String(port),
      "-o",
      "BatchMode=yes",
      "-o",
      `HostKeyAlias=[127.0.0.1]:${LOCAL_PORT}`,
      "-o",
      "StrictHostKeyChecking=yes",
      `root@127.0.0.1:${FRAME_PATH}`,
      destination,
    ]);
  });
  console.log(`${mustRun("file", [destination])}\n${destination}`);
}

function tunnel(): never {
  const udid = verifyDeviceIdentity();
  console.log(`forwarding 127.0.0.1:${LOCAL_PORT} to ${DEVICE_TYPE} port ${DEVICE_PORT}`);
  const child = Bun.spawnSync({
    cmd: ["iproxy", "-u", udid, `${LOCAL_PORT}:${DEVICE_PORT}`],
    cwd: REPOSITORY,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(child.exitCode);
}

function usage(): void {
  console.log(`PocketJS iPod touch 6 tool

  bun ipodtouch doctor
  bun ipodtouch build
  bun ipodtouch deploy
  bun ipodtouch launch
  bun ipodtouch status [--require-action]
  bun ipodtouch capture
  bun ipodtouch tunnel`);
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const command = args[0] ?? "doctor";
  switch (command) {
    case "doctor":
      await doctor();
      break;
    case "build":
      await build();
      break;
    case "deploy":
      await deploy();
      break;
    case "launch":
      await launch();
      break;
    case "status":
      await status(args.includes("--require-action"));
      break;
    case "capture":
      await capture();
      break;
    case "tunnel":
      tunnel();
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      usage();
      throw new Error(`pocket ipodtouch: unknown command ${command}`);
  }
}

if (import.meta.main) {
  await main();
}
