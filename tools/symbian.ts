import { createHash } from "node:crypto";
import {
  createReadStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  deploySis,
  isExpectedMtpDevice,
  sanitizeDeviceOutput,
  type CommandResult,
  type CommandRunner,
} from "./symbian-device.ts";
import { setupSymbianToolchain } from "./symbian-bootstrap.ts";
import {
  symbianDataBaseForEmbeddedBytes,
  symbianPackageIdentity,
} from "./symbian-package.ts";
import { resolveSymbianE7BuildPlan } from "./symbian-profile.ts";
import {
  SYMBIAN_DOWNLOADS,
  SYMBIAN_RUNTIME_DOWNLOADS,
  SYMBIAN_TOOLCHAIN,
  inspectSymbianRustHost,
  symbianDockerDoctorArguments,
  symbianDockerRunArguments,
  symbianDownloadPath,
  symbianDownloadsRoot,
  symbianImplementationDigest,
  withSymbianGuestBuildLock,
  withSymbianRuntimeBuildLock,
} from "./symbian-toolchain.ts";
import { pocketStackCacheRoot, withArtifactLock } from "./psp-toolchain.ts";
import {
  assertSymbianMassStorageDataStageSeparation,
  resolveSymbianMassStorageDataRoot,
  stageSymbianMassStorageData,
} from "./symbian-data.ts";

const root = new URL("..", import.meta.url).pathname;

async function spawn(
  command: string,
  args: readonly string[],
  options: {
    timeoutMs?: number;
    inherit?: boolean;
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<CommandResult> {
  const process = Bun.spawn({
    cmd: [command, ...args],
    cwd: options.cwd,
    env: options.env,
    stdout: options.inherit ? "inherit" : "pipe",
    stderr: options.inherit ? "inherit" : "pipe",
  });
  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        process.kill();
      }, options.timeoutMs)
    : undefined;
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    options.inherit ? Promise.resolve("") : new Response(process.stdout).text(),
    options.inherit ? Promise.resolve("") : new Response(process.stderr).text(),
  ]);
  if (timer) clearTimeout(timer);
  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout,
    stderr: timedOut ? `${stderr}\ncommand timed out` : stderr,
  };
}

const mtpRunner: CommandRunner = (command, args, timeoutMs) =>
  spawn(command, args, { timeoutMs });

function icon(ok: boolean): string {
  return ok ? "✓" : "✗";
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function dockerImageReady(): Promise<boolean> {
  const implementation = symbianImplementationDigest(root);
  const result = await spawn("docker", [
    "image",
    "inspect",
    "--format",
    '{{index .Config.Labels "org.pocketjs.symbian.toolchain"}} {{index .Config.Labels "org.pocketjs.symbian.implementation"}}',
    SYMBIAN_TOOLCHAIN.container.image,
  ], { timeoutMs: 10_000 });
  return result.exitCode === 0 &&
    result.stdout.trim() ===
      `${SYMBIAN_TOOLCHAIN.toolchainVersion} ${implementation}`;
}

async function runCodaUsbProbe(
  executable?: string,
): Promise<CommandResult> {
  const compiler = Bun.which("cc");
  const pkgConfig = Bun.which("pkg-config");
  if (!compiler || !pkgConfig) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "cc and pkg-config are required for the CODA USB probe",
    };
  }

  const [includeDirectory, libraryDirectory] = await Promise.all([
    spawn(pkgConfig, ["--variable=includedir", "libusb-1.0"], {
      timeoutMs: 10_000,
    }),
    spawn(pkgConfig, ["--variable=libdir", "libusb-1.0"], {
      timeoutMs: 10_000,
    }),
  ]);
  if (includeDirectory.exitCode !== 0 || libraryDirectory.exitCode !== 0) {
    return {
      exitCode: includeDirectory.exitCode || libraryDirectory.exitCode,
      stdout: `${includeDirectory.stdout}${libraryDirectory.stdout}`,
      stderr: includeDirectory.stderr || libraryDirectory.stderr ||
        "libusb-1.0 development files are unavailable",
    };
  }
  const include = includeDirectory.stdout.trim();
  const library = libraryDirectory.stdout.trim();
  if (!include || !library) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "libusb-1.0 pkg-config paths are empty",
    };
  }

  const build = mkdtempSync(join(tmpdir(), "pocketjs-coda-usb-"));
  const binary = join(build, "coda-usb-probe");
  try {
    const compiled = await spawn(compiler, [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      join(include, "libusb-1.0"),
      join(root, "tools/symbian/coda-usb-probe.c"),
      "-L",
      library,
      "-lusb-1.0",
      "-o",
      binary,
    ], { timeoutMs: 30_000 });
    if (compiled.exitCode !== 0) return compiled;
    const lock = join(
      pocketStackCacheRoot(),
      "symbian/.locks/coda-usb-device.lock",
    );
    return await withArtifactLock(
      lock,
      () => spawn(
        binary,
        executable !== undefined ? ["launch", executable] : [],
        { timeoutMs: 45_000 },
      ),
      { timeoutMs: 45_000, staleMs: 2 * 60_000 },
    );
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}

