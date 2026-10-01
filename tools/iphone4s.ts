import { createHash, randomBytes } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import {
  bakeClassicIPhoneArtwork,
  IPHONE_CLASSIC_ICON_FILE,
  IPHONE_CLASSIC_RETINA_ICON_FILE,
} from "./iphone-classic-icon.ts";
import {
  IPHONE4S_TOOLCHAIN,
  inspectIPhone4SToolchain,
  iphone4sCacheRoot,
  iphone4sCsuPath,
  iphone4sDyldPath,
  iphone4sQuickJsPath,
  iphone4sSysrootPath,
  sha256File,
} from "./iphone4s-toolchain.ts";
import {
  IPHONE4S_DEV_TARGET_ID,
  IPHONE4S_PHYSICAL_VIEWPORT,
  IPHONE4S_RASTER_DENSITY,
  resolveIPhone4SBuildPlan,
} from "./iphone4s-profile.ts";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const DEVICE_TYPE = "iPhone4,1";
const DEVICE_HARDWARE = "N94AP";
const DEVICE_VERSION = "6.1.3";
const DEVICE_BUILD = "10B329";
const DEVICE_PORT = IPHONE4S_TOOLCHAIN.deployment.devicePort;
const LOCAL_PORT = Number(process.env.POCKETJS_IPHONE4S_PORT ?? String(IPHONE4S_TOOLCHAIN.deployment.localPort));
const KEY_PATH =
  process.env.POCKETJS_IPHONE4S_KEY ??
  join(iphone4sCacheRoot(), "ssh/id_rsa");
const KNOWN_HOSTS_PATH =
  process.env.POCKETJS_IPHONE4S_KNOWN_HOSTS ?? join(iphone4sCacheRoot(), "ssh/known_hosts");
const BUNDLE_NAME = "PocketJSiPhone4S.app";
const BUNDLE_ID = "dev.pocket-nexus.iphone4s-demo";
const INSTALL_PATH = `/Applications/${BUNDLE_NAME}`;
const STATUS_PATH = "/private/var/tmp/pocketjs-iphone4s.status";
const FRAME_PATH = "/private/var/tmp/pocketjs-iphone4s.frame.rgba";
const CAPTURE_REQUEST_PATH = "/private/var/tmp/pocketjs-iphone4s.capture";
const DEPLOYMENT_TARGET = IPHONE4S_TOOLCHAIN.compiler.minimumVersion;
const DEPLOYMENT_LEASE_SECONDS = 10 * 60;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface BinaryCommandResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
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

const BUILD_ID_PLACEHOLDER = "00000000000000000000000000000000";

