import { createHash, randomBytes } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import {
  bakeClassicIPhoneArtwork,
  IPHONE_USER_ICON_FILE,
  IPHONE_USER_RETINA_ICON_FILE,
} from "./iphone-classic-icon.ts";
import {
  IPODTOUCH4_DEPLOYMENT,
  IPODTOUCH4_DEVICE,
  IPODTOUCH4_TOOLCHAIN,
  inspectIPodTouch4Toolchain,
  ipodtouch4CacheRoot,
  ipodtouch4CsuPath,
  ipodtouch4QuickJsPath,
  ipodtouch4SysrootPath,
} from "./ipodtouch4-toolchain.ts";
import {
  IPODTOUCH4_DEV_TARGET_ID,
  IPODTOUCH4_PHYSICAL_VIEWPORT,
  IPODTOUCH4_RASTER_DENSITY,
  resolveIPodTouch4BuildPlan,
} from "./ipodtouch4-profile.ts";

import {
  IPOD_INSTALLER, ipodAppReceiptPaths, parseInstalledIPodApp, shellQuote, userDeploymentScript,
} from "./ipodtouch4-installation.ts";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const DEVICE_TYPE = IPODTOUCH4_DEVICE.productType;
const DEVICE_HARDWARE = IPODTOUCH4_DEVICE.hardwareModel;
const DEVICE_VERSION = IPODTOUCH4_DEVICE.productVersion;
const DEVICE_BUILD = IPODTOUCH4_DEVICE.buildVersion;
const DEVICE_PORT = IPODTOUCH4_DEPLOYMENT.devicePort;
const LOCAL_PORT = Number(
  process.env.POCKETJS_IPODTOUCH4_PORT ?? String(IPODTOUCH4_DEPLOYMENT.localPort),
);
const KEY_PATH =
  process.env.POCKETJS_IPODTOUCH4_KEY ?? join(ipodtouch4CacheRoot(), "ssh/id_rsa");
const KNOWN_HOSTS_PATH =
  process.env.POCKETJS_IPODTOUCH4_KNOWN_HOSTS ?? join(ipodtouch4CacheRoot(), "ssh/known_hosts");
const DEPLOYMENT_TARGET = IPODTOUCH4_TOOLCHAIN.compiler.minimumVersion;
/** The app-side acceptance receipt: the Clear guest reports completed gesture
 *  interactions (complete / delete / create / reorder) under this name. */
const ACTION_NAME = "clear_gesture";

/**
 * One installable app on the iPod. Two apps coexist on the device only if
 * every device-side name differs: the bundle, its executable, the URL scheme
 * SpringBoard launches it by, and the URL scheme. Runtime receipts live inside the app's own container.
 */
export interface IPodTouch4App {
  readonly id: string;
  /** pocket.json, relative to `root`. */
  readonly manifest: string;
  /**
   * The project the app's sources live in. Absent for an app inside this
   * repository; set for an EXTERNAL one, whose descriptor is read from a
   * file (see selectIPodTouch4App) and whose build runs with
   * `--project-root` pointed here — the same out-of-tree shape the 3DS
   * pipeline uses.
   */
  readonly root?: string;
  readonly bundleId: string;
  readonly bundleName: string;
  readonly executable: string;
  readonly title: string;
  /** SpringBoard URL scheme; `<scheme>://launch` opens the app. */
  readonly scheme: string;
  /** Artifact/receipt label retained for external app descriptors. */
  readonly receiptSlug: string;
  /** The `__reportAppAction` name `status --require-action` waits for. */
  readonly actionName: string;
  /** Compile hosts/ios-legacy/svcwire.c and expose spec ops 30..32: the app's
   *  companion process lives on the LAN (svcwire.h). */
  readonly svcWire: boolean;
  /** Disable iOS's idle timer while the app runs (a remote must not auto-lock). */
  readonly keepAwake: boolean;
}

/** The fields an external app's descriptor file must carry. */
const EXTERNAL_FIELDS = [
  "id",
  "manifest",
  "bundleId",
  "bundleName",
  "executable",
  "title",
  "scheme",
  "receiptSlug",
  "actionName",
] as const;

export const IPODTOUCH4_APPS: Readonly<Record<string, IPodTouch4App>> = {
  clear: {
    id: "clear",
    manifest: "apps/clear/pocket.json",
    bundleId: "dev.pocket-stack.clear",
    bundleName: "PocketJSiPodTouch4.app",
    executable: "PocketJSiPodTouch4",
    title: "Pocket Clear",
    scheme: "pocketjs-ipodtouch4",
    receiptSlug: "pocketjs-ipodtouch4",
    actionName: ACTION_NAME,
    svcWire: false,
    keepAwake: true,
  },
};

/**
 * Read an app that lives in another project: a JSON descriptor beside its
 * sources carrying the fields above, plus an optional `projectRoot`
 * (relative to the descriptor, default its own directory) that `manifest`
 * and the manifest's own entry are resolved against. The guest then builds
 * with `--project-root` set to it, so a product repository can own its app
 * and its history while the toolchain, the host and the deployment
 * transaction stay here.
 */