async function doctor(
  deviceRequired: boolean,
  codaUsbRequired: boolean,
): Promise<boolean> {
  console.log(`PocketJS Symbian doctor (${SYMBIAN_TOOLCHAIN.toolchainVersion})\n`);
  let ok = true;
  const docker = !!Bun.which("docker");
  console.log(`  ${icon(docker)} Docker`);
  ok &&= docker;

  const rust = await inspectSymbianRustHost(
    (tool) => Bun.which(tool),
    (command, args) => spawn(command, args, { timeoutMs: 10_000 }),
  );
  console.log(
    `  ${icon(rust.rustup)} rustup${
      rust.rustup ? "" : " — install rustup and run setup --yes"
    }`,
  );
  console.log(
    `  ${icon(rust.pinnedToolchain)} Rust ${SYMBIAN_TOOLCHAIN.runtime.rustToolchain}${
      rust.pinnedToolchain ? "" : " — run setup --yes"
    }`,
  );
  console.log(
    `  ${icon(rust.cargo)} Cargo for ${SYMBIAN_TOOLCHAIN.runtime.rustToolchain}${
      rust.cargo ? "" : " — run setup --yes"
    }`,
  );
  console.log(
    `  ${icon(rust.rustSrc)} rust-src for ${SYMBIAN_TOOLCHAIN.runtime.rustToolchain}${
      rust.rustSrc ? "" : " — run setup --yes"
    }`,
  );
  ok &&= rust.rustup && rust.pinnedToolchain && rust.cargo && rust.rustSrc;

  for (const artifact of [...SYMBIAN_DOWNLOADS, ...SYMBIAN_RUNTIME_DOWNLOADS]) {
    const path = symbianDownloadPath(artifact);
    const verified = existsSync(path) && await sha256File(path) === artifact.sha256;
    console.log(
      `  ${icon(verified)} ${artifact.asset}${verified ? "" : " — run setup --yes"}`,
    );
    ok &&= verified;
  }

  const image = docker && await dockerImageReady();
  console.log(`  ${icon(image)} ${SYMBIAN_TOOLCHAIN.container.image}`);
  ok &&= image;
  if (image) {
    const toolchain = await spawn("docker", symbianDockerDoctorArguments(root), {
      timeoutMs: 120_000,
    });
    const ready = toolchain.exitCode === 0;
    console.log(`  ${icon(ready)} native qmake + GCCE + EKA2 package tools`);
    if (!ready) {
      const detail = sanitizeDeviceOutput(toolchain.stderr || toolchain.stdout).trim();
      if (detail) console.log(`      ${detail.split(/\r?\n/)[0]}`);
    }
    ok &&= ready;
  }

  const mtpTools = ["mtp-folders", "mtp-sendfile", "mtp-getfile"]
    .every((tool) => !!Bun.which(tool));
  console.log(
    `  ${icon(mtpTools)} libmtp host tools${mtpTools ? "" : " — brew install libmtp"}`,
  );
  if (deviceRequired) ok &&= mtpTools;

  if (deviceRequired && mtpTools) {
    const folders = await spawn("mtp-folders", [], { timeoutMs: 20_000 });
    const connected = folders.exitCode === 0 && isExpectedMtpDevice(
      `${folders.stdout}\n${folders.stderr}`,
      {
        vendorId: SYMBIAN_TOOLCHAIN.device.usbVendorId,
        productId: SYMBIAN_TOOLCHAIN.device.usbProductId,
        name: SYMBIAN_TOOLCHAIN.device.mtpName,
      },
    );
    console.log(`  ${icon(connected)} Nokia E7 in Nokia Suite / Ovi MTP mode`);
    ok &&= connected;
  }

  if (codaUsbRequired) {
    const coda = await runCodaUsbProbe();
    const output = sanitizeDeviceOutput(coda.stdout);
    const connected = coda.exitCode === 0 &&
      output.includes("CODA USB: ready") &&
      output.includes("CODA Locator: ready");
    console.log(`  ${icon(connected)} CODA USB ping + Locator handshake`);
    const version = output.match(/^CODA version:\s*(.+)$/m)?.[1];
    if (connected && version) console.log(`      ${version}`);
    if (!connected) {
      const detail = sanitizeDeviceOutput(coda.stderr || coda.stdout).trim();
      if (detail) console.log(`      ${detail.split(/\r?\n/)[0]}`);
    }
    ok &&= connected;
  }
  return ok;
}

