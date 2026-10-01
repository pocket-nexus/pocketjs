import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import {
  BLACKBERRY_QNX_DEV_TARGET_ID,
  resolveBlackBerryClassicBuildPlan,
} from "./blackberry-classic-profile.ts";
import {
  buildGuestBundle,
  ensureQuickJsCheckout,
  type GuestBundleRequest,
  mustRunCommand,
  packageIdentity,
  printCheck,
  quickJsCheckoutStatus,
  readGuestBundle,
  renderTemplate,
  runCommand,
  sha256File,
  xmlEscape,
} from "./native-host-build.ts";

const LABEL = "PocketJS BlackBerry QNX";
const repository = fileURLToPath(new URL("..", import.meta.url));
const command = Bun.argv[2] ?? "doctor";
const toolchain = JSON.parse(
  readFileSync(
    join(repository, "tools/cli/blackberry-qnx-toolchain.json"),
    "utf8",
  ),
) as {
  readonly toolchainVersion: string;
  readonly cachePath: string;
  readonly image: {
    readonly name: string;
    readonly digest: string;
    readonly platform: string;
  };
  readonly qnx: {
    readonly apiLevel: string;
    readonly hostVersion: string;
    readonly compiler: string;
    readonly architecture: string;
    readonly dynamicLoader: string;
  };
  readonly quickjs: {
    readonly version: string;
    readonly repository: string;
    readonly revision: string;
  };
  readonly rust: {
    readonly toolchain: string;
    readonly target: string;
  };
  readonly app: {
    readonly manifest: string;
    readonly binary: string;
    readonly bar: string;
  };
};

const image = `${toolchain.image.name}@${toolchain.image.digest}`;
const cache = join(homedir(), ".cache/pocket-nexus", toolchain.cachePath);
const quickJsRoot = join(cache, "sources/quickjs-rs");
const nativeBuild = join(repository, ".pocket-build/blackberry-qnx/runtime");
const rustTarget = join(cache, "build/rust-target");
const outputBar = join(repository, toolchain.app.bar);
const outputReceipt = join(dirname(outputBar), "build-receipt.json");
const rustTargetSpec = join(repository, toolchain.rust.target);
const rustTargetName = basename(toolchain.rust.target, ".json");
const guest: GuestBundleRequest = {
  label: LABEL,
  repository,
  target: BLACKBERRY_QNX_DEV_TARGET_ID,
  resolvePlan: (manifest) =>
    resolveBlackBerryClassicBuildPlan(manifest, BLACKBERRY_QNX_DEV_TARGET_ID),
  manifestPath: join(repository, toolchain.app.manifest),
  planPath: join(repository, ".pocket/blackberry-qnx/blackberry-classic.plan.json"),
  outputDirectory: join(repository, "dist/blackberry-qnx/guest"),
};

function run(program: string, args: readonly string[]) {
  return runCommand(program, args, repository);
}

function mustRun(
  program: string,
  args: readonly string[],
  cwd = repository,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return mustRunCommand(LABEL, program, args, cwd, env);
}

function imagePresent(): boolean {
  return run("docker", ["image", "inspect", image]).exitCode === 0;
}

function doctor(): void {
  const docker = run("docker", ["version", "--format", "{{.Client.Version}}"]).exitCode === 0;
  const rust = run("rustup", ["run", toolchain.rust.toolchain, "rustc", "--version"]);
  const quickjs = quickJsCheckoutStatus(quickJsRoot, toolchain.quickjs);
  const checks = [
    printCheck("Docker", docker, "docker client and daemon"),
    printCheck("pinned BBNDK image", imagePresent(), image),
    printCheck(
      "Rust nightly",
      rust.exitCode === 0,
      rust.stdout.trim() || toolchain.rust.toolchain,
    ),
    printCheck("pinned QuickJS", quickjs.ok, quickjs.detail),
    printCheck("QNX Rust target", existsSync(rustTargetSpec), rustTargetSpec),
  ];
  if (imagePresent()) {
    const qnx = run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--platform",
      toolchain.image.platform,
      "--entrypoint",
      "/bin/bash",
      image,
      "-lc",
      `qcc -V 2>&1 | grep -q '${toolchain.qnx.compiler}' && ` +
        `blackberry-nativepackager -version 2>&1 | grep -q 'version 1.11'`,
    ]);
    checks.push(
      printCheck(
        "QNX compiler and BAR packager",
        qnx.exitCode === 0,
        `${toolchain.qnx.compiler}; blackberry-nativepackager 1.11`,
      ),
    );
  }
  if (checks.some((ok) => !ok)) process.exitCode = 1;
  else console.log(`[ok] toolchain: ${toolchain.toolchainVersion}`);
}