export function readExternalIPodTouch4App(descriptorPath: string): IPodTouch4App {
  const file = resolvePath(descriptorPath);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const field of EXTERNAL_FIELDS) {
    if (typeof parsed[field] !== "string" || (parsed[field] as string).trim() === "") {
      throw new Error(`pocket ipodtouch4: ${file} is missing a string ${field}`);
    }
  }
  // The project root is where the app's own manifest paths start from — the
  // product repository, not necessarily the descriptor's directory.
  const root = resolvePath(dirname(file), typeof parsed.projectRoot === "string" ? parsed.projectRoot : ".");
  const manifest = parsed.manifest as string;
  if (!existsSync(join(root, manifest))) {
    throw new Error(`pocket ipodtouch4: ${file} names a manifest that is not there: ${join(root, manifest)}`);
  }
  return {
    id: parsed.id as string,
    root,
    manifest,
    bundleId: parsed.bundleId as string,
    bundleName: parsed.bundleName as string,
    executable: parsed.executable as string,
    title: parsed.title as string,
    scheme: parsed.scheme as string,
    receiptSlug: parsed.receiptSlug as string,
    actionName: parsed.actionName as string,
    svcWire: parsed.svcWire === true,
    keepAwake: parsed.keepAwake === true,
  };
}

export function selectIPodTouch4App(name: string | undefined, descriptor?: string): IPodTouch4App {
  if (descriptor?.trim()) return readExternalIPodTouch4App(descriptor.trim());
  const key = name?.trim() || "clear";
  const app = IPODTOUCH4_APPS[key];
  if (!app) {
    throw new Error(
      `pocket ipodtouch4: unknown app ${JSON.stringify(key)}; POCKETJS_IPODTOUCH4_APP must be one of ` +
        `${Object.keys(IPODTOUCH4_APPS).join(", ")}, or POCKETJS_IPODTOUCH4_APP_FILE must name an external app's descriptor`,
    );
  }
  return app;
}

const APP = selectIPodTouch4App(process.env.POCKETJS_IPODTOUCH4_APP, process.env.POCKETJS_IPODTOUCH4_APP_FILE);
/** Where the app's own sources live: this repository, or another project. */
const APP_ROOT = APP.root ?? REPOSITORY;
/**
 * The machine the iPod is plugged into, when it is not this one: an ssh host
 * (alias) with usbmuxd + libimobiledevice. Device discovery and the iproxy
 * tunnel then run there, and every ssh/scp to the device jumps through it
 * (ProxyJump), so keys and the pinned host key stay on this Mac.
 */
const VIA = process.env.POCKETJS_IPODTOUCH4_VIA?.trim() || null;
/** The tunnel's port on the jump host (fixed: nothing else there uses it). */
const VIA_TUNNEL_PORT = 22224;
const BUNDLE_NAME = APP.bundleName;
const BUNDLE_ID = APP.bundleId;
const EXECUTABLE = APP.executable;

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
  /** The plan's presented surface; absent in receipts written before the
   *  landscape viewport existed (those are the portrait Clear build). */
  readonly viewport?: {
    readonly logical: readonly [number, number];
    readonly physical: readonly [number, number];
    readonly rasterDensity: number;
  };
}