async function buildProbe(): Promise<string> {
  if (!await dockerImageReady()) {
    throw new Error("Symbian container is not ready; run `pocket symbian setup --yes`");
  }
  const output = resolve(root, "dist/symbian");
  mkdirSync(output, { recursive: true });
  const outputLockId = createHash("sha256").update(output).digest("hex");
  const outputLock = join(
    pocketStackCacheRoot(),
    `symbian/.locks/probe-output-${outputLockId}.lock`,
  );
  await withArtifactLock(outputLock, async () => {
    const built = await spawn("docker", symbianDockerRunArguments(
      "/usr/local/bin/pocketjs-symbian-build-probe",
      [],
      { repository: root, output },
    ), { inherit: true, cwd: root });
    if (built.exitCode !== 0) throw new Error("Symbian probe build failed");
  }, { timeoutMs: 10 * 60_000, staleMs: 30 * 60_000 });
  const sis = resolve(root, SYMBIAN_TOOLCHAIN.probe.output);
  if (!existsSync(sis)) throw new Error(`probe build did not produce ${sis}`);
  return sis;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export interface SymbianBuildTransaction {
  readonly outputRoot: string;
}

export interface SymbianBuildAppOptions {
  /** Opt-in, bounded on-device frame trace. Omitted from release builds. */
  perfTrace?: boolean;
  /** Presentation rate; the fixed 60 Hz core must divide into whole ticks. */
  frameRate?: number;
  projectRoot?: string;
  outputRoot?: string;
  uid?: string;
  catalogIndex?: string;
  catalogBlob?: string;
  /**
   * Prebuilt application-specific core that implements the ordinary
   * `ui_*` ABI and may additionally export the native extension provider.
   * The exact archive is copied into the locked payload and covered by the
   * existing receipt `sha256.core` field.
   */
  coreLibrary?: string;
  /**
   * Host directory recursively installed on mass storage for an
   * application-specific core. Files are staged and hashed inside the build
   * transaction; stock cores cannot request this native-only boundary.
   */
  massStorageDataRoot?: string;
  transaction?: SymbianBuildTransaction;
}

const activeBuildTransactions = new WeakSet<object>();

export async function withSymbianBuildTransaction<T>(
  outputRoot: string,
  operation: (transaction: SymbianBuildTransaction) => Promise<T>,
): Promise<T> {
  const output = resolve(outputRoot);
  return await withSymbianRuntimeBuildLock(output, async () => {
    const transaction = Object.freeze({ outputRoot: output });
    activeBuildTransactions.add(transaction);
    try {
      return await operation(transaction);
    } finally {
      activeBuildTransactions.delete(transaction);
    }
  });
}

export async function buildApp(
  manifestPath: string,
  sisVersion: string,
  options: SymbianBuildAppOptions = {},
): Promise<string> {
  const frameRate = options.frameRate ?? SYMBIAN_TOOLCHAIN.runtime.frameRate;
  if (!Number.isInteger(frameRate) || frameRate <= 0 || 60 % frameRate !== 0) {
    throw new Error("Symbian frame rate must be a positive integer divisor of 60");
  }
  const version = sisVersion.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)$/);
  if (!version || version.slice(1).some((part) => Number(part) > 32767)) {
    throw new Error(
      "SIS version must be three decimal components from 0 through 32767",
    );
  }
  if (!await dockerImageReady()) {
    throw new Error("Symbian container is not ready; run `pocket symbian setup --yes`");
  }
  for (const artifact of SYMBIAN_RUNTIME_DOWNLOADS) {
    const path = symbianDownloadPath(artifact);
    if (!existsSync(path) || await sha256File(path) !== artifact.sha256) {
      throw new Error(
        `missing pinned ${artifact.asset}; run \`pocket symbian setup --yes\``,
      );
    }
  }
  const rustHost = await inspectSymbianRustHost(
    (tool) => Bun.which(tool),
    (command, args) => spawn(command, args, { timeoutMs: 10_000 }),
  );
  if (
    !rustHost.cargo ||
    !rustHost.rustup ||
    !rustHost.pinnedToolchain ||
    !rustHost.rustSrc ||
    !rustHost.rustupPath ||
    !rustHost.toolchainName
  ) {
    throw new Error(
      `Rust ${SYMBIAN_TOOLCHAIN.runtime.rustToolchain} with rust-src is not ready; run \`pocket symbian setup --yes\``,
    );
  }

  const absoluteManifest = resolve(manifestPath);
  const manifest = JSON.parse(readFileSync(absoluteManifest, "utf8")) as unknown;
  const plan = resolveSymbianE7BuildPlan(manifest);
  const packageIdentity = symbianPackageIdentity(plan, options.uid);
  const manifestRelativeToPocketJs = relative(root, absoluteManifest);
  const defaultProjectRoot =
    manifestRelativeToPocketJs !== ".." &&
      !manifestRelativeToPocketJs.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(manifestRelativeToPocketJs)
      ? root
      : dirname(absoluteManifest);
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot);
  const manifestRelativeToProject = relative(projectRoot, absoluteManifest);
  if (
    manifestRelativeToProject === ".." ||
    manifestRelativeToProject.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(manifestRelativeToProject)
  ) {
    throw new Error(
      `Symbian manifest ${absoluteManifest} is outside project root ${projectRoot}`,
    );
  }
  const entry = resolve(projectRoot, plan.app.entry);
  const entryRelativeToProject = relative(projectRoot, entry);
  if (
    entryRelativeToProject === ".." ||
    entryRelativeToProject.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(entryRelativeToProject) ||
    !existsSync(entry)
  ) {
    throw new Error(
      `Symbian app entry ${plan.app.entry} is missing or outside project root ${projectRoot}`,
    );
  }

  const outputRoot = resolve(
    options.outputRoot ?? resolve(projectRoot, "dist/symbian"),
  );
  const customCoreLibrary = options.coreLibrary === undefined
    ? undefined
    : resolve(options.coreLibrary);
  if (
    customCoreLibrary !== undefined &&
    (!existsSync(customCoreLibrary) ||
      !statSync(customCoreLibrary).isFile() ||
      statSync(customCoreLibrary).size === 0)
  ) {
    throw new Error(
      `Symbian custom core library is missing or empty: ${customCoreLibrary}`,
    );
  }
  const massStorageDataRoot = resolveSymbianMassStorageDataRoot(
    options.massStorageDataRoot,
    customCoreLibrary,
  );
  if ((options.catalogIndex === undefined) !== (options.catalogBlob === undefined)) {
    throw new Error(
      "Symbian app catalog requires both --catalog-index and --catalog-blob",
    );
  }
  if (customCoreLibrary !== undefined && options.catalogIndex !== undefined) {
    throw new Error(
      "Symbian application-specific cores cannot be combined with a multi-app catalog",
    );
  }
  const catalogIndex = options.catalogIndex === undefined
    ? undefined
    : resolve(options.catalogIndex);
  const catalogBlob = options.catalogBlob === undefined
    ? undefined
    : resolve(options.catalogBlob);
  for (const [label, path] of [
    ["catalog index", catalogIndex],
    ["catalog blob", catalogBlob],
  ] as const) {
    if (path !== undefined && (!existsSync(path) || !statSync(path).isFile() ||
      statSync(path).size === 0)) {
      throw new Error(`Symbian ${label} is missing or empty: ${path}`);
    }
  }
  const payload = resolve(outputRoot, "build", plan.app.output);
  if (massStorageDataRoot !== undefined) {
    assertSymbianMassStorageDataStageSeparation(massStorageDataRoot, payload);
  }
  const rustTarget = resolve(outputRoot, ".cargo-symbian");
  const transaction = async () => {
    rmSync(payload, { recursive: true, force: true });
    mkdirSync(payload, { recursive: true });
    if (massStorageDataRoot !== undefined) {
      stageSymbianMassStorageData(massStorageDataRoot, payload);
    }
    await Bun.write(
      resolve(payload, "plan.json"),
      JSON.stringify(plan, null, 2) + "\n",
    );
    await Bun.write(
      resolve(payload, "package.json"),
      JSON.stringify(packageIdentity, null, 2) + "\n",
    );

    await withSymbianGuestBuildLock(async () => {
      const appBuild = await spawn("bun", [
        "tools/build.ts",
        `--plan=${resolve(payload, "plan.json")}`,
        `--project-root=${projectRoot}`,
        `--outdir=${payload}`,
      ], { inherit: true, cwd: root });
      if (appBuild.exitCode !== 0) {
        throw new Error("PocketJS Symbian guest build failed");
      }
      copyFileSync(resolve(payload, `${plan.app.output}.js`), resolve(payload, "app.js"));
      copyFileSync(resolve(payload, `${plan.app.output}.pak`), resolve(payload, "app.pak"));
    });
    if (catalogIndex !== undefined && catalogBlob !== undefined) {
      copyFileSync(catalogIndex, resolve(payload, "catalog.tsv"));
      copyFileSync(catalogBlob, resolve(payload, "catalog.bin"));
    }
    const embeddedPaths = [
      resolve(payload, "app.js"),
      resolve(payload, "app.pak"),
      ...(catalogIndex !== undefined
        ? [resolve(payload, "catalog.tsv"), resolve(payload, "catalog.bin")]
        : []),
    ];
    const embeddedBytes = embeddedPaths.reduce(
      (total, path) => total + statSync(path).size,
      0,
    );
    const dataBase = symbianDataBaseForEmbeddedBytes(embeddedBytes);

    if (customCoreLibrary !== undefined) {
      copyFileSync(
        customCoreLibrary,
        resolve(payload, "libpocketjs_symbian_core.a"),
      );
    } else {
      const coreDirectory = resolve(root, "engine/ui-cabi");
      const rustBuild = await spawn(rustHost.rustupPath!, [
        "run",
        rustHost.toolchainName!,
        "cargo",
        "build",
        "--release",
        "--locked",
        "--config",
        "profile.release.opt-level=3",
        "--target",
        resolve(root, "hosts/nokia-e7/targets/armv6-symbian-eabi.json"),
        "-Z",
        "json-target-spec",
        "-Z",
        "build-std=core,alloc,compiler_builtins",
        "-Z",
        "build-std-features=compiler-builtins-mem",
      ], {
        inherit: true,
        cwd: coreDirectory,
        env: { ...process.env, CARGO_TARGET_DIR: rustTarget },
      });
      if (rustBuild.exitCode !== 0) {
        throw new Error("PocketJS Symbian Rust core build failed");
      }
      copyFileSync(
        resolve(
          rustTarget,
          "armv6-symbian-eabi/release/libpocketjs_symbian_core.a",
        ),
        resolve(payload, "libpocketjs_symbian_core.a"),
      );
    }

    const built = await spawn("docker", symbianDockerRunArguments(
      "/usr/local/bin/pocketjs-symbian-build-app",
      [
        plan.app.output,
        sisVersion,
        dataBase,
        String(embeddedBytes),
        String(frameRate),
        options.perfTrace ? "1" : "0",
      ],
      {
        repository: root,
        output: outputRoot,
        downloads: symbianDownloadsRoot(),
      },
    ), { inherit: true, cwd: root });
    if (built.exitCode !== 0) throw new Error("Symbian PocketJS runtime build failed");

    const sis = resolve(outputRoot, packageIdentity.sisFile);
    if (!existsSync(sis)) throw new Error(`runtime build did not produce ${sis}`);
    return sis;
  };
  if (options.transaction !== undefined) {
    if (
      !activeBuildTransactions.has(options.transaction) ||
      options.transaction.outputRoot !== outputRoot
    ) {
      throw new Error("invalid or inactive Symbian build transaction");
    }
    return await transaction();
  }
  return await withSymbianRuntimeBuildLock(outputRoot, transaction);
}