function ensureImage(): void {
  if (imagePresent()) return;
  mustRun("docker", ["pull", "--platform", toolchain.image.platform, image]);
}

function setup(): void {
  ensureImage();
  ensureQuickJsCheckout(LABEL, quickJsRoot, toolchain.quickjs);
  doctor();
}

function buildRustCore(): string {
  mkdirSync(rustTarget, { recursive: true });
  mustRun(
    "rustup",
    [
      "run",
      toolchain.rust.toolchain,
      "cargo",
      "build",
      "--release",
      "--locked",
      "--features",
      "bare-platform",
      "--target",
      rustTargetSpec,
      "-Z",
      "json-target-spec",
      "-Z",
      "build-std=core,alloc,compiler_builtins",
      "-Z",
      "build-std-features=compiler-builtins-mem",
    ],
    join(repository, "engine/ui-cabi"),
    {
      ...process.env,
      CARGO_PROFILE_RELEASE_LTO: "false",
      CARGO_TARGET_DIR: rustTarget,
    },
  );
  const library = join(
    rustTarget,
    `${rustTargetName}/release/libpocketjs_symbian_core.a`,
  );
  if (!existsSync(library)) {
    throw new Error(`${LABEL}: Rust core archive is absent: ${library}`);
  }
  return library;
}

function dockerBuild(buildId: string, inputs: HostBuildInputs): void {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  mustRun("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--platform",
    toolchain.image.platform,
    "--user",
    `${uid}:${gid}`,
    "-e",
    "HOME=/tmp",
    "-e",
    `POCKET_BUILD_ID=${buildId}`,
    "-e",
    `POCKETJS_TARGET_ID=${inputs.target}`,
    "-e",
    `POCKETJS_HOST_ABI=${inputs.hostAbi}`,
    "-e",
    `POCKET_RASTER_DENSITY=${inputs.viewport.rasterDensity}`,
    "-e",
    `POCKET_LOGICAL_WIDTH=${inputs.viewport.logical[0]}`,
    "-e",
    `POCKET_LOGICAL_HEIGHT=${inputs.viewport.logical[1]}`,
    "-e",
    `QNX_COMPILER=${toolchain.qnx.compiler}`,
    "-e",
    `QUICKJS_VERSION=${toolchain.quickjs.version}`,
    "-v",
    `${repository}:/repo:ro`,
    "-v",
    `${nativeBuild}:/build`,
    "--entrypoint",
    "/bin/bash",
    image,
    "/repo/tools/blackberry-qnx/build.sh",
  ]);
}