interface DeviceStatus {
  readonly schema: number;
  readonly build_id: string;
  readonly state: string;
  readonly pid: number;
  readonly written_at: number;
  readonly guest_frames: number;
  readonly completed_touch_sequences: number;
  readonly action_name: string;
  readonly action_value: number;
  readonly action_sequence: number;
  readonly heartbeat: number;
  readonly renderer: string;
  readonly clock: string;
  readonly raster_density: number;
  readonly drawable_width: number;
  readonly drawable_height: number;
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

function runBinary(executable: string, args: readonly string[]): BinaryCommandResult {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    cwd: REPOSITORY,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout),
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
      `pocket iphone4s: ${executable} ${args.join(" ")} failed (${result.exitCode})${
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

export function buildReceiptsMatch(left: BuildReceipt, right: BuildReceipt): boolean {
  if (
    left.schema !== right.schema ||
    left.buildId !== right.buildId ||
    left.bundleId !== right.bundleId ||
    left.target !== right.target ||
    left.hostAbi !== right.hostAbi ||
    left.deploymentTarget !== right.deploymentTarget
  ) return false;
  const leftFiles = Object.entries(left.files).sort(([a], [b]) => a.localeCompare(b));
  const rightFiles = Object.entries(right.files).sort(([a], [b]) => a.localeCompare(b));
  return leftFiles.length === rightFiles.length && leftFiles.every(
    ([name, digest], index) => rightFiles[index]?.[0] === name && rightFiles[index]?.[1] === digest,
  );
}

function commandPath(name: string): string | undefined {
  return Bun.which(name) ?? undefined;
}

function check(label: string, ok: boolean, detail: string): boolean {
  console.log(`[${ok ? "ok" : "missing"}] ${label}: ${detail}`);
  return ok;
}

function manifestPath(): string {
  return join(REPOSITORY, "apps/iphone4s-demo/pocket.json");
}

function planPath(): string {
  return join(REPOSITORY, ".pocket/iphone4s/iphone4s-demo.plan.json");
}

function guestDirectory(): string {
  return join(REPOSITORY, "dist/iphone4s/guest");
}

function bundleDirectory(): string {
  return join(REPOSITORY, `dist/iphone4s/${BUNDLE_NAME}`);
}

function receiptPath(): string {
  return join(bundleDirectory(), "build-receipt.json");
}

function readReceipt(): BuildReceipt {
  if (!existsSync(receiptPath())) {
    throw new Error("pocket iphone4s: no built bundle; run `bun iphone4s build`");
  }
  return JSON.parse(readFileSync(receiptPath(), "utf8")) as BuildReceipt;
}

function deviceUdid(): string {
  const requested = process.env.POCKETJS_IPHONE4S_UDID?.trim();
  if (requested) return requested;
  const ids = mustRun("idevice_id", ["-l"])
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length !== 1) {
    throw new Error(
      `pocket iphone4s: expected exactly one paired USB device, found ${ids.length}; set POCKETJS_IPHONE4S_UDID`,
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
    hardware: deviceValue(udid, "HardwareModel"),
    version: deviceValue(udid, "ProductVersion"),
    build: deviceValue(udid, "BuildVersion"),
    activation: deviceValue(udid, "ActivationState"),
  };
  if (
    observed.type !== DEVICE_TYPE ||
    observed.hardware !== DEVICE_HARDWARE ||
    observed.version !== DEVICE_VERSION ||
    observed.build !== DEVICE_BUILD ||
    observed.activation !== "Activated"
  ) {
    throw new Error(
      `pocket iphone4s: refusing device ${observed.type}/${observed.hardware} ${observed.version} (${observed.build}) ` +
        `activation=${observed.activation}; expected ${DEVICE_TYPE}/${DEVICE_HARDWARE} ` +
        `${DEVICE_VERSION} (${DEVICE_BUILD}) Activated`,
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
    "-o",
    `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
    "-o",
    "HostKeyAlgorithms=+ssh-rsa",
    "-o",
    "PubkeyAcceptedAlgorithms=+ssh-rsa",
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
      `pocket iphone4s: device command failed (${result.exitCode}):\n${
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
        reject(new Error("pocket iphone4s: could not allocate a loopback port"));
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
    throw new Error(`pocket iphone4s: USB SSH tunnel did not become ready${stderr ? `:\n${stderr}` : ""}`);
  } finally {
    if (tunnel.exitCode === null) {
      tunnel.kill();
      await tunnel.exited;
    }
  }
}

async function doctor(): Promise<void> {
  let ok = true;
  const required = ["bun", "rustup", "xcrun", "ldid", "idevice_id", "ideviceinfo", "iproxy", "ssh", "scp", "tar", "unzip", "hdiutil"];
  for (const name of required) {
    const path = commandPath(name);
    ok = check(name, path !== undefined, path ?? "not found") && ok;
  }
  const toolchain = inspectIPhone4SToolchain();
  ok = check("validated iOS 6.1.3 ARMv7 sysroot", toolchain.sysroot, iphone4sSysrootPath()) && ok;
  ok = check("Apple Csu source", toolchain.csu, iphone4sCsuPath()) && ok;
  ok = check("pinned QuickJS source", toolchain.quickjs, iphone4sQuickJsPath()) && ok;
  ok = check("USB deployment key", existsSync(KEY_PATH), KEY_PATH) && ok;
  ok = check("pinned SSH host key", existsSync(KNOWN_HOSTS_PATH), KNOWN_HOSTS_PATH) && ok;
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
      "set -eu; test \"$(uname -m)\" = iPhone4,1; test -x /usr/bin/ldid; test -x /usr/bin/uicache; test -x /usr/bin/uiopen; test -w /Applications; " +
        "/usr/sbin/sshd -T | grep -q '^pubkeyauthentication yes$'; " +
        "/usr/sbin/sshd -T | grep -q '^passwordauthentication no$'; echo jailbreak-key-only-usb-ready",
    );
    console.log(`[ok] jailbreak transport: ${remoteInfo}`);
  });
}

function ensureCheckout(path: string, repository: string, revision: string, tag?: string): void {
  if (!existsSync(join(path, ".git/HEAD"))) {
    mkdirSync(dirname(path), { recursive: true });
    mustRun("git", ["clone", "--filter=blob:none", "--no-checkout", repository, path]);
    mustRun("git", ["-C", path, "checkout", "--detach", tag ?? revision]);
  }
  const head = mustRun("git", ["-C", path, "rev-parse", "HEAD"]);
  if (head !== revision) throw new Error(`pocket iphone4s: source at ${path} is ${head}, expected ${revision}`);
}

function setupSources(): void {
  const compiler = IPHONE4S_TOOLCHAIN.compiler;
  ensureCheckout(iphone4sCsuPath(), compiler.csu.repository, compiler.csu.revision, compiler.csu.tag);
  ensureCheckout(iphone4sQuickJsPath(), compiler.quickJsRepository, compiler.quickJsRevision);
  ensureCheckout(
    iphone4sDyldPath(),
    IPHONE4S_TOOLCHAIN.dyld.repository,
    IPHONE4S_TOOLCHAIN.dyld.revision,
    IPHONE4S_TOOLCHAIN.dyld.tag,
  );
  const status = inspectIPhone4SToolchain();
  if (!status.csu || !status.quickjs || !status.dyld) throw new Error("pocket iphone4s: downloaded source verification failed");
  console.log(`sources ready in ${iphone4sCacheRoot()}/sources`);
}

function customIpswPath(): string {
  const explicit = process.env.POCKETJS_IPHONE4S_IPSW?.trim();
  if (explicit) return resolve(explicit);
  const directory = join(iphone4sCacheRoot(), "tools/Legacy-iOS-Kit");
  if (!existsSync(directory)) {
    throw new Error("pocket iphone4s: set POCKETJS_IPHONE4S_IPSW to the validated CustomAJ restore IPSW");
  }
  const candidates = readdirSync(directory)
    .filter((name) => /^iPhone4,1_6\.1\.3_10B329_CustomAJ-[0-9]+\.ipsw$/.test(name))
    .map((name) => join(directory, name));
  if (candidates.length !== 1) {
    throw new Error(`pocket iphone4s: expected one validated CustomAJ restore IPSW, found ${candidates.length}; set POCKETJS_IPHONE4S_IPSW`);
  }
  return candidates[0];
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function thinExtractedMachO(root: string): void {
  for (const path of walkFiles(root)) {
    const info = run("lipo", ["-info", path]);
    if (info.exitCode !== 0 || !info.stdout.startsWith("Architectures in the fat file:")) continue;
    if (!info.stdout.includes("armv7")) continue;
    const temporary = `${path}.pocketjs-thin`;
    mustRun("lipo", [path, "-thin", "armv7", "-output", temporary]);
    renameSync(temporary, path);
  }
}

function exportedSymbols(paths: readonly string[]): string[] {
  const symbols = new Set<string>();
  for (const path of paths) {
    const output = mustRun("xcrun", ["nm-classic", "-gU", path]);
    for (const line of output.split("\n")) {
      const match = line.match(/\s[ASTDBIWV]\s(\S+)$/);
      if (match) symbols.add(match[1]);
    }
  }
  return [...symbols].sort();
}

function writeTextStub(output: string, installName: string, sources: readonly string[]): void {
  const symbols = exportedSymbols(sources);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, [
    "--- !tapi-tbd",
    "tbd-version: 4",
    "targets: [ armv7-ios ]",
    `install-name: ${JSON.stringify(installName)}`,
    "exports:",
    "  - targets: [ armv7-ios ]",
    `    symbols: [ ${symbols.map((symbol) => JSON.stringify(symbol)).join(", ")} ]`,
    "...",
    "",
  ].join("\n"));
}

function createLinkerStubs(root: string): void {
  for (const name of ["UIKit", "Foundation", "CoreGraphics", "OpenGLES"]) {
    const binary = join(root, `System/Library/Frameworks/${name}.framework/${name}`);
    writeTextStub(`${binary}.tbd`, `/System/Library/Frameworks/${name}.framework/${name}`, [binary]);
  }
  const systemDirectory = join(root, "usr/lib/system");
  const systemLibraries = readdirSync(systemDirectory)
    .filter((name) => name.endsWith(".dylib"))
    .map((name) => join(systemDirectory, name));
  writeTextStub(join(root, "usr/lib/libSystem.tbd"), "/usr/lib/libSystem.B.dylib", [
    join(root, "usr/lib/libSystem.B.dylib"),
    ...systemLibraries,
  ]);
  writeTextStub(join(root, "usr/lib/libobjc.tbd"), "/usr/lib/libobjc.A.dylib", [join(root, "usr/lib/libobjc.A.dylib")]);
  writeTextStub(join(root, "usr/lib/libgcc_s.1.tbd"), "/usr/lib/libgcc_s.1.dylib", [join(root, "usr/lib/libgcc_s.1.dylib")]);
}

function prepareSysroot(): void {
  setupSources();
  if (inspectIPhone4SToolchain().sysroot) {
    console.log(`validated sysroot already present at ${iphone4sSysrootPath()}`);
    return;
  }
  const ipsw = customIpswPath();
  if (!existsSync(ipsw)) throw new Error(`pocket iphone4s: restore IPSW does not exist: ${ipsw}`);
  const transaction = randomBytes(8).toString("hex");
  const source = join(iphone4sCacheRoot(), "sysroot-source");
  const mount = join(iphone4sCacheRoot(), `mount-${transaction}`);
  const staging = join(iphone4sCacheRoot(), `sysroot-6.1.3-stage-${transaction}`);
  const buildDirectory = join(iphone4sCacheRoot(), `build/dsc-extractor-${transaction}`);
  mkdirSync(source, { recursive: true });
  mkdirSync(mount, { recursive: true });
  mkdirSync(staging, { recursive: true });
  mkdirSync(buildDirectory, { recursive: true });
  const dmg = join(source, IPHONE4S_TOOLCHAIN.firmware.rootFilesystemAsset);
  mustRun("unzip", ["-j", "-o", ipsw, IPHONE4S_TOOLCHAIN.firmware.rootFilesystemAsset, "-d", source]);
  let mounted = false;
  let operationError: unknown;
  try {
    mustRun("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg]);
    mounted = true;
    const cache = join(mount, IPHONE4S_TOOLCHAIN.firmware.sharedCachePath);
    if (sha256File(cache) !== IPHONE4S_TOOLCHAIN.firmware.sharedCacheSha256) {
      throw new Error("pocket iphone4s: mounted iOS shared cache hash does not match 10B329");
    }
    const dyldSource = iphone4sDyldPath();
    const extractorSource = join(buildDirectory, "dsc_extractor.cpp");
    let extractor = readFileSync(join(dyldSource, "launch-cache/dsc_extractor.cpp"), "utf8");
    extractor = extractor.replace("const char* afterSlash", "char* afterSlash").replace("const char* slash;", "char* slash;");
    if (extractor.includes("const char* afterSlash") || extractor.includes("const char* slash;")) {
      throw new Error("pocket iphone4s: pinned dyld extractor compatibility patch did not apply");
    }
    writeFileSync(extractorSource, extractor);
    const main = join(buildDirectory, "main.cpp");
    writeFileSync(main, `#include <stdio.h>\nextern \"C\" int dyld_shared_cache_extract_dylibs_progress(const char *, const char *, void (^)(unsigned, unsigned));\nint main(int argc, const char **argv) { if (argc != 3) return 64; return dyld_shared_cache_extract_dylibs_progress(argv[1], argv[2], ^(unsigned current, unsigned total) { if (current == total || current % 100 == 0) fprintf(stderr, \"%u/%u\\n\", current, total); }); }\n`);
    const extractorBinary = join(buildDirectory, "dsc-extractor");
    mustRun("xcrun", ["clang++", "-std=gnu++11", "-fblocks", "-Wno-deprecated-declarations",
      "-I", join(dyldSource, "include"), "-I", join(dyldSource, "launch-cache"), extractorSource,
      join(dyldSource, "launch-cache/dsc_iterator.cpp"), main, "-o", extractorBinary]);
    mustRun(extractorBinary, [cache, staging]);
    thinExtractedMachO(staging);
    createLinkerStubs(staging);
    for (const [relative, expected] of Object.entries(IPHONE4S_TOOLCHAIN.compiler.sysrootFiles)) {
      const path = join(staging, relative);
      if (!existsSync(path) || sha256File(path) !== expected) throw new Error(`pocket iphone4s: extracted sysroot mismatch for ${relative}`);
    }
    const destination = iphone4sSysrootPath();
    const backup = `${destination}.backup-${transaction}`;
    if (existsSync(destination)) renameSync(destination, backup);
    try {
      renameSync(staging, destination);
      if (!inspectIPhone4SToolchain().sysroot) throw new Error("pocket iphone4s: installed sysroot failed verification");
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
    console.log(`prepared validated ARMv7 sysroot at ${destination}`);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (mounted) {
      const detached = run("hdiutil", ["detach", mount]);
      if (detached.exitCode === 0) {
        rmSync(mount, { recursive: true, force: true });
      } else if (operationError === undefined) {
        throw new Error(`pocket iphone4s: failed to detach read-only restore image:\n${detached.stderr.trim()}`);
      } else {
        console.error(`pocket iphone4s: warning: restore image remains mounted at ${mount}`);
      }
    } else {
      rmSync(mount, { recursive: true, force: true });
    }
    rmSync(staging, { recursive: true, force: true });
    rmSync(buildDirectory, { recursive: true, force: true });
  }
}