async function deploy(path: string): Promise<void> {
  const sis = resolve(path);
  const missing = ["mtp-folders", "mtp-sendfile", "mtp-getfile"]
    .filter((tool) => !Bun.which(tool));
  if (missing.length > 0) {
    throw new Error(`missing ${missing.join(", ")}; install with \`brew install libmtp\``);
  }
  const lock = join(pocketStackCacheRoot(), "symbian/.locks/mtp-device.lock");
  const result = await withArtifactLock(lock, () => deploySis(sis, mtpRunner, {
    storage: SYMBIAN_TOOLCHAIN.device.deployStorage,
    folder: SYMBIAN_TOOLCHAIN.device.deployFolder,
    vendorId: SYMBIAN_TOOLCHAIN.device.usbVendorId,
    productId: SYMBIAN_TOOLCHAIN.device.usbProductId,
    deviceName: SYMBIAN_TOOLCHAIN.device.mtpName,
    timeoutMs: 45_000,
  }), { timeoutMs: 2 * 60_000, staleMs: 5 * 60_000 });
  console.log(`PocketJS Symbian deploy verified`);
  console.log(`  file: ${result.localName}`);
  console.log(`  destination: ${SYMBIAN_TOOLCHAIN.device.deployStorage}/${SYMBIAN_TOOLCHAIN.device.deployFolder}`);
  console.log(`  SHA-256: ${result.sha256}`);
  console.log("  copied and read back byte-for-byte; installation still requires confirmation on the E7");
}