/** The drawable `status`/`capture` must see, from the receipt when it says. */
function expectedDrawable(receipt: BuildReceipt): { physical: readonly [number, number]; rasterDensity: number } {
  return receipt.viewport
    ? { physical: receipt.viewport.physical, rasterDensity: receipt.viewport.rasterDensity }
    : { physical: IPODTOUCH4_PHYSICAL_VIEWPORT, rasterDensity: IPODTOUCH4_RASTER_DENSITY };
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
      `pocket ipodtouch4: ${executable} ${args.join(" ")} failed (${result.exitCode})${
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
  return join(APP_ROOT, APP.manifest);
}

function planPath(): string {
  return join(REPOSITORY, `.pocket/ipodtouch4/${APP.id}.plan.json`);
}

function guestDirectory(): string {
  return join(REPOSITORY, `dist/ipodtouch4/${APP.id}/guest`);
}

/**
 * hosts/ipodtouch4/Info.plist is written for Pocket Clear; every other app
 * takes the same plist with its own identity substituted. For Clear the
 * substitution is the identity, so its bundle stays byte-identical.
 */
function renderInfoPlist(): string {
  const clear = IPODTOUCH4_APPS.clear;
  const source = readFileSync(join(REPOSITORY, "hosts/ipodtouch4/Info.plist"), "utf8");
  return source
    .replaceAll(`<string>${clear.bundleId}.launch</string>`, `<string>${APP.bundleId}.launch</string>`)
    .replaceAll(`<string>${clear.bundleId}</string>`, `<string>${APP.bundleId}</string>`)
    .replaceAll(`<string>${clear.title}</string>`, `<string>${APP.title}</string>`)
    .replaceAll(`<string>${clear.executable}</string>`, `<string>${APP.executable}</string>`)
    .replaceAll(`<string>${clear.scheme}</string>`, `<string>${APP.scheme}</string>`);
}

function bundleDirectory(): string {
  return join(REPOSITORY, `dist/ipodtouch4/${BUNDLE_NAME}`);
}

function receiptPath(): string {
  return join(bundleDirectory(), "build-receipt.json");
}

function readReceipt(): BuildReceipt {
  if (!existsSync(receiptPath())) {
    throw new Error("pocket ipodtouch4: no built bundle; run `bun ipodtouch4 build`");
  }
  return JSON.parse(readFileSync(receiptPath(), "utf8")) as BuildReceipt;
}

/** Run a libimobiledevice command where the device is: here, or on VIA. */
function usbRun(command: string, args: readonly string[]): string {
  if (!VIA) return mustRun(command, args);
  return mustRun("ssh", ["-o", "BatchMode=yes", VIA, [command, ...args].map(shellQuote).join(" ")]);
}

function deviceUdid(): string {
  const requested = process.env.POCKETJS_IPODTOUCH4_UDID?.trim();
  if (requested) return requested;
  const ids = usbRun("idevice_id", ["-l"])
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length !== 1) {
    throw new Error(
      `pocket ipodtouch4: expected exactly one paired USB device, found ${ids.length}; set POCKETJS_IPODTOUCH4_UDID`,
    );
  }
  return ids[0];
}

function deviceValue(udid: string, key: string): string {
  return usbRun("ideviceinfo", ["-u", udid, "-k", key]);
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
      `pocket ipodtouch4: refusing device ${observed.type}/${observed.hardware} ${observed.version} (${observed.build}) ` +
        `activation=${observed.activation}; expected ${DEVICE_TYPE}/${DEVICE_HARDWARE} ` +
        `${DEVICE_VERSION} (${DEVICE_BUILD}) Activated`,
    );
  }
  return udid;
}

/** ssh/scp options that route through the jump host when the device is there. */
function viaArgs(): string[] {
  return VIA ? ["-o", `ProxyJump=${VIA}`] : [];
}

function sshArgs(port: number, command: string): string[] {
  return [
    ...viaArgs(),
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
      `pocket ipodtouch4: device command failed (${result.exitCode}):\n${
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
        reject(new Error("pocket ipodtouch4: could not allocate a loopback port"));
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
  const port = VIA ? VIA_TUNNEL_PORT : await availableLocalPort();
  // On a jump host the forwarder runs there; -tt gives it a pty so it dies
  // with this ssh instead of lingering when the tunnel is torn down.
  const tunnel = Bun.spawn({
    cmd: VIA
      ? ["ssh", "-tt", "-o", "BatchMode=yes", VIA, `exec iproxy -u ${udid} ${port}:${DEVICE_PORT}`]
      : ["iproxy", "-u", udid, `${port}:${DEVICE_PORT}`],
    cwd: REPOSITORY,
    stdin: "ignore",
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
    throw new Error(`pocket ipodtouch4: USB SSH tunnel${VIA ? ` via ${VIA}` : ""} did not become ready${stderr ? `:\n${stderr}` : ""}`);
  } finally {
    if (tunnel.exitCode === null) {
      tunnel.kill();
      await tunnel.exited;
    }
  }
}

async function doctor(): Promise<void> {
  let ok = true;
  const usbTools = ["idevice_id", "ideviceinfo", "iproxy"];
  const required = ["bun", "rustup", "xcrun", "ldid", ...(VIA ? [] : usbTools), "ssh", "scp", "zip", "unzip", "hdiutil"];
  for (const name of required) {
    const path = commandPath(name);
    ok = check(name, path !== undefined, path ?? "not found") && ok;
  }
  if (VIA) {
    for (const name of usbTools) {
      const found = run("ssh", ["-o", "BatchMode=yes", VIA, `command -v ${name}`]);
      ok = check(`${name} on ${VIA}`, found.exitCode === 0, found.exitCode === 0 ? found.stdout.trim() : `not found on ${VIA} (pacman -S usbmuxd libimobiledevice)`) && ok;
    }
    const muxd = run("ssh", ["-o", "BatchMode=yes", VIA, "test -S /var/run/usbmuxd && echo socket"]);
    ok = check(`usbmuxd on ${VIA}`, muxd.exitCode === 0, muxd.exitCode === 0 ? "/var/run/usbmuxd" : `no /var/run/usbmuxd on ${VIA} (the usbmuxd package starts it on plug-in)`) && ok;
  }
  const toolchain = inspectIPodTouch4Toolchain();
  ok = check(
    "validated iOS 6.1.3 ARMv7 sysroot (shared with iphone4s)",
    toolchain.sysroot,
    ipodtouch4SysrootPath(),
  ) && ok;
  ok = check("Apple Csu source", toolchain.csu, ipodtouch4CsuPath()) && ok;
  ok = check("pinned QuickJS source", toolchain.quickjs, ipodtouch4QuickJsPath()) && ok;
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
      "set -eu; test \"$(uname -m)\" = iPod4,1; test -x /usr/bin/ldid; test -x /usr/bin/uicache; test -x /usr/bin/uiopen; test -w /var/mobile/Applications; " +
        "/usr/sbin/sshd -T | grep -q '^pubkeyauthentication yes$'; " +
        "/usr/sbin/sshd -T | grep -q '^passwordauthentication no$'; echo jailbreak-key-only-usb-ready",
    );
    console.log(`[ok] jailbreak transport: ${remoteInfo}`);
    const appSync = remote(port, "dpkg-query -W -f='${Status}' ai.akemi.appsyncunified");
    ok = check("self-signed User app installation (AppSync Unified)",
      appSync.exitCode === 0 && appSync.stdout.trim() === "install ok installed",
      "install AppSync Unified from its upstream release, then reboot once") && ok;
    if (!ok) process.exitCode = 1;
  });
}