async function build(): Promise<void> {
  setupSources();
  const toolchain = inspectIPhone4SToolchain();
  if (!toolchain.sysroot) {
    throw new Error("pocket iphone4s: validated iOS 6.1.3 sysroot is absent; run `bun iphone4s prepare-sysroot`");
  }
  const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
  const plan = resolveIPhone4SBuildPlan(manifest);
  mkdirSync(dirname(planPath()), { recursive: true });
  writeFileSync(planPath(), JSON.stringify(plan, null, 2) + "\n");
  const inputs = extractHostBuildInputs(plan, { expectedTarget: IPHONE4S_DEV_TARGET_ID });

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
    throw new Error("pocket iphone4s: guest build did not produce its JS and pak artifacts");
  }

  const clang = mustRun("xcrun", ["--find", "clang"]);
  const linker = mustRun("xcrun", ["--find", IPHONE4S_TOOLCHAIN.compiler.linker]);
  const macosSdk = mustRun("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const sysroot = iphone4sSysrootPath();
  const csu = iphone4sCsuPath();
  const quickjs = join(iphone4sQuickJsPath(), "libquickjs-sys/embed/quickjs");
  const nativeBuild = join(REPOSITORY, ".pocket-build/iphone4s/runtime");
  const rustTarget = join(iphone4sCacheRoot(), "build/rust-target");
  const cargoHome = join(iphone4sCacheRoot(), "build/cargo-home");
  rmSync(nativeBuild, { recursive: true, force: true });
  mkdirSync(nativeBuild, { recursive: true });
  mkdirSync(rustTarget, { recursive: true });
  mkdirSync(cargoHome, { recursive: true });

  const common = [
    "-target", "armv7-apple-ios6.0", `-miphoneos-version-min=${DEPLOYMENT_TARGET}`,
    "-march=armv7", "-Os", "-fno-stack-protector", "-fno-builtin", "-fno-common",
    "-fwrapv", "-funsigned-char", "-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=0",
    "-isysroot", macosSdk,
  ];
  const compile = (source: string, output: string, extra: readonly string[] = []) =>
    mustRun(clang, [...common, ...extra, "-c", source, "-o", output]);
  const warnings = ["-Wall", "-Wextra", "-Werror", "-Wno-incompatible-sysroot"];
  compile(join(csu, "start.s"), join(nativeBuild, "csu-start.o"), ["-x", "assembler-with-cpp"]);
  compile(join(csu, "dyld_glue.s"), join(nativeBuild, "csu-dyld-glue.o"), [
    "-x", "assembler-with-cpp", "-DMACH_HEADER_SYMBOL_NAME=__mh_execute_header", "-DCRT",
  ]);

  const quickJsObjects: string[] = [];
  for (const source of ["quickjs.c", "cutils.c", "dtoa.c", "libregexp.c", "libunicode.c"]) {
    const output = join(nativeBuild, `quickjs-${source.replace(/\.c$/, "")}.o`);
    compile(join(quickjs, source), output, ["-I", quickjs, `-DCONFIG_VERSION=\"${IPHONE4S_TOOLCHAIN.compiler.quickJsVersion}\"`]);
    quickJsObjects.push(output);
  }

  const rustup = commandPath("rustup");
  if (!rustup) throw new Error("pocket iphone4s: rustup is unavailable");
  const cargo = mustRun(rustup, ["which", "--toolchain", IPHONE4S_TOOLCHAIN.compiler.rustToolchain, "cargo"]);
  const rustc = mustRun(rustup, ["which", "--toolchain", IPHONE4S_TOOLCHAIN.compiler.rustToolchain, "rustc"]);
  mustRun(
    cargo,
    ["build", "--release", "--locked", "--features", "bare-platform,gles1", "--target",
      join(REPOSITORY, "hosts/iphone4s/armv7-apple-ios.json"), "-Z", "json-target-spec",
      "-Z", "build-std=core,alloc,compiler_builtins", "-Z", "build-std-features=compiler-builtins-mem"],
    {
      cwd: join(REPOSITORY, "engine/ui-cabi"),
      env: { ...process.env, RUSTC: rustc, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: rustTarget, IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET },
    },
  );
  const rustLibrary = join(rustTarget, "armv7-apple-ios/release/libpocketjs_symbian_core.a");
  if (!existsSync(rustLibrary)) {
    throw new Error(`pocket iphone4s: missing Rust static library at ${rustLibrary}`);
  }

  const bundle = bundleDirectory();
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });
  cpSync(join(REPOSITORY, "hosts/iphone4s/Info.plist"), join(bundle, "Info.plist"));
  cpSync(join(REPOSITORY, "hosts/iphone4s/PkgInfo"), join(bundle, "PkgInfo"));
  await bakeClassicIPhoneArtwork(bundle);

  const firstParty = [
    ...warnings,
    `-DPOCKET_LOGICAL_WIDTH=${inputs.viewport.logical[0]}`,
    `-DPOCKET_LOGICAL_HEIGHT=${inputs.viewport.logical[1]}`,
    `-DPOCKET_RASTER_DENSITY=${inputs.viewport.rasterDensity}`,
  ];
  const crtGlobalsObject = join(nativeBuild, "crt_globals.o");
  const runtimeIdentityObject = join(nativeBuild, "runtime.build-id-input.o");
  const pocketRuntimeObject = join(nativeBuild, "pocket_runtime.o");
  const compatObject = join(nativeBuild, "compat.o");
  compile(join(REPOSITORY, "hosts/ios-legacy/crt_globals.c"), crtGlobalsObject, warnings);
  compile(join(REPOSITORY, "hosts/iphone4s/runtime.c"), runtimeIdentityObject, [
    ...firstParty,
    `-DPOCKET_BUILD_ID=\"${BUILD_ID_PLACEHOLDER}\"`,
    "-I", join(REPOSITORY, "engine/quickjs-c"),
    "-Wno-cast-function-type-mismatch",
  ]);
  compile(join(REPOSITORY, "engine/quickjs-c/pocket_runtime.c"), pocketRuntimeObject, [
    ...warnings,
    `-DPOCKETJS_TARGET_ID=\"${inputs.target}\"`,
    `-DPOCKETJS_HOST_ABI=${inputs.hostAbi}`,
    `-DPOCKET_RASTER_DENSITY=${inputs.viewport.rasterDensity}`,
    "-I", join(REPOSITORY, "engine/ui-cabi/include"),
    "-I", join(REPOSITORY, "contracts/generated"),
    "-isystem",
    quickjs,
  ]);
  compile(join(REPOSITORY, "hosts/ios-legacy/compat.c"), compatObject, warnings);

  const buildId = hashInputs([
    planPath(),
    guestJavaScript,
    guestPak,
    join(REPOSITORY, "hosts/iphone4s/Info.plist"),
    join(REPOSITORY, "hosts/iphone4s/PkgInfo"),
    join(REPOSITORY, "hosts/iphone2g/Icon.png"),
    join(REPOSITORY, "hosts/iphone4s/Icon.svg"),
    join(REPOSITORY, "tools/iphone-classic-icon.ts"),
    join(REPOSITORY, "tools/icon-raster.ts"),
    join(REPOSITORY, "tools/iphone4s.ts"),
    join(REPOSITORY, "tools/iphone4s-toolchain.ts"),
    join(REPOSITORY, "tools/cli/iphone4s-toolchain.json"),
    join(REPOSITORY, "hosts/iphone4s/armv7-apple-ios.json"),
    { label: "sysroot/UIKit.tbd", path: join(sysroot, "System/Library/Frameworks/UIKit.framework/UIKit.tbd") },
    { label: "sysroot/Foundation.tbd", path: join(sysroot, "System/Library/Frameworks/Foundation.framework/Foundation.tbd") },
    { label: "sysroot/CoreGraphics.tbd", path: join(sysroot, "System/Library/Frameworks/CoreGraphics.framework/CoreGraphics.tbd") },
    { label: "sysroot/OpenGLES.tbd", path: join(sysroot, "System/Library/Frameworks/OpenGLES.framework/OpenGLES.tbd") },
    { label: "sysroot/libSystem.tbd", path: join(sysroot, "usr/lib/libSystem.tbd") },
    { label: "sysroot/libobjc.tbd", path: join(sysroot, "usr/lib/libobjc.tbd") },
    { label: "sysroot/libgcc_s.1.tbd", path: join(sysroot, "usr/lib/libgcc_s.1.tbd") },
    { label: "native/csu-start.o", path: join(nativeBuild, "csu-start.o") },
    { label: "native/csu-dyld-glue.o", path: join(nativeBuild, "csu-dyld-glue.o") },
    { label: "native/crt_globals.o", path: crtGlobalsObject },
    { label: "native/runtime.build-id-input.o", path: runtimeIdentityObject },
    { label: "native/pocket_runtime.o", path: pocketRuntimeObject },
    { label: "native/compat.o", path: compatObject },
    ...quickJsObjects.map((path) => ({ label: `native/${path.slice(nativeBuild.length + 1)}`, path })),
    { label: "native/libpocketjs_symbian_core.a", path: rustLibrary },
    { label: `bundle/${IPHONE_CLASSIC_ICON_FILE}`, path: join(bundle, IPHONE_CLASSIC_ICON_FILE) },
    { label: `bundle/${IPHONE_CLASSIC_RETINA_ICON_FILE}`, path: join(bundle, IPHONE_CLASSIC_RETINA_ICON_FILE) },
    { label: "bundle/Default@2x.png", path: join(bundle, "Default@2x.png") },
    { label: "bundle/Default-568h@2x.png", path: join(bundle, "Default-568h@2x.png") },
  ]);

  const runtimeObject = join(nativeBuild, "runtime.o");
  compile(join(REPOSITORY, "hosts/iphone4s/runtime.c"), runtimeObject, [
    ...firstParty,
    `-DPOCKET_BUILD_ID=\"${buildId}\"`,
    "-I", join(REPOSITORY, "engine/quickjs-c"),
    "-Wno-cast-function-type-mismatch",
  ]);

  const embeddedJavaScript = join(nativeBuild, "app.js.bin");
  writeFileSync(embeddedJavaScript, Buffer.concat([readFileSync(guestJavaScript), Buffer.from([0])]));
  const executable = join(bundle, "PocketJSiPhone4S");
  mustRun(linker, ["-arch", "armv7", "-syslibroot", sysroot, "-L/usr/lib",
    "-F/System/Library/Frameworks", "-iphoneos_version_min", DEPLOYMENT_TARGET,
    "-no_pie", "-no_uuid", "-no_function_starts", "-no_data_in_code_info",
    "-no_source_version", "-no_compact_unwind", "-no_adhoc_codesign", "-no_encryption",
    "-e", "start", "-o", executable, join(nativeBuild, "csu-start.o"),
    join(nativeBuild, "csu-dyld-glue.o"), crtGlobalsObject,
    runtimeObject, pocketRuntimeObject, compatObject,
    "-force_load", rustLibrary, ...quickJsObjects,
    "-sectcreate", "__DATA", "__pocket_js", embeddedJavaScript,
    "-sectcreate", "__DATA", "__pocket_pak", guestPak,
    "-framework", "UIKit", "-framework", "Foundation", "-framework", "CoreGraphics",
    "-framework", "OpenGLES", "-lobjc", "-lSystem", "-lgcc_s.1"]);
  chmodSync(executable, 0o755);
  mustRun("ldid", ["-S", executable]);
  mustRun("plutil", ["-lint", join(bundle, "Info.plist")]);

  const fileInfo = mustRun("file", [executable]);
  if (!fileInfo.includes("Mach-O executable arm_v7")) throw new Error(`pocket iphone4s: unexpected binary: ${fileInfo}`);
  const loads = mustRun("xcrun", ["otool-classic", "-l", executable]);
  for (const marker of ["LC_VERSION_MIN_IPHONEOS", "version 6.0", "sectname __pocket_js", "sectname __pocket_pak", "LC_CODE_SIGNATURE"]) {
    if (!loads.includes(marker)) throw new Error(`pocket iphone4s: binary is missing ${marker}`);
  }

  const fileNames = [
    "PocketJSiPhone4S",
    "Info.plist",
    "PkgInfo",
    IPHONE_CLASSIC_ICON_FILE,
    IPHONE_CLASSIC_RETINA_ICON_FILE,
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
  console.log(fileInfo);
  console.log(`build_id=${buildId}`);
}