function readBarEntry(bar: string, entry: string): Buffer {
  const result = Bun.spawnSync({
    cmd: ["unzip", "-p", bar, entry],
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${LABEL}: cannot read ${entry} from BAR: ${result.stderr.toString().trim()}`,
    );
  }
  return Buffer.from(result.stdout);
}

function buildRuntime(): void {
  if (!imagePresent()) {
    throw new Error(
      `${LABEL}: pinned BBNDK image is absent; run \`bun blackberry-qnx setup\``,
    );
  }
  ensureQuickJsCheckout(LABEL, quickJsRoot, toolchain.quickjs);
  const bundle = readGuestBundle(guest);
  const coreLibrary = buildRustCore();
  const buildId = randomBytes(16).toString("hex");
  rmSync(nativeBuild, { recursive: true, force: true });
  mkdirSync(join(nativeBuild, "staging"), { recursive: true });
  mkdirSync(dirname(outputBar), { recursive: true });

  cpSync(
    join(quickJsRoot, "libquickjs-sys"),
    join(nativeBuild, "quickjs-rs/libquickjs-sys"),
    { recursive: true },
  );
  mustRun("patch", [
    "-d",
    join(nativeBuild, "quickjs-rs"),
    "-p1",
    "-i",
    join(repository, "tools/blackberry-qnx/quickjs-qnx.patch"),
  ]);
  copyFileSync(coreLibrary, join(nativeBuild, "libpocketjs_symbian_core.a"));
  copyFileSync(bundle.javaScript, join(nativeBuild, "staging/app.js"));
  copyFileSync(bundle.pack, join(nativeBuild, "staging/app.pak"));
  copyFileSync(
    join(repository, "assets/images/logo.png"),
    join(nativeBuild, "staging/icon.png"),
  );
  const identity = packageIdentity(bundle.inputs.app);
  writeFileSync(
    join(nativeBuild, "staging/bar-descriptor.xml"),
    renderTemplate(
      readFileSync(join(repository, "hosts/blackberry-classic-qnx/bar-descriptor.xml"), "utf8"),
      {
        ID: identity.packageId,
        TITLE: xmlEscape(identity.title),
        VERSION: identity.version,
        BUILD_ID: identity.versionCode,
      },
    ),
  );

  dockerBuild(buildId, bundle.inputs);
  const builtBar = join(nativeBuild, "pocketjs-blackberry-classic-hero.bar");
  const executable = join(nativeBuild, `staging/${toolchain.app.binary}`);
  const elf = readFileSync(
    join(nativeBuild, "pocketjs-classic.readelf.txt"),
    "utf8",
  );
  const symbols = readFileSync(
    join(nativeBuild, "pocketjs-classic.symbols.txt"),
    "utf8",
  );
  for (const marker of [
    "Machine:                           ARM",
    toolchain.qnx.dynamicLoader,
    "libbps.so.3",
    "libscreen.so.1",
    "libEGL.so.1",
    "libGLESv2.so.1",
  ]) {
    if (!elf.includes(marker)) {
      throw new Error(`${LABEL}: linked ELF is missing ${marker}`);
    }
  }
  for (const symbol of [
    " main",
    " pocket_runtime_boot",
    " pocket_runtime_tick",
    " ui_gl_render",
  ]) {
    if (!symbols.includes(symbol)) {
      throw new Error(`${LABEL}: linked ELF is missing${symbol}`);
    }
  }
  const manifest = readBarEntry(builtBar, "META-INF/MANIFEST.MF").toString("utf8");
  for (const marker of [
    "Package-Architecture: armle-v7",
    "Application-Development-Mode: true",
    "Entry-Point-Type: Qnx/Elf",
    "Entry-Point-System-Actions: run_native",
    `Package-Name: ${identity.packageId}`,
    `Package-Version: ${identity.version}.${identity.versionCode}`,
    "Archive-Asset-Name: native/app.js",
    "Archive-Asset-Name: native/app.pak",
  ]) {
    if (!manifest.includes(marker)) {
      throw new Error(`${LABEL}: BAR manifest is missing ${marker}`);
    }
  }
  const embeddedExecutable = readBarEntry(
    builtBar,
    `native/${toolchain.app.binary}`,
  );
  if (
    createHash("sha256").update(embeddedExecutable).digest("hex") !==
    sha256File(executable)
  ) {
    throw new Error(`${LABEL}: BAR embedded a different native executable`);
  }

  copyFileSync(builtBar, outputBar);
  const receipt = {
    schemaVersion: 1,
    toolchainVersion: toolchain.toolchainVersion,
    buildId,
    hostContract: bundle.inputs,
    package: identity,
    compilerImage: image,
    qnx: toolchain.qnx,
    rustToolchain: toolchain.rust.toolchain,
    rustTarget: toolchain.rust.target,
    quickJsRevision: toolchain.quickjs.revision,
    quickJsVersion: toolchain.quickjs.version,
    quickJsPatchSha256: sha256File(
      join(repository, "tools/blackberry-qnx/quickjs-qnx.patch"),
    ),
    guestJavaScriptSha256: sha256File(bundle.javaScript),
    guestPackSha256: sha256File(bundle.pack),
    coreLibrarySha256: sha256File(coreLibrary),
    executableSha256: sha256File(executable),
    executableBytes: lstatSync(executable).size,
    barSha256: sha256File(outputBar),
    barBytes: lstatSync(outputBar).size,
    elf,
  };
  writeFileSync(outputReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`${LABEL}: Hero BAR -> ${outputBar}`);
  console.log(`SHA-256: ${receipt.barSha256}`);
  console.log(`Receipt: ${outputReceipt}`);
}

function build(): void {
  buildGuestBundle(guest);
  buildRuntime();
}

function deviceAddress(): string {
  const address = process.env.POCKETJS_BLACKBERRY_DEVICE?.trim();
  if (!address) {
    throw new Error(
      `${LABEL}: set POCKETJS_BLACKBERRY_DEVICE to the Classic development IP`,
    );
  }
  return address;
}

function deviceCredentials(): string[] {
  const args = ["-device", deviceAddress()];
  const password = process.env.POCKETJS_BLACKBERRY_PASSWORD;
  if (password !== undefined && password !== "") {
    args.push("-password", password);
  }
  return args;
}