/**
 * The toolchain (Csu, QuickJS, dyld extractor, ARMv7 sysroot) is the iPhone
 * 4S one, byte for byte; preparation lives there so its provenance is pinned
 * exactly once. These delegations keep `bun ipodtouch4 <command>` complete.
 */
function delegateToIPhone4S(command: string): void {
  mustRun("bun", ["tools/iphone4s.ts", command]);
}

async function build(): Promise<void> {
  const toolchain = inspectIPodTouch4Toolchain();
  if (!toolchain.csu || !toolchain.quickjs) {
    throw new Error("pocket ipodtouch4: pinned sources are absent; run `bun ipodtouch4 setup-sources`");
  }
  if (!toolchain.sysroot) {
    throw new Error("pocket ipodtouch4: validated iOS 6.1.3 sysroot is absent; run `bun ipodtouch4 prepare-sysroot`");
  }
  const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
  const plan = resolveIPodTouch4BuildPlan(manifest);
  mkdirSync(dirname(planPath()), { recursive: true });
  writeFileSync(planPath(), JSON.stringify(plan, null, 2) + "\n");
  const inputs = extractHostBuildInputs(plan, { expectedTarget: IPODTOUCH4_DEV_TARGET_ID });

  rmSync(guestDirectory(), { recursive: true, force: true });
  mkdirSync(guestDirectory(), { recursive: true });
  mustRun("bun", [
    "tools/build.ts",
    `--plan=${planPath()}`,
    `--project-root=${APP_ROOT}`,
    `--outdir=${guestDirectory()}`,
  ]);
  const guestJavaScript = join(guestDirectory(), `${inputs.appOutput}.js`);
  const guestPak = join(guestDirectory(), `${inputs.appOutput}.pak`);
  if (!existsSync(guestJavaScript) || !existsSync(guestPak)) {
    throw new Error("pocket ipodtouch4: guest build did not produce its JS and pak artifacts");
  }

  const clang = mustRun("xcrun", ["--find", "clang"]);
  const linker = mustRun("xcrun", ["--find", IPODTOUCH4_TOOLCHAIN.compiler.linker]);
  const macosSdk = mustRun("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const sysroot = ipodtouch4SysrootPath();
  const csu = ipodtouch4CsuPath();
  const quickjs = join(ipodtouch4QuickJsPath(), "libquickjs-sys/embed/quickjs");
  const nativeBuild = join(REPOSITORY, `.pocket-build/ipodtouch4/${APP.id}/runtime`);
  const rustTarget = join(ipodtouch4CacheRoot(), "build/rust-target");
  const cargoHome = join(ipodtouch4CacheRoot(), "build/cargo-home");
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
    compile(join(quickjs, source), output, ["-I", quickjs, `-DCONFIG_VERSION=\"${IPODTOUCH4_TOOLCHAIN.compiler.quickJsVersion}\"`]);
    quickJsObjects.push(output);
  }

  const rustup = commandPath("rustup");
  if (!rustup) throw new Error("pocket ipodtouch4: rustup is unavailable");
  const cargo = mustRun(rustup, ["which", "--toolchain", IPODTOUCH4_TOOLCHAIN.compiler.rustToolchain, "cargo"]);
  const rustc = mustRun(rustup, ["which", "--toolchain", IPODTOUCH4_TOOLCHAIN.compiler.rustToolchain, "rustc"]);
  mustRun(
    cargo,
    ["build", "--release", "--locked", "--features", "bare-platform,gles1", "--target",
      join(REPOSITORY, "hosts/ipodtouch4/armv7-apple-ios.json"), "-Z", "json-target-spec",
      "-Z", "build-std=core,alloc,compiler_builtins", "-Z", "build-std-features=compiler-builtins-mem"],
    {
      cwd: join(REPOSITORY, "engine/ui-cabi"),
      env: { ...process.env, RUSTC: rustc, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: rustTarget, IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET },
    },
  );
  const rustLibrary = join(rustTarget, "armv7-apple-ios/release/libpocketjs_symbian_core.a");
  if (!existsSync(rustLibrary)) {
    throw new Error(`pocket ipodtouch4: missing Rust static library at ${rustLibrary}`);
  }

  const bundle = bundleDirectory();
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "Info.plist"), renderInfoPlist());
  cpSync(join(REPOSITORY, "hosts/ipodtouch4/PkgInfo"), join(bundle, "PkgInfo"));
  await bakeClassicIPhoneArtwork(bundle, "User");

  const firstParty = [
    ...warnings,
    `-DPOCKET_LOGICAL_WIDTH=${inputs.viewport.logical[0]}`,
    `-DPOCKET_LOGICAL_HEIGHT=${inputs.viewport.logical[1]}`,
    `-DPOCKET_RASTER_DENSITY=${inputs.viewport.rasterDensity}`,
    ...(APP.keepAwake ? ["-DPOCKET_KEEP_AWAKE"] : []),
    // The wrapper reports the transport's state in the acceptance record,
    // so it needs the same switch as the guest runtime.
    ...(APP.svcWire ? ["-DPOCKET_SVC_WIRE"] : []),
  ];
  const offloadDefines = ["-DPOCKET_OFFLOAD_POSIX", "-I", join(REPOSITORY, "hosts/shared")];
  const offloadObject = join(nativeBuild, "offload_posix.o");
  compile(join(REPOSITORY, "hosts/shared/offload_posix.c"), offloadObject, [...warnings, ...offloadDefines]);
  const svcWireDefines = APP.svcWire ? ["-DPOCKET_SVC_WIRE", "-I", join(REPOSITORY, "hosts/ios-legacy")] : [];
  const crtGlobalsObject = join(nativeBuild, "crt_globals.o");
  const runtimeIdentityObject = join(nativeBuild, "runtime.build-id-input.o");
  const pocketRuntimeObject = join(nativeBuild, "pocket_runtime.o");
  const svcWireObject = join(nativeBuild, "svcwire.o");
  const compatObject = join(nativeBuild, "compat.o");
  compile(join(REPOSITORY, "hosts/ios-legacy/crt_globals.c"), crtGlobalsObject, warnings);
  compile(join(REPOSITORY, "hosts/ipodtouch4/runtime.c"), runtimeIdentityObject, [
    ...firstParty,
    `-DPOCKET_BUILD_ID=\"${BUILD_ID_PLACEHOLDER}\"`,
    "-I", join(REPOSITORY, "engine/quickjs-c"),
    "-Wno-cast-function-type-mismatch",
  ]);
  compile(join(REPOSITORY, "engine/quickjs-c/pocket_runtime.c"), pocketRuntimeObject, [
    ...warnings,
    ...svcWireDefines,
    ...offloadDefines,
    `-DPOCKETJS_TARGET_ID=\"${inputs.target}\"`,
    `-DPOCKETJS_HOST_ABI=${inputs.hostAbi}`,
    `-DPOCKET_RASTER_DENSITY=${inputs.viewport.rasterDensity}`,
    "-I", join(REPOSITORY, "engine/ui-cabi/include"),
    "-I", join(REPOSITORY, "contracts/generated"),
    "-isystem",
    quickjs,
  ]);
  if (APP.svcWire) {
    compile(join(REPOSITORY, "hosts/ios-legacy/svcwire.c"), svcWireObject, [...warnings, ...svcWireDefines]);
  }
  compile(join(REPOSITORY, "hosts/ios-legacy/compat.c"), compatObject, warnings);

  const buildId = hashInputs([
    planPath(),
    guestJavaScript,
    guestPak,
    { label: "bundle/Info.plist", path: join(bundle, "Info.plist") },
    join(REPOSITORY, "hosts/ipodtouch4/PkgInfo"),
    join(REPOSITORY, "hosts/iphone2g/Icon.png"),
    join(REPOSITORY, "hosts/iphone4s/Icon.svg"),
    join(REPOSITORY, "tools/iphone-classic-icon.ts"),
    join(REPOSITORY, "tools/icon-raster.ts"),
    join(REPOSITORY, "tools/ipodtouch4.ts"),
    join(REPOSITORY, "tools/ipodtouch4-toolchain.ts"),
    join(REPOSITORY, "tools/cli/iphone4s-toolchain.json"),
    join(REPOSITORY, "hosts/ipodtouch4/armv7-apple-ios.json"),
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
    { label: "native/offload_posix.o", path: offloadObject },
    ...(APP.svcWire ? [{ label: "native/svcwire.o", path: svcWireObject }] : []),
    { label: "native/compat.o", path: compatObject },
    ...quickJsObjects.map((path) => ({ label: `native/${path.slice(nativeBuild.length + 1)}`, path })),
    { label: "native/libpocketjs_symbian_core.a", path: rustLibrary },
    { label: `bundle/${IPHONE_USER_ICON_FILE}`, path: join(bundle, IPHONE_USER_ICON_FILE) },
    { label: `bundle/${IPHONE_USER_RETINA_ICON_FILE}`, path: join(bundle, IPHONE_USER_RETINA_ICON_FILE) },
    { label: "bundle/Default@2x.png", path: join(bundle, "Default@2x.png") },
    { label: "bundle/Default-568h@2x.png", path: join(bundle, "Default-568h@2x.png") },
  ]);

  const runtimeObject = join(nativeBuild, "runtime.o");
  compile(join(REPOSITORY, "hosts/ipodtouch4/runtime.c"), runtimeObject, [
    ...firstParty,
    `-DPOCKET_BUILD_ID=\"${buildId}\"`,
    "-I", join(REPOSITORY, "engine/quickjs-c"),
    "-Wno-cast-function-type-mismatch",
  ]);

  const embeddedJavaScript = join(nativeBuild, "app.js.bin");
  writeFileSync(embeddedJavaScript, Buffer.concat([readFileSync(guestJavaScript), Buffer.from([0])]));
  const executable = join(bundle, EXECUTABLE);
  mustRun(linker, ["-arch", "armv7", "-syslibroot", sysroot, "-L/usr/lib",
    "-F/System/Library/Frameworks", "-iphoneos_version_min", DEPLOYMENT_TARGET,
    "-no_pie", "-no_uuid", "-no_function_starts", "-no_data_in_code_info",
    "-no_source_version", "-no_compact_unwind", "-no_adhoc_codesign", "-no_encryption",
    "-e", "start", "-o", executable, join(nativeBuild, "csu-start.o"),
    join(nativeBuild, "csu-dyld-glue.o"), crtGlobalsObject,
    runtimeObject, pocketRuntimeObject, offloadObject, ...(APP.svcWire ? [svcWireObject] : []), compatObject,
    "-force_load", rustLibrary, ...quickJsObjects,
    "-sectcreate", "__DATA", "__pocket_js", embeddedJavaScript,
    "-sectcreate", "__DATA", "__pocket_pak", guestPak,
    "-framework", "UIKit", "-framework", "Foundation", "-framework", "CoreGraphics",
    "-framework", "OpenGLES", "-lobjc", "-lSystem", "-lgcc_s.1"]);
  chmodSync(executable, 0o755);
  mustRun("ldid", ["-S", executable]);
  mustRun("plutil", ["-lint", join(bundle, "Info.plist")]);

  const fileInfo = mustRun("file", [executable]);
  if (!fileInfo.includes("Mach-O executable arm_v7")) throw new Error(`pocket ipodtouch4: unexpected binary: ${fileInfo}`);
  const loads = mustRun("xcrun", ["otool-classic", "-l", executable]);
  for (const marker of ["LC_VERSION_MIN_IPHONEOS", "version 6.0", "sectname __pocket_js", "sectname __pocket_pak", "LC_CODE_SIGNATURE"]) {
    if (!loads.includes(marker)) throw new Error(`pocket ipodtouch4: binary is missing ${marker}`);
  }

  const fileNames = [
    EXECUTABLE,
    "Info.plist",
    "PkgInfo",
    IPHONE_USER_ICON_FILE,
    IPHONE_USER_RETINA_ICON_FILE,
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
    viewport: {
      logical: [inputs.viewport.logical[0], inputs.viewport.logical[1]],
      physical: [inputs.viewport.physical[0], inputs.viewport.physical[1]],
      rasterDensity: inputs.viewport.rasterDensity,
    },
  };
  writeFileSync(receiptPath(), JSON.stringify(receipt, null, 2) + "\n");

  // The USB-side bridge uses the same pinned ARMv7 toolchain, outside the app.
  const installerObject = join(nativeBuild, "installer.o");
  compile(join(REPOSITORY, "hosts/ipodtouch4/installer.c"), installerObject,
    [...warnings, "-Wno-cast-function-type-mismatch"]);
  const installer = join(REPOSITORY, "dist/ipodtouch4/installer");
  mustRun(linker, ["-arch", "armv7", "-syslibroot", sysroot, "-L/usr/lib",
    "-F/System/Library/Frameworks", "-iphoneos_version_min", DEPLOYMENT_TARGET,
    "-no_pie", "-no_uuid", "-no_function_starts", "-no_data_in_code_info",
    "-no_source_version", "-no_compact_unwind", "-no_adhoc_codesign", "-no_encryption",
    "-e", "start", "-o", installer, join(nativeBuild, "csu-start.o"),
    join(nativeBuild, "csu-dyld-glue.o"), crtGlobalsObject, installerObject,
    "-framework", "Foundation", "-lobjc", "-lSystem", "-lgcc_s.1"]);
  chmodSync(installer, 0o755);
  mustRun("ldid", [`-S${join(REPOSITORY, "hosts/ipodtouch4/installer-entitlements.plist")}`, installer]);

  const packageRoot = join(nativeBuild, "package");
  const payload = join(packageRoot, "Payload", BUNDLE_NAME);
  mkdirSync(dirname(payload), { recursive: true });
  cpSync(bundle, payload, { recursive: true });
  rmSync(ipaPath(), { force: true });
  mustRun("zip", ["-q", "-r", ipaPath(), "Payload"], { cwd: packageRoot });

  console.log(`built ${bundle}`);
  console.log(fileInfo);
  console.log(`build_id=${buildId}`);
}