interface DeploymentPaths {
  readonly archive: string;
  readonly unpack: string;
  readonly stage: string;
  readonly backup: string;
  readonly lock: string;
}

export function iphone4sDeploymentPaths(transactionId: string): DeploymentPaths {
  if (!/^[0-9a-f]{24}$/.test(transactionId)) {
    throw new Error("pocket iphone4s: deployment transaction id must be 24 lowercase hex digits");
  }
  return {
    archive: `/private/var/tmp/pocketjs-iphone4s-${transactionId}.app.tar`,
    unpack: `/Applications/.PocketJSiPhone4S.app.pocketjs-unpack-${transactionId}`,
    stage: `/Applications/.PocketJSiPhone4S.app.pocketjs-stage-${transactionId}`,
    backup: `/Applications/.PocketJSiPhone4S.app.pocketjs-backup-${transactionId}`,
    lock: "/private/var/tmp/pocketjs-iphone4s.deploy.lock",
  };
}

function assertDeploymentLease(nowEpochSeconds: number, expiresEpochSeconds: number): void {
  if (
    !Number.isSafeInteger(nowEpochSeconds) ||
    !Number.isSafeInteger(expiresEpochSeconds) ||
    nowEpochSeconds < 0 ||
    expiresEpochSeconds <= nowEpochSeconds
  ) {
    throw new Error("pocket iphone4s: deployment lease must be a future integer epoch");
  }
}