/**
 * The Classic's USB network function (vendor 0fca, cdc_ncm) on Linux. Other
 * hosts return undefined and skip the route check below.
 */
function blackberryUsbInterface(): string | undefined {
  const networkDevices = "/sys/class/net";
  if (!existsSync(networkDevices)) return undefined;
  let fallback: string | undefined;
  for (const name of readdirSync(networkDevices).sort()) {
    const info = run("udevadm", [
      "info",
      "--query=property",
      join(networkDevices, name),
    ]);
    if (
      info.exitCode !== 0 ||
      !info.stdout.includes("ID_VENDOR_ID=0fca") ||
      !info.stdout.includes("ID_NET_DRIVER=cdc_ncm")
    ) {
      continue;
    }
    fallback ??= name;
    const carrier = join(networkDevices, name, "carrier");
    if (existsSync(carrier) && readFileSync(carrier, "utf8").trim() === "1") {
      return name;
    }
  }
  return fallback;
}

function requireDeviceRoute(): void {
  const address = deviceAddress();
  if (!address.startsWith("169.254.")) return;
  const usb = blackberryUsbInterface();
  if (!usb) return;
  const route = run("ip", ["route", "get", address]);
  if (
    route.exitCode === 0 &&
    route.stdout.includes(`dev ${usb}`) &&
    route.stdout.includes("src 169.254.")
  ) {
    return;
  }
  throw new Error(
    `${LABEL}: ${usb} is the connected BlackBerry USB interface but has no link-local IPv4 route. ` +
      `Run \`sudo ip address replace 169.254.0.2/16 dev ${usb}\`, then retry.`,
  );
}

function runBlackBerryDeploy(args: readonly string[], mountArtifacts = false): string {
  requireDeviceRoute();
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    "host",
    "--platform",
    toolchain.image.platform,
    "--user",
    `${uid}:${gid}`,
    "-e",
    "HOME=/tmp",
  ];
  if (mountArtifacts) {
    dockerArgs.push("-v", `${dirname(outputBar)}:/artifacts:ro`);
  }
  dockerArgs.push(
    "--entrypoint",
    "/home/admin/bin/bbndk/host_10_3_1_12/linux/x86/usr/bin/blackberry-deploy",
    image,
    ...args,
  );
  const result = run("docker", dockerArgs);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${LABEL}: blackberry-deploy failed (${result.exitCode})${
        detail ? `:\n${detail}` : ""
      }`,
    );
  }
  return result.stdout.trim();
}

function requireBar(): void {
  if (!existsSync(outputBar)) {
    throw new Error(`${LABEL}: Hero BAR is absent; run \`bun blackberry-qnx build\``);
  }
}

function manifestField(name: string): string {
  requireBar();
  const manifest = readBarEntry(outputBar, "META-INF/MANIFEST.MF").toString("utf8");
  const match = manifest.match(new RegExp(`^${name}: (.+)$`, "m"));
  if (!match) {
    throw new Error(`${LABEL}: BAR manifest has no ${name}`);
  }
  return match[1].trim();
}

function deviceInfo(): void {
  console.log(
    runBlackBerryDeploy(["-listDeviceInfo", ...deviceCredentials()]),
  );
}

function install(): void {
  requireBar();
  console.log(
    runBlackBerryDeploy(
      [
        "-installApp",
        "-launchApp",
        ...deviceCredentials(),
        "-package",
        `/artifacts/${basename(outputBar)}`,
      ],
      true,
    ),
  );
}

function deviceStatus(): void {
  console.log(
    runBlackBerryDeploy([
      "-getFile",
      "data/pocketjs-qnx.status",
      "-",
      ...deviceCredentials(),
      "-package-name",
      manifestField("Package-Name"),
      "-package-id",
      manifestField("Package-Id"),
    ]),
  );
}

switch (command) {
  case "doctor":
    doctor();
    break;
  case "setup":
    setup();
    break;
  case "build-demo":
    buildGuestBundle(guest);
    break;
  case "build-runtime":
    buildRuntime();
    break;
  case "build":
    build();
    break;
  case "device-info":
    deviceInfo();
    break;
  case "install":
    install();
    break;
  case "device-status":
    deviceStatus();
    break;
  default:
    throw new Error(
      "usage: bun tools/blackberry-qnx.ts <doctor|setup|build-demo|build-runtime|build|device-info|install|device-status>",
    );
}
