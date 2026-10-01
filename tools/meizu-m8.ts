import { createHash, randomBytes } from "node:crypto";
import {
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
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import {
  extractHostBuildInputs,
  type HostBuildInputs,
} from "../framework/src/manifest/host-build-inputs.ts";
import { resolveMeizuM8BuildPlan } from "./meizu-m8-profile.ts";
import { validateMeizuM8FramebufferBmp } from "./meizu-m8/validation.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const command = Bun.argv[2] ?? "doctor";
const toolchain = JSON.parse(
  readFileSync(join(repository, "tools/cli/meizu-m8-toolchain.json"), "utf8"),
) as {
  readonly toolchainVersion: string;
  readonly cachePath: string;
  readonly compiler: {
    readonly image: string;
    readonly rustToolchain: string;
    readonly quickJsRepository: string;
    readonly quickJsRevision: string;
    readonly quickJsVersion: string;
  };
  readonly rapi: { readonly repository: string; readonly revision: string };
};
const cache = join(homedir(), ".cache/pocket-nexus", toolchain.cachePath);
const manifestPath = join(repository, "apps/meizu-m8-demo/pocket.json");
// 80x80 M8 Shell derivative of the shipped iPhone 2G PocketJS Icon.png.
const shellIcon = join(repository, "apps/meizu-m8-demo/icon80.png");
const planPath = join(repository, ".pocket/meizu-m8/meizu-m8-demo.plan.json");
const guestDirectory = join(repository, "dist/meizu-m8/guest");
const nativeBuild = join(repository, ".pocket-build/meizu-m8/runtime");
const rustTarget = join(cache, "build/rust-target");
const outputDirectory = join(repository, "dist/meizu-m8");
const executable = join(outputDirectory, "PocketJS.exe");
const stopExecutable = join(outputDirectory, "PocketJSStop.exe");
const quickJsCheckout = join(cache, "sources/quickjs-rs");
const quickJsSource = join(
  quickJsCheckout,
  "libquickjs-sys/embed/quickjs",
);

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GuestArtifacts {
  readonly plan: ResolvedBuildPlan;
  readonly inputs: HostBuildInputs;
  readonly javaScript: string;
  readonly pack: string;
}

function run(
  program: string,
  args: readonly string[],
  cwd = repository,
  env: NodeJS.ProcessEnv = process.env,
): CommandResult {
  const result = Bun.spawnSync({
    cmd: [program, ...args],
    cwd,
    env,
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
  program: string,
  args: readonly string[],
  cwd = repository,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = run(program, args, cwd, env);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${program} ${args.join(" ")} failed (${result.exitCode})${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function commandPath(name: string): string | undefined {
  const result = run("/usr/bin/which", [name]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function check(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "[ok]" : "[missing]"} ${label}: ${detail}`);
  return ok;
}

function currentPlan(): ResolvedBuildPlan {
  return resolveMeizuM8BuildPlan(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
}

function guestArtifacts(plan: ResolvedBuildPlan): GuestArtifacts {
  const inputs = extractHostBuildInputs(plan);
  return {
    plan,
    inputs,
    javaScript: join(guestDirectory, `${inputs.appOutput}.js`),
    pack: join(guestDirectory, `${inputs.appOutput}.pak`),
  };
}

function readGuestArtifacts(): GuestArtifacts {
  if (!existsSync(planPath)) {
    throw new Error(
      "PocketJS Meizu M8: resolved plan is absent; run `bun tools/meizu-m8.ts build-demo`",
    );
  }
  const stored = JSON.parse(readFileSync(planPath, "utf8")) as ResolvedBuildPlan;
  const current = currentPlan();
  if (stored.planHash !== current.planHash) {
    throw new Error(
      "PocketJS Meizu M8: resolved plan is stale; rerun build-demo",
    );
  }
  const artifacts = guestArtifacts(stored);
  if (!existsSync(artifacts.javaScript) || !existsSync(artifacts.pack)) {
    throw new Error("PocketJS Meizu M8: guest JavaScript or pack is absent");
  }
  return artifacts;
}

function buildDemo(): void {
  const plan = currentPlan();
  mkdirSync(dirname(planPath), { recursive: true });
  rmSync(guestDirectory, { recursive: true, force: true });
  mkdirSync(guestDirectory, { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  mustRun(process.execPath, [
    join(repository, "tools/build.ts"),
    `--plan=${planPath}`,
    `--project-root=${repository}`,
    `--outdir=${guestDirectory}`,
  ]);
  const artifacts = guestArtifacts(plan);
  if (!existsSync(artifacts.javaScript) || !existsSync(artifacts.pack)) {
    throw new Error("PocketJS Meizu M8: guest build did not emit js and pak");
  }
  console.log(`PocketJS Meizu M8: guest bundle -> ${guestDirectory}`);
}

function ensureQuickJs(): void {
  if (existsSync(join(quickJsCheckout, ".git"))) {
    const revision = mustRun("git", ["-C", quickJsCheckout, "rev-parse", "HEAD"]);
    if (revision !== toolchain.compiler.quickJsRevision) {
      throw new Error(
        `PocketJS Meizu M8: refusing unpinned QuickJS checkout ${revision}`,
      );
    }
    const changes = mustRun("git", [
      "-C",
      quickJsCheckout,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (changes !== "") {
      throw new Error(
        `PocketJS Meizu M8: refusing dirty QuickJS checkout:\n${changes}`,
      );
    }
    return;
  }
  if (existsSync(quickJsCheckout)) {
    throw new Error(
      `PocketJS Meizu M8: refusing unexpected source directory ${quickJsCheckout}`,
    );
  }
  mkdirSync(dirname(quickJsCheckout), { recursive: true });
  mustRun("git", [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    toolchain.compiler.quickJsRepository,
    quickJsCheckout,
  ]);
  mustRun("git", [
    "-C",
    quickJsCheckout,
    "checkout",
    "--detach",
    toolchain.compiler.quickJsRevision,
  ]);
}

function cArray(name: string, bytes: Buffer): string {
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    rows.push(
      `  ${[...bytes.subarray(offset, offset + 16)]
        .map((value) => `0x${value.toString(16).padStart(2, "0")}`)
        .join(", ")},`,
    );
  }
  return [
    `const unsigned char ${name}[] = {`,
    ...rows,
    "};",
    `const unsigned int ${name}_len = ${bytes.length}U;`,
    "",
  ].join("\n");
}

export function sanitizeRustAssembly(source: string): string {
  const output: string[] = [];
  let skipSection = false;
  for (const line of source.split("\n")) {
    if (/^\s*\.section\s+\.(?:llvmbc|llvmcmd)/.test(line) ||
        /^\s*\.section\s+"?\.note\.GNU-stack/.test(line)) {
      skipSection = true;
      continue;
    }
    if (/^\s*\.section/.test(line)) {
      skipSection = false;
      if (/\s\.text/.test(line)) output.push("\t.text");
      else if (/\s\.rodata/.test(line)) output.push("\t.section .rdata");
      else if (/\s\.data/.test(line)) output.push("\t.data");
      else if (/\s\.bss/.test(line)) output.push("\t.bss");
      else output.push(line);
      continue;
    }
    if (skipSection) continue;
    // alloc's unstable-shim marker is a link-time guard with no runtime work.
    // GNU PE auto-import otherwise resolves the undefined function as data and
    // turns every allocation into a branch into the data section.
    if (/^\s*bl\s+\S*___rust_no_alloc_shim_is_unstable_v2\s*$/.test(line)) {
      continue;
    }
    if (/^\s*\.weak\s+/.test(line)) {
      output.push(line.replace(".weak", ".globl"));
      continue;
    }
    if (/^\s*\.(?:eabi_attribute|type|size|fnstart|fnend|save|setfp|pad|cantunwind|ident|file|hidden)\b/.test(line)) {
      continue;
    }
    output.push(line);
  }
  return `${output.join("\n")}\n`;
}

function buildRuntime(): void {
  ensureQuickJs();
  const artifacts = readGuestArtifacts();
  const { inputs } = artifacts;
  const buildId = randomBytes(16).toString("hex");
  rmSync(nativeBuild, { recursive: true, force: true });
  rmSync(rustTarget, { recursive: true, force: true });
  mkdirSync(join(nativeBuild, "qjs"), { recursive: true });
  mkdirSync(join(nativeBuild, "core-asm"), { recursive: true });
  mkdirSync(rustTarget, { recursive: true });
  cpSync(quickJsSource, join(nativeBuild, "qjs"), { recursive: true });
  mustRun("patch", [
    "-d",
    join(nativeBuild, "qjs"),
    "-p1",
    "-i",
    join(repository, "tools/meizu-m8/quickjs-wince.patch"),
  ]);
  writeFileSync(
    join(nativeBuild, "embedded.c"),
    [
      cArray("pocket_app_js", readFileSync(artifacts.javaScript)),
      cArray("pocket_app_pak", readFileSync(artifacts.pack)),
    ].join("\n"),
  );

  mustRun(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--features",
      "bare-platform,software-only,host-allocator,boot-stage",
      "--target",
      join(repository, "hosts/meizu-m8/armv6-wince-asm.json"),
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
      CARGO_TARGET_DIR: rustTarget,
      RUSTFLAGS: "--emit=asm -C codegen-units=1",
    },
  );
  const assemblyDirectory = join(
    rustTarget,
    "armv6-wince-asm/release/deps",
  );
  const assemblyFiles = readdirSync(assemblyDirectory)
    .filter((name) => name.endsWith(".s"))
    .sort();
  if (assemblyFiles.length < 8) {
    throw new Error(
      `PocketJS Meizu M8: expected Rust assembly for every crate, got ${assemblyFiles.length}`,
    );
  }
  for (const name of assemblyFiles) {
    writeFileSync(
      join(nativeBuild, "core-asm", name),
      sanitizeRustAssembly(readFileSync(join(assemblyDirectory, name), "utf8")),
    );
  }

  mustRun("docker", [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "-e",
    `POCKET_BUILD_ID=${buildId}`,
    "-e",
    `POCKET_LOGICAL_WIDTH=${inputs.viewport.logical[0]}`,
    "-e",
    `POCKET_LOGICAL_HEIGHT=${inputs.viewport.logical[1]}`,
    "-e",
    `POCKETJS_TARGET_ID=${inputs.target}`,
    "-e",
    `POCKETJS_HOST_ABI=${inputs.hostAbi}`,
    "-e",
    `QUICKJS_VERSION=${toolchain.compiler.quickJsVersion}`,
    "-v",
    `${repository}:/src:ro`,
    "-v",
    `${nativeBuild}:/build`,
    toolchain.compiler.image,
    "sh",
    "/src/tools/meizu-m8/build-wince.sh",
  ]);

  const builtExecutable = join(nativeBuild, "PocketJS.exe");
  const builtStopExecutable = join(nativeBuild, "PocketJSStop.exe");
  const objectReceipt = readFileSync(
    join(nativeBuild, "PocketJS.objdump.txt"),
    "utf8",
  );
  const symbols = readFileSync(join(nativeBuild, "PocketJS.symbols.txt"), "utf8");
  if (!objectReceipt.includes("pei-arm-wince-little") ||
      !objectReceipt.toLowerCase().includes("coredll.dll")) {
    throw new Error("PocketJS Meizu M8: output is not a WinCE ARM executable");
  }
  for (const symbol of ["WinMain", "pocket_runtime_boot", "ui_hit_test_bounds"]) {
    if (!symbols.includes(symbol)) {
      throw new Error(`PocketJS Meizu M8: linked binary is missing ${symbol}`);
    }
  }
  mkdirSync(outputDirectory, { recursive: true });
  cpSync(builtExecutable, executable);
  cpSync(builtStopExecutable, stopExecutable);
  const receipt = {
    schemaVersion: 1,
    toolchainVersion: toolchain.toolchainVersion,
    buildId,
    hostContract: inputs,
    compilerImage: toolchain.compiler.image,
    rustToolchain: toolchain.compiler.rustToolchain,
    quickJsRevision: toolchain.compiler.quickJsRevision,
    quickJsVersion: toolchain.compiler.quickJsVersion,
    rustAssemblyObjects: assemblyFiles.length,
    guestJavaScriptSha256: sha256(artifacts.javaScript),
    guestPackSha256: sha256(artifacts.pack),
    executableSha256: sha256(executable),
    executableBytes: lstatSync(executable).size,
    stopExecutableSha256: sha256(stopExecutable),
    stopExecutableBytes: lstatSync(stopExecutable).size,
  };
  writeFileSync(
    join(outputDirectory, "build-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(`PocketJS Meizu M8: WinCE executable -> ${executable}`);
}

function buildUsbBridge(): string {
  const output = join(cache, "bin/pocketjs-meizu-m8-usb");
  mkdirSync(dirname(output), { recursive: true });
  const cflags = mustRun("pkg-config", ["--cflags", "libusb-1.0"])
    .split(/\s+/).filter(Boolean);
  const libraries = mustRun("pkg-config", ["--libs", "libusb-1.0"])
    .split(/\s+/).filter(Boolean);
  mustRun("cc", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...cflags,
    join(repository, "tools/meizu-m8/usb-serial.c"),
    ...libraries,
    "-o",
    output,
  ]);
  return output;
}

function probeUsb(): void {
  mustRun(buildUsbBridge(), ["probe"]);
  console.log("PocketJS Meizu M8: USB ActiveSync CLIENT received");
}

function bridgeUsb(): void {
  const result = Bun.spawnSync({
    cmd: [buildUsbBridge(), "bridge"],
    cwd: repository,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`PocketJS Meizu M8: USB bridge exited ${result.exitCode}`);
  }
}

function synceTool(name: string): string {
  const installed = [
    join(cache, "host/bin", `synce-${name}`),
    join(cache, "host/bin", name),
  ].find(existsSync);
  const path = installed ?? commandPath(`synce-${name}`) ?? commandPath(name);
  if (!path) throw new Error(`PocketJS Meizu M8: ${name} is not installed`);
  return path;
}

function synceEnvironment(): NodeJS.ProcessEnv {
  const addressFile = join(cache, "run/dbus-address");
  if (!existsSync(addressFile)) {
    throw new Error("PocketJS Meizu M8: start a device session before using RAPI");
  }
  return {
    ...process.env,
    DBUS_SYSTEM_BUS_ADDRESS: readFileSync(addressFile, "utf8").trim(),
  };
}

function deploy(): void {
  if (!existsSync(executable) || !existsSync(stopExecutable)) {
    throw new Error("PocketJS Meizu M8: build the WinCE executables before deploy");
  }
  const pmkdir = synceTool("pmkdir");
  const pcp = synceTool("pcp");
  const prun = synceTool("prun");
  const registry = synceTool("registry");
  const receipt = JSON.parse(
    readFileSync(join(outputDirectory, "build-receipt.json"), "utf8"),
  ) as { readonly buildId: string };
  if (!/^[0-9a-f]{32}$/.test(receipt.buildId)) {
    throw new Error("PocketJS Meizu M8: build receipt has an invalid build ID");
  }
  const remoteDirectory = "/Program Files/PocketJS";
  const remoteFilename = `PocketJS-${receipt.buildId}.exe`;
  const remoteStopFilename = `PocketJSStop-${receipt.buildId}.exe`;
  const remoteIconFilename = `PocketJS80-${receipt.buildId}.png`;
  const remoteExecutable = `:${remoteDirectory}/${remoteFilename}`;
  const remoteStopExecutable = `:${remoteDirectory}/${remoteStopFilename}`;
  const remoteIcon = `:${remoteDirectory}/${remoteIconFilename}`;
  const env = synceEnvironment();
  const mkdirResult = run(pmkdir, [remoteDirectory], repository, env);
  if (mkdirResult.exitCode !== 0 && !mkdirResult.stderr.includes("already exists")) {
    throw new Error(`PocketJS Meizu M8: remote mkdir failed: ${mkdirResult.stderr}`);
  }
  const stopCopyResult = run(
    pcp,
    [stopExecutable, remoteStopExecutable],
    repository,
    env,
  );
  if (stopCopyResult.exitCode !== 0 &&
      !stopCopyResult.stderr.includes("already exists")) {
    throw new Error(
      `PocketJS Meizu M8: stop-helper copy failed: ${stopCopyResult.stderr}`,
    );
  }
  mustRun(
    prun,
    [`\\Program Files\\PocketJS\\${remoteStopFilename}`],
    repository,
    env,
  );
  const copyResult = run(pcp, [executable, remoteExecutable], repository, env);
  if (copyResult.exitCode !== 0 && !copyResult.stderr.includes("already exists")) {
    throw new Error(`PocketJS Meizu M8: remote copy failed: ${copyResult.stderr}`);
  }
  const iconCopyResult = run(pcp, [shellIcon, remoteIcon], repository, env);
  if (iconCopyResult.exitCode !== 0 &&
      !iconCopyResult.stderr.includes("already exists")) {
    throw new Error(`PocketJS Meizu M8: shell icon copy failed: ${iconCopyResult.stderr}`);
  }
  const shellKey = "SOFTWARE\\Meizu\\MiniOneShell\\Main\\PocketJS";
  const createShellKey = run(registry, ["-n", "HKLM", shellKey], repository, env);
  if (createShellKey.exitCode !== 0 &&
      !`${createShellKey.stdout}\n${createShellKey.stderr}`.includes("already exists")) {
    throw new Error(`PocketJS Meizu M8: shell registry key failed: ${createShellKey.stderr}`);
  }
  const shellValues = [
    ["sz", "DisplayName", "PocketJS"],
    ["sz", "ExecFileName", `\\Program Files\\PocketJS\\${remoteFilename}`],
    ["sz", "ProgramID", "{E785E2C6-7AC7-4041-9C3D-F49C8AB36374}"],
    ["sz", "DefaultIcon", `\\Program Files\\PocketJS\\${remoteIconFilename}`],
    ["dword", "Order", "1"],
    ["dword", "Page", "1"],
  ] as const;
  for (const [type, name, value] of shellValues) {
    mustRun(
      registry,
      ["-t", type, "-w", "HKLM", shellKey, name, value],
      repository,
      env,
    );
  }
  mustRun(
    prun,
    [`\\Program Files\\PocketJS\\${remoteFilename}`],
    repository,
    env,
  );
  console.log(`PocketJS Meizu M8: deployed, registered, and launched ${remoteExecutable}`);
}

function setupRapi(): void {
  mustRun("sh", [
    join(repository, "tools/meizu-m8/setup-synce-macos.sh"),
    cache,
    toolchain.rapi.repository,
    toolchain.rapi.revision,
  ]);
  console.log(`PocketJS Meizu M8: RAPI tools -> ${join(cache, "host/bin")}`);
}

function startSession(): void {
  const pty = Bun.argv[3];
  if (!pty) throw new Error("PocketJS Meizu M8: session requires /dev/ttysNNN");
  const result = Bun.spawnSync({
    cmd: [
      "sh",
      join(repository, "tools/meizu-m8/start-session-macos.sh"),
      pty,
      cache,
    ],
    cwd: repository,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`PocketJS Meizu M8: session exited ${result.exitCode}`);
  }
}

function readDeviceStatus(
  destination: string,
  buildId: string,
): Record<string, string> {
  rmSync(destination, { force: true });
  mustRun(synceTool("pcp"), [
    `:/Temp/pocketjs-meizu-m8-${buildId}.status`,
    destination,
  ], repository, synceEnvironment());
  const text = readFileSync(destination, "utf8");
  process.stdout.write(text);
  return Object.fromEntries(
    text.trim().split(/\r?\n/).map((line) => {
      const split = line.indexOf("=");
      return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)];
    }),
  );
}

function status(requireAction = false): void {
  const destination = join(nativeBuild, "device-status.txt");
  mkdirSync(nativeBuild, { recursive: true });
  const receipt = JSON.parse(
    readFileSync(join(outputDirectory, "build-receipt.json"), "utf8"),
  ) as {
    readonly buildId: string;
    readonly hostContract: {
      readonly viewport: {
        readonly logical: readonly [number, number];
        readonly physical: readonly [number, number];
      };
    };
  };
  const first = readDeviceStatus(destination, receipt.buildId);
  mustRun("/bin/sleep", ["2"]);
  const fields = readDeviceStatus(destination, receipt.buildId);
  if (fields.state !== "running" || fields.renderer !== "gdi-software") {
    throw new Error("PocketJS Meizu M8: device status is not a running GDI host");
  }
  if (fields.build_id !== receipt.buildId) {
    throw new Error("PocketJS Meizu M8: device is running a stale build");
  }
  if (fields.logical_viewport !== receipt.hostContract.viewport.logical.join("x") ||
      fields.physical_viewport !== receipt.hostContract.viewport.physical.join("x")) {
    throw new Error("PocketJS Meizu M8: device is not rendering the resolved viewport");
  }
  if (Number(fields.guest_frames) < 1 || Number(fields.gdi_composites) < 1) {
    throw new Error("PocketJS Meizu M8: guest frames have not reached the LCD compositor");
  }
  if (Number(fields.guest_frames) <= Number(first.guest_frames)) {
    throw new Error("PocketJS Meizu M8: device heartbeat is not advancing");
  }
  if (requireAction &&
      (fields.action_name !== "hero_tap" ||
       Number(fields.action_value) < 1 ||
       Number(fields.action_sequence) < 1 ||
       Number(fields.completed_touch_sequences) < 1)) {
    throw new Error("PocketJS Meizu M8: tap the Hero control before acceptance");
  }
}

function capture(): void {
  const destination = join(nativeBuild, "device-frame.bmp");
  const receipt = JSON.parse(
    readFileSync(join(outputDirectory, "build-receipt.json"), "utf8"),
  ) as {
    readonly buildId: string;
    readonly hostContract: {
      readonly viewport: { readonly physical: readonly [number, number] };
    };
  };
  mkdirSync(nativeBuild, { recursive: true });
  rmSync(destination, { force: true });
  mustRun(synceTool("pcp"), [
    `:/Temp/pocketjs-meizu-m8-${receipt.buildId}.frame.bmp`,
    destination,
  ], repository, synceEnvironment());
  const bytes = readFileSync(destination);
  const [expectedWidth, expectedHeight] = receipt.hostContract.viewport.physical;
  validateMeizuM8FramebufferBmp(bytes, expectedWidth, expectedHeight);
  console.log(`PocketJS Meizu M8: device framebuffer -> ${destination}`);
}

function doctor(): void {
  const quickJsRevision = existsSync(join(quickJsCheckout, ".git"))
    ? run("git", ["-C", quickJsCheckout, "rev-parse", "HEAD"])
    : undefined;
  const quickJsStatus = quickJsRevision?.exitCode === 0
    ? run("git", [
      "-C",
      quickJsCheckout,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])
    : undefined;
  const quickJsOk = quickJsRevision?.stdout.trim() ===
      toolchain.compiler.quickJsRevision &&
    quickJsStatus?.exitCode === 0 && quickJsStatus.stdout.trim() === "";
  const docker = commandPath("docker");
  const image = docker ? run(docker, ["image", "inspect", toolchain.compiler.image]) : undefined;
  const checks = [
    check("Docker", !!docker, docker ?? "install Docker"),
    check("pinned CeGCC image", image?.exitCode === 0, toolchain.compiler.image),
    check("libusb", run("pkg-config", ["--exists", "libusb-1.0"]).exitCode === 0, "libusb-1.0"),
    check("Rust nightly", run("rustup", ["run", toolchain.compiler.rustToolchain, "rustc", "--version"]).exitCode === 0, toolchain.compiler.rustToolchain),
    check("clean pinned QuickJS", quickJsOk, quickJsCheckout),
    check("SynCE RAPI", existsSync(join(cache, "host/bin/pcp")), join(cache, "host/bin")),
  ];
  console.log(`cache: ${cache}`);
  if (checks.some((ok) => !ok)) process.exitCode = 1;
}

function usage(): never {
  console.error(
    "usage: bun tools/meizu-m8.ts <doctor|build-demo|build-runtime|build|setup-rapi|usb-probe|usb-bridge|session /dev/ttysNNN|deploy|status|accept|capture>",
  );
  process.exit(2);
}

switch (command) {
  case "doctor":
    doctor();
    break;
  case "build-demo":
    buildDemo();
    break;
  case "build-runtime":
    buildRuntime();
    break;
  case "build":
    buildDemo();
    buildRuntime();
    break;
  case "setup-rapi":
    setupRapi();
    break;
  case "usb-probe":
    probeUsb();
    break;
  case "usb-bridge":
    bridgeUsb();
    break;
  case "session":
    startSession();
    break;
  case "deploy":
    deploy();
    break;
  case "status":
    status();
    break;
  case "accept":
    status(true);
    break;
  case "capture":
    capture();
    break;
  default:
    usage();
}