export function deploymentAcquireLockCommand(
  transactionId: string,
  paths: DeploymentPaths,
  nowEpochSeconds: number,
  expiresEpochSeconds: number,
): string {
  if (!/^[0-9a-f]{24}$/.test(transactionId)) {
    throw new Error("pocket iphone4s: deployment transaction id must be 24 lowercase hex digits");
  }
  assertDeploymentLease(nowEpochSeconds, expiresEpochSeconds);
  return (
    "set -eu; " +
    `lock=${paths.lock}; tx=${transactionId}; now=${nowEpochSeconds}; expires=${expiresEpochSeconds}; ` +
    `dest=${INSTALL_PATH}; ` +
    "if ! mkdir \"$lock\" 2>/dev/null; then " +
    "owner=$(cat \"$lock/owner\" 2>/dev/null || true); " +
    "lease=$(cat \"$lock/expires\" 2>/dev/null || true); " +
    "case \"$lease\" in ''|*[!0-9]*) sleep 1; owner=$(cat \"$lock/owner\" 2>/dev/null || true); " +
    "lease=$(cat \"$lock/expires\" 2>/dev/null || true) ;; esac; active=0; " +
    "case \"$lease\" in ''|*[!0-9]*) ;; *) [ \"$lease\" -gt \"$now\" ] && active=1 || true ;; esac; " +
    "if [ \"$active\" -eq 1 ]; then echo \"deployment busy (owner ${owner:-unknown}, lease $lease)\" >&2; exit 73; fi; " +
    "reclaim=$lock/reclaim; " +
    "if ! mkdir \"$reclaim\" 2>/dev/null; then " +
    "reclaim_lease=$(cat \"$reclaim/expires\" 2>/dev/null || true); " +
    "case \"$reclaim_lease\" in ''|*[!0-9]*) sleep 1; " +
    "reclaim_lease=$(cat \"$reclaim/expires\" 2>/dev/null || true) ;; esac; reclaim_active=0; " +
    "case \"$reclaim_lease\" in ''|*[!0-9]*) ;; *) [ \"$reclaim_lease\" -gt \"$now\" ] && reclaim_active=1 || true ;; esac; " +
    "if [ \"$reclaim_active\" -eq 1 ]; then echo \"deployment recovery busy\" >&2; exit 73; fi; " +
    "expired_reclaim=$lock/reclaim-expired-$tx; " +
    "if ! mv \"$reclaim\" \"$expired_reclaim\" 2>/dev/null; then echo \"deployment recovery busy\" >&2; exit 73; fi; " +
    "if ! mkdir \"$reclaim\" 2>/dev/null; then rm -rf \"$expired_reclaim\"; echo \"deployment recovery busy\" >&2; exit 73; fi; " +
    "rm -rf \"$expired_reclaim\"; fi; " +
    "printf '%s\\n' \"$tx\" > \"$reclaim/owner\"; printf '%s\\n' \"$expires\" > \"$reclaim/expires\"; " +
    "trap 'status=$?; set +e; test -f \"$reclaim/owner\" && test \"$(cat \"$reclaim/owner\")\" = \"$tx\" && rm -rf \"$reclaim\"; exit \"$status\"' EXIT HUP INT TERM; " +
    "lease=$(cat \"$lock/expires\" 2>/dev/null || true); active=0; " +
    "case \"$lease\" in ''|*[!0-9]*) ;; *) [ \"$lease\" -gt \"$now\" ] && active=1 || true ;; esac; " +
    "if [ \"$active\" -eq 1 ]; then echo \"deployment busy (lease $lease)\" >&2; exit 73; fi; " +
    "valid_owner=0; case \"$owner\" in " +
    "????????????????????????) case \"$owner\" in *[!0-9a-f]*) ;; *) valid_owner=1 ;; esac ;; esac; " +
    "if [ \"$valid_owner\" -eq 1 ]; then " +
    "backup=/Applications/.PocketJSiPhone4S.app.pocketjs-backup-${owner}; " +
    "stage=/Applications/.PocketJSiPhone4S.app.pocketjs-stage-${owner}; " +
    "unpack=/Applications/.PocketJSiPhone4S.app.pocketjs-unpack-${owner}; " +
    "archive=/private/var/tmp/pocketjs-iphone4s-${owner}.app.tar; " +
    "phase=$(cat \"$lock/phase\" 2>/dev/null || true); origin=$(cat \"$lock/origin\" 2>/dev/null || true); " +
    "if [ \"$phase\" = committed ]; then rm -rf \"$backup\"; " +
    "elif [ -e \"$backup\" ]; then rm -rf \"$dest\"; mv \"$backup\" \"$dest\"; " +
    "chown -R root:wheel \"$dest\"; chmod 755 \"$dest/PocketJSiPhone4S\"; " +
    "elif [ \"$origin\" = empty ]; then rm -rf \"$dest\"; fi; " +
    "rm -rf \"$stage\" \"$unpack\" \"$archive\"; fi; " +
    "rm -f \"$lock/phase\" \"$lock/origin\"; " +
    "printf '%s\\n' \"$tx\" > \"$lock/owner\"; printf '%s\\n' \"$expires\" > \"$lock/expires\"; " +
    "rm -rf \"$reclaim\"; trap - EXIT HUP INT TERM; " +
    "else printf '%s\\n' \"$tx\" > \"$lock/owner\"; printf '%s\\n' \"$expires\" > \"$lock/expires\"; fi"
  );
}