function ipaPath(): string {
  return join(REPOSITORY, `dist/ipodtouch4/${BUNDLE_NAME.replace(/\.app$/, ".ipa")}`);
}

function copyToDevice(port: number, source: string, destination: string): void {
  mustRun("scp", [...viaArgs(), "-O", "-i", KEY_PATH, "-P", String(port), "-o", "BatchMode=yes",
    "-o", `HostKeyAlias=[127.0.0.1]:${LOCAL_PORT}`, "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS_PATH}`, "-o", "HostKeyAlgorithms=+ssh-rsa",
    "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa", source, `root@127.0.0.1:${destination}`]);
}

async function deploy(): Promise<void> {
  await build();
  const receipt = readReceipt();
  const transactionId = randomBytes(12).toString("hex");
  const remoteRoot = `/private/var/tmp/pocketjs-user-${transactionId}`;
  const archive = `${remoteRoot}/app.ipa`;
  const script = join(REPOSITORY, `.pocket-build/ipodtouch4/deploy-${transactionId}.sh`);
  writeFileSync(script, userDeploymentScript({
    bundleId: BUNDLE_ID, bundleName: BUNDLE_NAME, executable: EXECUTABLE, archive, archiveHash: sha256(ipaPath()),
    files: { ...receipt.files, "build-receipt.json": sha256(receiptPath()) },
  }));
  try {
    await withTunnel((port) => {
      mustRemote(port, `set -eu; mkdir -p /var/root/Library/PocketJS; chmod 700 /var/root/Library/PocketJS; mkdir -m 755 ${remoteRoot}`);
      try {
        copyToDevice(port, join(REPOSITORY, "dist/ipodtouch4/installer"), `${remoteRoot}/installer`);
        copyToDevice(port, ipaPath(), archive);
        copyToDevice(port, script, `${remoteRoot}/deploy.sh`);
        const helperHash = sha256(join(REPOSITORY, "dist/ipodtouch4/installer"));
        mustRemote(port, `set -eu; test "$(/usr/bin/openssl dgst -sha256 ${remoteRoot}/installer)" = ` +
          shellQuote(`SHA256(${remoteRoot}/installer)= ${helperHash}`) +
          `; chmod 700 ${remoteRoot}/installer; mv ${remoteRoot}/installer ${IPOD_INSTALLER}; ` +
          `${IPOD_INSTALLER} lock ${shellQuote(BUNDLE_ID)} ${remoteRoot}/deploy.sh`);
        verifyInstalledReceipt(port, receipt);
      } finally {
        // Migration backups are durable and belong to the next locked recovery.
        remote(port, `rm -rf ${remoteRoot}`);
      }
    });
  } finally { rmSync(script, { force: true }); }
  console.log(`deployed User app ${receipt.buildId} with byte-exact readback`);
}