const HELP = `PocketJS Nokia E7 / Symbian toolchain

  pocket symbian doctor [--device]  inspect the isolated build chain and optional USB device
  pocket symbian doctor --coda-usb  verify CODA over the E7 USB interface 4
  pocket symbian setup --yes        fetch pinned SDK inputs and build the amd64 toolchain
  pocket symbian build probe        build and self-sign the visible Qt probe SIS
  pocket symbian build app --manifest <pocket.json> [--sis-version 1.0.0]
                           [--project-root <dir>] [--outdir <dir>] [--uid 0xE.......]
                           [--catalog-index <catalog.tsv> --catalog-blob <catalog.bin>]
                           [--core-library <application-core.a>]
                           [--mass-storage-data-root <dir>]
                           [--frame-rate 30] [--perf-trace]
                                    build an independently installable PocketJS E7 SIS
  pocket symbian deploy <sis>       copy to Mass memory/Installs and verify by MTP readback
  pocket symbian coda usb           run the CODA USB ping + Locator handshake
  pocket symbian coda usb launch <executable.exe>
                                    remotely launch an installed app from its receipt
`;

export async function symbianMain(
  args: readonly string[] = Bun.argv.slice(2),
): Promise<void> {
  const command = args[0] ?? "help";
  try {
    switch (command) {
    case "doctor":
      if (!await doctor(
        args.includes("--device"),
        args.includes("--coda-usb"),
      )) process.exitCode = 1;
      break;
    case "setup":
      if (!args.includes("--yes")) {
        throw new Error(
          "setup downloads archived Nokia SDK material for local development; re-run with --yes",
        );
      }
      await setupSymbianToolchain();
      break;
    case "build":
      if (args[1] === "probe") {
        console.log(`PocketJS Symbian probe: ${await buildProbe()}`);
        break;
      }
      if (args[1] === "app") {
        const manifest = flagValue(args.slice(2), "--manifest");
        if (!manifest) {
          throw new Error(
            "usage: pocket symbian build app --manifest <pocket.json> [--sis-version 1.0.0] [--core-library <lib.a>] [--mass-storage-data-root <dir>]",
          );
        }
        const sisVersion = flagValue(args.slice(2), "--sis-version") ??
          SYMBIAN_TOOLCHAIN.runtime.sisVersion;
        console.log(`PocketJS Symbian runtime: ${await buildApp(
          manifest,
          sisVersion,
          {
            projectRoot: flagValue(args.slice(2), "--project-root"),
            perfTrace: args.includes("--perf-trace"),
            frameRate: flagValue(args, "--frame-rate") === undefined
              ? undefined : Number(flagValue(args, "--frame-rate")),
            outputRoot: flagValue(args.slice(2), "--outdir"),
            uid: flagValue(args.slice(2), "--uid"),
            catalogIndex: flagValue(args.slice(2), "--catalog-index"),
            catalogBlob: flagValue(args.slice(2), "--catalog-blob"),
            coreLibrary: flagValue(args.slice(2), "--core-library"),
            massStorageDataRoot: flagValue(
              args.slice(2),
              "--mass-storage-data-root",
            ),
          },
        )}`);
        break;
      }
      throw new Error(
        "usage: pocket symbian build probe | build app --manifest <pocket.json> [--core-library <lib.a>] [--mass-storage-data-root <dir>]",
      );
    case "deploy":
      if (!args[1]) throw new Error("usage: pocket symbian deploy <path-to.sis>");
      await deploy(args[1]);
      break;
    case "coda": {
      if (args[1] !== "usb") throw new Error("usage: pocket symbian coda usb");
      const action = args[2];
      if (action !== undefined && action !== "launch") {
        throw new Error(
          "usage: pocket symbian coda usb [launch [executable.exe]]",
        );
      }
      if (args.length > (action === "launch" ? 4 : 2)) {
        throw new Error(
          "usage: pocket symbian coda usb [launch [executable.exe]]",
        );
      }
      const launchRequested = action === "launch";
      const executable = launchRequested
        ? args[3]
        : undefined;
      if (launchRequested && !executable) {
        throw new Error(
          "usage: pocket symbian coda usb launch <executable.exe>",
        );
      }
      const coda = await runCodaUsbProbe(executable);
      if (coda.stdout) process.stdout.write(sanitizeDeviceOutput(coda.stdout));
      if (coda.stderr) process.stderr.write(sanitizeDeviceOutput(coda.stderr));
      if (coda.exitCode !== 0) {
        throw new Error(
          launchRequested
            ? "CODA USB launch failed"
            : "CODA USB handshake failed",
        );
      }
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(HELP);
      throw new Error(`unknown Symbian command ${JSON.stringify(command)}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await symbianMain();
}