export function deploymentRenewLockCommand(
  transactionId: string,
  paths: DeploymentPaths,
  expiresEpochSeconds: number,
): string {
  if (!/^[0-9a-f]{24}$/.test(transactionId) || !Number.isSafeInteger(expiresEpochSeconds)) {
    throw new Error("pocket iphone4s: invalid deployment lease renewal");
  }
  return (
    "set -eu; " +
    `lock=${paths.lock}; tx=${transactionId}; expires=${expiresEpochSeconds}; ` +
    "test -f \"$lock/owner\"; test \"$(cat \"$lock/owner\")\" = \"$tx\"; " +
    "printf '%s\\n' \"$expires\" > \"$lock/expires\""
  );
}

export function deploymentInstallCommand(transactionId: string, paths: DeploymentPaths): string {
  return (
    "set -eu; " +
    `dest=${INSTALL_PATH}; stage=${paths.stage}; backup=${paths.backup}; lock=${paths.lock}; ` +
    "had_previous=0; installed_new=0; " +
    "rollback() { status=$?; trap - EXIT HUP INT TERM; set +e; " +
    "if [ \"$installed_new\" -eq 1 ]; then rm -rf \"$dest\"; fi; " +
    "if [ \"$had_previous\" -eq 1 ] && [ -e \"$backup\" ]; then " +
    "mv \"$backup\" \"$dest\"; " +
    "chown -R root:wheel \"$dest\"; chmod 755 \"$dest/PocketJSiPhone4S\"; " +
    "/bin/su mobile -c /usr/bin/uicache; fi; exit \"$status\"; }; " +
    "trap rollback EXIT HUP INT TERM; " +
    "printf '%s\\n' prepared > \"$lock/phase\"; " +
    "if [ -e \"$dest\" ]; then printf '%s\\n' previous > \"$lock/origin\"; " +
    "mv \"$dest\" \"$backup\"; had_previous=1; " +
    "else printf '%s\\n' empty > \"$lock/origin\"; fi; " +
    "mv \"$stage\" \"$dest\"; installed_new=1; printf '%s\\n' installed > \"$lock/phase\"; " +
    "chown -R root:wheel \"$dest\"; " +
    "chmod 755 \"$dest/PocketJSiPhone4S\"; test -x \"$dest/PocketJSiPhone4S\"; " +
    "/usr/bin/ldid -e \"$dest/PocketJSiPhone4S\" >/dev/null; " +
    "/bin/su mobile -c /usr/bin/uicache; printf '%s\\n' committed > \"$lock/phase\"; " +
    "trap - EXIT HUP INT TERM; " +
    "rm -rf \"$backup\"; " +
    `echo installed-${transactionId}`
  );
}