function installedApp(port: number) {
  const raw = mustRemote(port, `${IPOD_INSTALLER} lookup ${shellQuote(BUNDLE_ID)}`);
  return parseInstalledIPodApp(raw, BUNDLE_ID, BUNDLE_NAME);
}

async function uninstall(): Promise<void> {
  await withTunnel((port) => {
    const app = installedApp(port);
    // Refuse removal of a legacy System app; migration must establish a User container.
    mustRemote(port, `${IPOD_INSTALLER} uninstall ${shellQuote(BUNDLE_ID)}`);
    const remaining = mustRemote(port, `${IPOD_INSTALLER} lookup ${shellQuote(BUNDLE_ID)}`);
    if (JSON.parse(remaining) !== null || remote(port, `test ! -e ${shellQuote(app.Container)}`).exitCode !== 0) {
      throw new Error("pocket ipodtouch4: uninstall did not remove the application and its container");
    }
  });
  console.log(`uninstalled ${BUNDLE_ID} and its data container`);
}

function verifyInstalledReceipt(port: number, receipt: BuildReceipt) {
  const app = installedApp(port);
  const installed = mustRemote(port, `cat ${shellQuote(app.Path + "/build-receipt.json")}`);
  const installedReceipt = JSON.parse(installed) as BuildReceipt;
  if (!buildReceiptsMatch(installedReceipt, receipt)) {
    throw new Error(
      `pocket ipodtouch4: installed receipt does not match local build ${receipt.buildId}`,
    );
  }
  return ipodAppReceiptPaths(app);
}

async function launch(): Promise<void> {
  const receipt = readReceipt();
  await withTunnel(async (port) => {
    const paths = verifyInstalledReceipt(port, receipt);
    mustRemote(
      port,
      `killall ${EXECUTABLE} 2>/dev/null || true; rm -f ${paths.status} ${paths.frame}; ` +
        `/bin/su mobile -c '/usr/bin/uiopen ${APP.scheme}://launch'; echo launch-requested`,
    );
    await Bun.sleep(2500);
  });
  await status(false);
}

async function readDeviceStatus(port: number, paths: ReturnType<typeof ipodAppReceiptPaths>): Promise<DeviceStatus> {
  const raw = mustRemote(port, `cat ${paths.status}`);
  const values = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const number = (key: string): number => {
    const value = Number(values.get(key));
    if (!Number.isFinite(value)) throw new Error(`pocket ipodtouch4: malformed status field ${key}`);
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
    const paths = verifyInstalledReceipt(port, receipt);
    const first = await readDeviceStatus(port, paths);
    await Bun.sleep(1200);
    const current = await readDeviceStatus(port, paths);
    if (current.schema !== 2) {
      throw new Error("pocket ipodtouch4: malformed device status identity");
    }
    if (current.build_id !== receipt.buildId) {
      throw new Error(
        `pocket ipodtouch4: status build ${current.build_id} does not match local ${receipt.buildId}`,
      );
    }
    if (current.state !== "running" || current.error !== "") {
      throw new Error(`pocket ipodtouch4: guest state=${current.state} error=${current.error || "none"}`);
    }
    const drawable = expectedDrawable(receipt);
    if (
      current.renderer !== "gles1" ||
      current.raster_density !== drawable.rasterDensity ||
      current.drawable_width !== drawable.physical[0] ||
      current.drawable_height !== drawable.physical[1]
    ) {
      throw new Error(
        `pocket ipodtouch4: expected GLES1 Retina ${drawable.physical.join("x")}, got ` +
          `${current.renderer} ${current.drawable_width}x${current.drawable_height} @${current.raster_density}x`,
      );
    }
    if (current.guest_frames <= first.guest_frames) {
      throw new Error("pocket ipodtouch4: guest frame counter did not advance");
    }
    if (current.heartbeat <= first.heartbeat) throw new Error("pocket ipodtouch4: status heartbeat did not advance");
    mustRemote(port, `kill -0 ${current.pid}`);
    if (
      requireAction &&
      (current.completed_touch_sequences < 1 ||
        current.action_name !== APP.actionName ||
        current.action_value < 1 ||
        current.action_sequence < 1)
    ) {
      throw new Error(`pocket ipodtouch4: no completed ${APP.title} action receipt yet`);
    }
    console.log(JSON.stringify(current, null, 2));
  });
}