async function deploy(): Promise<void> {
  await build();
  const receipt = readReceipt();
  const transactionId = randomBytes(12).toString("hex");
  const paths = iphone4sDeploymentPaths(transactionId);
  const archive = join(REPOSITORY, `.pocket-build/iphone4s/PocketJSiPhone4S.app-${transactionId}.tar`);
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
        "-o",
        `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`,
        "-o",
        "HostKeyAlgorithms=+ssh-rsa",
        "-o",
        "PubkeyAcceptedAlgorithms=+ssh-rsa",
        archive,
        `root@127.0.0.1:${paths.archive}`,
      ]);

      let lockHeld = false;
      let operationError: unknown;
      try {
        const acquireTime = Math.floor(Date.now() / 1000);
        mustRemote(port, deploymentAcquireLockCommand(
          transactionId,
          paths,
          acquireTime,
          acquireTime + DEPLOYMENT_LEASE_SECONDS,
        ));
        lockHeld = true;
        mustRemote(
          port,
          "set -eu; " +
            `stage=${paths.stage}; unpack=${paths.unpack}; archive=${paths.archive}; ` +
            "rm -rf \"$stage\" \"$unpack\"; mkdir -p \"$unpack\"; " +
            "tar -xf \"$archive\" -C \"$unpack\"; " +
            "test -d \"$unpack/PocketJSiPhone4S.app\"; " +
            "mv \"$unpack/PocketJSiPhone4S.app\" \"$stage\"; rmdir \"$unpack\"; " +
            "test -x \"$stage/PocketJSiPhone4S\"; " +
            "/usr/bin/ldid -e \"$stage/PocketJSiPhone4S\" >/dev/null",
        );
        mustRemote(port, deploymentRenewLockCommand(
          transactionId,
          paths,
          Math.floor(Date.now() / 1000) + DEPLOYMENT_LEASE_SECONDS,
        ));
        const expectedFiles = { ...receipt.files, "build-receipt.json": sha256(receiptPath()) };
        const fileNames = Object.keys(expectedFiles);
        if (fileNames.some((name) => !/^[A-Za-z0-9@._-]+$/.test(name))) {
          throw new Error("pocket iphone4s: receipt contains an unsafe bundle file name");
        }
        const hashes = mustRemote(port,
          `cd ${paths.stage} && for file in ${fileNames.join(" ")}; do /usr/bin/openssl dgst -sha256 \"$file\"; done`);
        const remoteFiles = new Map(
          hashes.split("\n").map((line) => {
            const match = line.match(/^SHA256\((.+)\)= ([0-9a-f]{64})$/);
            if (!match) throw new Error(`pocket iphone4s: malformed device hash line: ${line}`);
            return [match[1], match[2]];
          }),
        );
        for (const [name, expected] of Object.entries(expectedFiles)) {
          if (remoteFiles.get(name) !== expected) {
            throw new Error(`pocket iphone4s: device readback mismatch for ${name}`);
          }
        }
        mustRemote(port, deploymentRenewLockCommand(
          transactionId,
          paths,
          Math.floor(Date.now() / 1000) + DEPLOYMENT_LEASE_SECONDS,
        ));
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
            `pocket iphone4s: deployment cleanup failed (${cleanup.exitCode}):\n${cleanup.stderr.trim()}`,
          );
        }
      }
    });
  } finally {
    rmSync(archive, { force: true });
  }
  console.log(`deployed ${receipt.buildId} to ${INSTALL_PATH} with byte-exact readback`);
}

function verifyInstalledReceipt(port: number, receipt: BuildReceipt): void {
  const installed = mustRemote(port, `cat ${INSTALL_PATH}/build-receipt.json`);
  const installedReceipt = JSON.parse(installed) as BuildReceipt;
  if (!buildReceiptsMatch(installedReceipt, receipt)) {
    throw new Error(
      `pocket iphone4s: installed receipt does not match local build ${receipt.buildId}`,
    );
  }
}

async function launch(): Promise<void> {
  const receipt = readReceipt();
  await withTunnel(async (port) => {
    verifyInstalledReceipt(port, receipt);
    mustRemote(
      port,
      `killall PocketJSiPhone4S 2>/dev/null || true; rm -f ${STATUS_PATH} ${FRAME_PATH}; ` +
        "/bin/su mobile -c '/usr/bin/uiopen pocketjs-iphone4s://launch'; echo launch-requested",
    );
    await Bun.sleep(2500);
  });
  await status(false);
}