async function capture(): Promise<void> {
  const rawDestination = join(REPOSITORY, "dist/ipodtouch4/device-frame.rgba");
  const destination = join(REPOSITORY, "dist/ipodtouch4/device-frame.png");
  rmSync(rawDestination, { force: true });
  rmSync(destination, { force: true });
  let renderer = "";
  let width = 0;
  let height = 0;
  const drawable = expectedDrawable(readReceipt());
  await withTunnel(async (port) => {
    const paths = verifyInstalledReceipt(port, readReceipt());
    try {
      const status = await readDeviceStatus(port, paths);
      renderer = status.renderer;
      width = status.drawable_width;
      height = status.drawable_height;
      if (
        renderer !== "gles1" ||
        width !== drawable.physical[0] ||
        height !== drawable.physical[1] ||
        status.raster_density !== drawable.rasterDensity
      ) {
        throw new Error(`pocket ipodtouch4: refusing non-Retina capture ${renderer} ${width}x${height}`);
      }
      mustRemote(
        port,
        `rm -f ${paths.frame} ${paths.capture}; ` +
          `/bin/su mobile -c 'touch ${paths.capture}'`,
      );
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await Bun.sleep(200);
        if (remote(port, `test -s ${paths.frame}`).exitCode === 0) break;
      }
      mustRemote(port, `test -s ${paths.frame}`);
      const frame = runBinary("ssh", sshArgs(port, `cat ${paths.frame}`));
      if (frame.exitCode !== 0) {
        throw new Error(`pocket ipodtouch4: device frame download failed (${frame.exitCode}):\n${frame.stderr.trim()}`);
      }
      writeFileSync(rawDestination, frame.stdout);
    } finally {
      remote(port, `rm -f ${paths.capture} ${paths.frame}`);
    }
  });
  const raw = readFileSync(rawDestination);
  if (raw.byteLength !== width * height * 4) throw new Error(`pocket ipodtouch4: capture has ${raw.byteLength} bytes`);
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
  console.log(`PocketJS iPod touch 4 tool  (app: ${APP.id}${APP.root ? ` from ${APP.root}` : ""}; POCKETJS_IPODTOUCH4_APP=${Object.keys(IPODTOUCH4_APPS).join("|")} or POCKETJS_IPODTOUCH4_APP_FILE=<external app's ipodtouch4.json>; POCKETJS_IPODTOUCH4_VIA=<ssh host the iPod is plugged into>${VIA ? ` = ${VIA}` : ""})

  bun ipodtouch4 doctor
  bun ipodtouch4 setup-sources
  bun ipodtouch4 prepare-sysroot
  bun ipodtouch4 build
  bun ipodtouch4 deploy
  bun ipodtouch4 uninstall
  bun ipodtouch4 launch
  bun ipodtouch4 status [--require-action]
  bun ipodtouch4 capture
  bun ipodtouch4 tunnel`);
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const command = args[0] ?? "doctor";
  switch (command) {
    case "doctor":
      await doctor();
      break;
    case "setup-sources":
      delegateToIPhone4S("setup-sources");
      break;
    case "prepare-sysroot":
      delegateToIPhone4S("prepare-sysroot");
      break;
    case "build":
      await build();
      break;
    case "deploy":
      await deploy();
      break;
    case "uninstall":
      await uninstall();
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
      throw new Error(`pocket ipodtouch4: unknown command ${command}`);
  }
}

if (import.meta.main) {
  await main();
}