async function readDeviceStatus(port: number): Promise<DeviceStatus> {
  const raw = mustRemote(port, `cat ${STATUS_PATH}`);
  const values = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const number = (key: string): number => {
    const value = Number(values.get(key));
    if (!Number.isFinite(value)) throw new Error(`pocket iphone4s: malformed status field ${key}`);
    return value;
  };
  return {
    schema: number("schema"),
    build_id: values.get("build_id") ?? "",
    state: values.get("state") ?? "",
    pid: number("pid"),
    written_at: number("written_at"),
    heartbeat: number("heartbeat"),
    guest_frames: number("guest_frames"),
    completed_touch_sequences: number("completed_touch_sequences"),
    action_name: values.get("action_name") ?? "",
    action_value: number("action_value"),
    action_sequence: number("action_sequence"),
    renderer: values.get("renderer") ?? "",
    clock: values.get("clock") ?? "",
    raster_density: number("raster_density"),
    drawable_width: number("drawable_width"),
    drawable_height: number("drawable_height"),
    error: values.get("error") ?? "",
  };
}

async function status(requireAction: boolean): Promise<void> {
  const receipt = readReceipt();
  await withTunnel(async (port) => {
    verifyInstalledReceipt(port, receipt);
    const first = await readDeviceStatus(port);
    await Bun.sleep(1200);
    const current = await readDeviceStatus(port);
    if (current.schema !== 2) {
      throw new Error("pocket iphone4s: malformed device status identity");
    }
    if (current.build_id !== receipt.buildId) {
      throw new Error(
        `pocket iphone4s: status build ${current.build_id} does not match local ${receipt.buildId}`,
      );
    }
    if (current.state !== "running" || current.error !== "") {
      throw new Error(`pocket iphone4s: guest state=${current.state} error=${current.error || "none"}`);
    }
    if (
      current.renderer !== "gles1" ||
      current.raster_density !== IPHONE4S_RASTER_DENSITY ||
      current.drawable_width !== IPHONE4S_PHYSICAL_VIEWPORT[0] ||
      current.drawable_height !== IPHONE4S_PHYSICAL_VIEWPORT[1]
    ) {
      throw new Error(
        `pocket iphone4s: expected GLES1 Retina ${IPHONE4S_PHYSICAL_VIEWPORT.join("x")}, got ` +
          `${current.renderer} ${current.drawable_width}x${current.drawable_height} @${current.raster_density}x`,
      );
    }
    if (current.guest_frames <= first.guest_frames) {
      throw new Error("pocket iphone4s: guest frame counter did not advance");
    }
    if (current.heartbeat <= first.heartbeat) throw new Error("pocket iphone4s: status heartbeat did not advance");
    mustRemote(port, `kill -0 ${current.pid}`);
    if (
      requireAction &&
      (current.completed_touch_sequences < 1 ||
        current.action_name !== "hero_tap" ||
        current.action_value < 1 ||
        current.action_sequence < 1)
    ) {
      throw new Error("pocket iphone4s: no completed Hero touch/action receipt yet");
    }
    console.log(JSON.stringify(current, null, 2));
  });
}

async function capture(): Promise<void> {
  const rawDestination = join(REPOSITORY, "dist/iphone4s/device-frame.rgba");
  const destination = join(REPOSITORY, "dist/iphone4s/device-frame.png");
  rmSync(rawDestination, { force: true });
  rmSync(destination, { force: true });
  let renderer = "";
  let width = 0;
  let height = 0;
  await withTunnel(async (port) => {
    try {
      const status = await readDeviceStatus(port);
      renderer = status.renderer;
      width = status.drawable_width;
      height = status.drawable_height;
      if (
        renderer !== "gles1" ||
        width !== IPHONE4S_PHYSICAL_VIEWPORT[0] ||
        height !== IPHONE4S_PHYSICAL_VIEWPORT[1] ||
        status.raster_density !== IPHONE4S_RASTER_DENSITY
      ) {
        throw new Error(`pocket iphone4s: refusing non-Retina capture ${renderer} ${width}x${height}`);
      }
      mustRemote(
        port,
        `rm -f ${FRAME_PATH} ${CAPTURE_REQUEST_PATH}; ` +
          `/bin/su mobile -c 'touch ${CAPTURE_REQUEST_PATH}'`,
      );
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await Bun.sleep(200);
        if (remote(port, `test -s ${FRAME_PATH}`).exitCode === 0) break;
      }
      mustRemote(port, `test -s ${FRAME_PATH}`);
      const frame = runBinary("ssh", sshArgs(port, `cat ${FRAME_PATH}`));
      if (frame.exitCode !== 0) {
        throw new Error(`pocket iphone4s: device frame download failed (${frame.exitCode}):\n${frame.stderr.trim()}`);
      }
      writeFileSync(rawDestination, frame.stdout);
    } finally {
      remote(port, `rm -f ${CAPTURE_REQUEST_PATH} ${FRAME_PATH}`);
    }
  });
  const raw = readFileSync(rawDestination);
  if (raw.byteLength !== width * height * 4) throw new Error(`pocket iphone4s: capture has ${raw.byteLength} bytes`);
  const canvas = createCanvas(width, height);
  const image = canvas.getContext("2d").createImageData(width, height);
  const gl = renderer === "gles1";
  for (let y = 0; y < height; y += 1) {
    const sourceY = gl ? height - 1 - y : y;
    for (let x = 0; x < width; x += 1) {
      const source = (sourceY * width + x) * 4;
      const target = (y * width + x) * 4;
      image.data[target] = gl ? raw[source] : raw[source + 2];
      image.data[target + 1] = raw[source + 1];
      image.data[target + 2] = gl ? raw[source + 2] : raw[source];
      image.data[target + 3] = raw[source + 3];
    }
  }
  canvas.getContext("2d").putImageData(image, 0, 0);
  writeFileSync(destination, canvas.toBuffer("image/png"));
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
  console.log(`PocketJS iPhone 4S 6 tool

  bun iphone4s doctor
  bun iphone4s setup-sources
  bun iphone4s prepare-sysroot
  bun iphone4s build
  bun iphone4s deploy
  bun iphone4s launch
  bun iphone4s status [--require-action]
  bun iphone4s capture
  bun iphone4s tunnel`);
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const command = args[0] ?? "doctor";
  switch (command) {
    case "doctor":
      await doctor();
      break;
    case "setup-sources":
      setupSources();
      break;
    case "prepare-sysroot":
      prepareSysroot();
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
      throw new Error(`pocket iphone4s: unknown command ${command}`);
  }
}

if (import.meta.main) {
  await main();
}
