import { repositoryPath } from "./repository.ts";
import type { RuntimeApplication } from "../framework/src/runtime-config.ts";
import { applicationBundle, runProgramBuild } from "./build/programs/application.ts";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { writeHostProfileHeader } from "../tools/host-profile.ts";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  IPHONE2G_TOOLCHAIN,
  inspectIPhone2GToolchain,
  iphone2gCacheRoot,
  iphone2gCsuPath,
  iphone2gLegacyKitPath,
  iphone2gQuickJsPath,
  iphone2gRamdiskPath,
  iphone2gSysrootPath,
  sha256File,
} from "./build/toolchains/iphone2g.ts";
import {
  IPHONE2G_DEV_TARGET_ID,
  resolveIPhone2GBuildPlan,
} from "./iphone2g-profile.ts";
import {
  extractHostBuildInputs,
  type HostBuildInputs,
} from "../framework/src/manifest/host-build-inputs.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const command = Bun.argv[2] ?? "doctor";

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

function run(
  executable: string,
  args: readonly string[],
  cwd = repository,
  env: NodeJS.ProcessEnv = process.env,
): CommandResult {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.success ? 0 : result.exitCode || 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runBinary(
  executable: string,
  args: readonly string[],
  input?: Uint8Array,
  cwd = repository,
  env: NodeJS.ProcessEnv = process.env,
): BinaryCommandResult {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    cwd,
    env,
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.success ? 0 : result.exitCode || 1,
    stdout: Buffer.from(result.stdout),
    stderr: result.stderr.toString(),
  };
}

function mustRun(
  executable: string,
  args: readonly string[],
  cwd = repository,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = run(executable, args, cwd, env);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${executable} ${args.join(" ")} failed (${result.exitCode})${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function xcrunFind(tool: string): string | undefined {
  const result = run("xcrun", ["--find", tool]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

function commandPath(tool: string): string | undefined {
  const result = run("/usr/bin/which", [tool]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

function check(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "[ok]" : "[missing]"} ${label}: ${detail}`);
  return ok;
}

function doctor(): void {
  const status = inspectIPhone2GToolchain();
  const clang = xcrunFind("clang");
  const linker = xcrunFind(IPHONE2G_TOOLCHAIN.compiler.linker);
  const rustup = commandPath("rustup");
  const rustc = rustup
    ? run(rustup, [
        "which",
        "--toolchain",
        IPHONE2G_TOOLCHAIN.compiler.rustToolchain,
        "rustc",
      ])
    : undefined;
  const ldid = commandPath("ldid");
  const checks = [
    check("Xcode clang", !!clang, clang || "install/select Xcode"),
    check(
      "classic linker",
      !!linker,
      linker || "Xcode no longer provides ld-classic",
    ),
    check(
      "stock 4A102 firmware",
      status.firmware,
      join(status.cacheRoot, "downloads"),
    ),
    check(
      "decrypted root filesystem",
      status.rootFilesystem,
      join(status.cacheRoot, "sysroot-1.1.4"),
    ),
    check("read-only-derived sysroot", status.sysroot, iphone2gSysrootPath()),
    check("Apple Csu-76", status.csu, iphone2gCsuPath()),
    check("pinned QuickJS", status.quickjs, iphone2gQuickJsPath()),
    check("pinned Legacy-iOS-Kit", status.legacyKit, iphone2gLegacyKitPath()),
    check("verified SSH ramdisk", status.ramdisk, iphone2gRamdiskPath()),
    check(
      `Rust ${IPHONE2G_TOOLCHAIN.compiler.rustToolchain}`,
      rustc?.exitCode === 0,
      rustc?.stdout.trim() || "install the pinned nightly with rustup",
    ),
    check(
      "OpenSSH 4.7p1 package",
      status.openssh,
      join(status.cacheRoot, "downloads/bootstrap"),
    ),
    check(
      "OpenSSL 0.9.8g package",
      status.openssl,
      join(status.cacheRoot, "downloads/bootstrap"),
    ),
  ];
  checks.push(
    check(
      "ldid signing",
      !!ldid,
      ldid || "install ldid before building 3.1.3 executables",
    ),
  );
  console.log(`cache: ${status.cacheRoot}`);
  if (checks.some((ok) => !ok)) process.exitCode = 1;
}

function ensureQuickJs(): void {
  const destination = iphone2gQuickJsPath();
  const compiler = IPHONE2G_TOOLCHAIN.compiler;
  if (inspectIPhone2GToolchain().quickjs) return;
  if (existsSync(destination)) {
    throw new Error(
      `refusing to replace an unverified QuickJS directory: ${destination}`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  mustRun("git", [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    compiler.quickJsRepository,
    destination,
  ]);
  mustRun("git", [
    "-C",
    destination,
    "checkout",
    "--detach",
    compiler.quickJsRevision,
  ]);
  const revision = mustRun("git", ["-C", destination, "rev-parse", "HEAD"]);
  const versionPath = join(destination, "libquickjs-sys/embed/quickjs/VERSION");
  const version = existsSync(versionPath)
    ? readFileSync(versionPath, "utf8").trim()
    : "";
  if (
    revision !== compiler.quickJsRevision ||
    version !== compiler.quickJsVersion ||
    !inspectIPhone2GToolchain().quickjs
  ) {
    throw new Error(`QuickJS verification failed at ${destination}`);
  }
}

function ensureSources(): void {
  ensureCsu();
  ensureQuickJs();
  ensureLegacyKit();
}

function ensureLegacyKit(): void {
  const destination = iphone2gLegacyKitPath();
  const manifest = IPHONE2G_TOOLCHAIN.ramdisk;
  if (inspectIPhone2GToolchain().legacyKit) return;
  if (existsSync(destination)) {
    throw new Error(
      `refusing to replace an unverified Legacy-iOS-Kit directory: ${destination}`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  mustRun("git", [
    "clone",
    "--filter=blob:none",
    "--no-checkout",
    manifest.repository,
    destination,
  ]);
  mustRun("git", [
    "-C",
    destination,
    "checkout",
    "--detach",
    manifest.revision,
  ]);
  const revision = mustRun("git", ["-C", destination, "rev-parse", "HEAD"]);
  if (revision !== manifest.revision || !inspectIPhone2GToolchain().legacyKit) {
    throw new Error(`Legacy-iOS-Kit verification failed at ${destination}`);
  }
}

function ensureCsu(): void {
  const destination = iphone2gCsuPath();
  const manifest = IPHONE2G_TOOLCHAIN.compiler.csu;
  if (inspectIPhone2GToolchain().csu) return;
  if (existsSync(destination)) {
    throw new Error(
      `refusing to replace an unverified Csu directory: ${destination}`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  mustRun("git", [
    "clone",
    "--filter=blob:none",
    "--branch",
    manifest.tag,
    "--single-branch",
    manifest.repository,
    destination,
  ]);
  const revision = mustRun("git", ["-C", destination, "rev-parse", "HEAD"]);
  if (revision !== manifest.revision || !inspectIPhone2GToolchain().csu) {
    throw new Error(`Apple Csu verification failed at ${destination}`);
  }
}

export interface IPhone2GGuestArtifacts {
  readonly inputs: HostBuildInputs;
  readonly javaScript: string;
  readonly pack: string;
}

export function deriveIPhone2GGuestArtifacts(
  plan: unknown,
  outputDirectory: string,
): IPhone2GGuestArtifacts {
  const inputs = extractHostBuildInputs(plan, {
    expectedTarget: IPHONE2G_DEV_TARGET_ID,
  });
  return {
    inputs,
    javaScript: join(outputDirectory, `${inputs.appOutput}.js`),
    pack: join(outputDirectory, `${inputs.appOutput}.pak`),
  };
}

/** Apps admitted to the iPhone 2G flow and the action each one reports for
 *  the on-glass acceptance receipt. Selected via POCKETJS_IPHONE2G_APP
 *  (default: the demo). */
const IPHONE2G_APP_ACTIONS: Record<string, string> = {
  "iphone2g-demo": "hero_tap",
  clear: "clear_gesture",
};

function iphone2gAppName(): string {
  const app = process.env.POCKETJS_IPHONE2G_APP?.trim() || "iphone2g-demo";
  if (!(app in IPHONE2G_APP_ACTIONS)) {
    throw new Error(
      `PocketJS iPhone 2G: unknown app '${app}' (POCKETJS_IPHONE2G_APP accepts: ${Object.keys(IPHONE2G_APP_ACTIONS).join(", ")})`,
    );
  }
  return app;
}

function iphone2gExpectedAction(): string {
  return IPHONE2G_APP_ACTIONS[iphone2gAppName()];
}

function iphone2gManifestPath(): string {
  return join(repository, `apps/${iphone2gAppName()}/pocket.json`);
}

function iphone2gPlanPath(): string {
  return join(repository, `.pocket/iphone2g/${iphone2gAppName()}.plan.json`);
}

function iphone2gGuestOutputDirectory(): string {
  return join(repository, "dist/iphone2g/guest");
}

function currentIPhone2GBuildPlan() {
  return resolveIPhone2GBuildPlan(
    JSON.parse(readFileSync(iphone2gManifestPath(), "utf8")),
  );
}


function buildDemo(): void {
  const plan = currentIPhone2GBuildPlan();
  const planPath = iphone2gPlanPath();
  const output = iphone2gGuestOutputDirectory();
  mkdirSync(dirname(planPath), { recursive: true });
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  mustRun(process.execPath, [
    join(repository, "tools/build.ts"),
    `--plan=${planPath}`,
    `--project-root=${repository}`,
    `--outdir=${output}`,
  ]);
  const artifacts = deriveIPhone2GGuestArtifacts(plan, output);
  if (!existsSync(artifacts.javaScript) || !existsSync(artifacts.pack)) {
    throw new Error(
      `PocketJS iPhone 2G: build did not produce ${artifacts.inputs.appOutput}.{js,pak}`,
    );
  }
  console.log(`PocketJS iPhone 2G: guest bundle -> ${output}`);
}

export function buildIPhone2GNative(application: RuntimeApplication, outdir: string): void {
  const guestArtifacts = applicationBundle(application, IPHONE2G_DEV_TARGET_ID);
  const status = inspectIPhone2GToolchain();
  if (!status.sysroot || !status.csu || !status.quickjs) {
    throw new Error(
      "PocketJS iPhone 2G: run `bun tools/iphone2g.ts doctor` and provide the verified sysroot/sources first",
    );
  }

  const clang = xcrunFind("clang");
  const linker = xcrunFind(IPHONE2G_TOOLCHAIN.compiler.linker);
  if (!clang || !linker)
    throw new Error(
      "PocketJS iPhone 2G: Xcode clang/ld-classic is unavailable",
    );
  const macosSdkPath = mustRun("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const hostTools = {
    xcode: mustRun("xcodebuild", ["-version"]),
    clang: mustRun(clang, ["--version"]),
    classicLinker: linker,
    macosSdkPath,
    macosSdkVersion: mustRun("xcrun", [
      "--sdk",
      "macosx",
      "--show-sdk-version",
    ]),
  };

  const sysroot = iphone2gSysrootPath();
  const csu = iphone2gCsuPath();
  const quickjs = join(iphone2gQuickJsPath(), "libquickjs-sys/embed/quickjs");
  const build = join(repository, ".pocket-build/iphone2g/runtime");
  // Building core/alloc/compiler_builtins for this custom ARMv6 target is the
  // slow part of the toolchain. Keep Cargo's target directory outside the
  // disposable native-object directory so subsequent demo builds reuse it.
  const rustTarget = join(iphone2gCacheRoot(), "build/rust-target");
  const bundle = join(outdir, "PocketJSDemo.app");
  const { inputs: hostInputs } = guestArtifacts;
  const guestJavaScript = guestArtifacts.javaScript;
  const guestPack = guestArtifacts.pack;
  if (!existsSync(guestJavaScript) || !existsSync(guestPack)) {
    throw new Error(
      "PocketJS iPhone 2G: compiled package payload is absent; pass a current --pocket input",
    );
  }
  // This nonce binds a device acceptance record to one concrete deployment,
  // including rebuilds whose guest bytes happen to be unchanged.
  const buildId = randomBytes(16).toString("hex");
  rmSync(build, { recursive: true, force: true });
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  mkdirSync(rustTarget, { recursive: true });
  mkdirSync(bundle, { recursive: true });

  const common = [
    "-target",
    IPHONE2G_TOOLCHAIN.compiler.target,
    `-miphoneos-version-min=${IPHONE2G_TOOLCHAIN.compiler.minimumVersion}`,
    "-march=armv6",
    "-Os",
    "-fno-stack-protector",
    "-fno-builtin",
    "-fno-common",
    "-fwrapv",
    "-funsigned-char",
    "-U_FORTIFY_SOURCE",
    "-D_FORTIFY_SOURCE=0",
    "-isysroot",
    macosSdkPath,
  ];
  const compile = (
    source: string,
    output: string,
    extra: readonly string[] = [],
  ) => {
    mustRun(clang, [...common, ...extra, "-c", source, "-o", output]);
  };
  const firstPartyWarnings = [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wno-incompatible-sysroot",
  ];
  compile(join(csu, "start.s"), join(build, "csu-start.o"), [
    "-x",
    "assembler-with-cpp",
  ]);
  compile(join(csu, "dyld_glue.s"), join(build, "csu-dyld-glue.o"), [
    "-x",
    "assembler-with-cpp",
    "-DMACH_HEADER_SYMBOL_NAME=__mh_execute_header",
    "-DCRT",
  ]);
  compile(
    join(repository, "programs/shared/ios-legacy/crt_globals.c"),
    join(build, "crt_globals.o"),
    firstPartyWarnings,
  );
  compile(
    join(repository, "programs/shared/ios-legacy/runtime.c"),
    join(build, "runtime.o"),
    [
      ...firstPartyWarnings,
      "-include", writeHostProfileHeader(build, hostInputs.profile),
      `-DPOCKET_BUILD_ID="${buildId}"`,
      `-DPOCKET_LOGICAL_WIDTH=${hostInputs.viewport.logical[0]}`,
      `-DPOCKET_LOGICAL_HEIGHT=${hostInputs.viewport.logical[1]}`,
      "-I",
      join(repository, "programs/native/quickjs"),
      "-Wno-cast-function-type-mismatch",
    ],
  );
  compile(
    join(repository, "programs/native/quickjs/pocket_runtime.c"),
    join(build, "pocket_runtime.o"),
    [
      ...firstPartyWarnings,
      "-include", writeHostProfileHeader(build, hostInputs.profile),
      `-DPOCKETJS_TARGET_ID="${hostInputs.target}"`,
      `-DPOCKETJS_HOST_ABI=${hostInputs.hostAbi}`,
      "-I",
      join(repository, "programs/native/cabi/include"),
      "-I", join(repository, "engine/guest-quickjs/include"),
      "-I",
      join(repository, "contracts/generated"),
      "-isystem",
      quickjs,
    ],
  );
  compile(
    join(repository, "programs/shared/ios-legacy/compat.c"),
    join(build, "compat.o"),
    firstPartyWarnings,
  );

  compile(join(repository, "engine/guest-quickjs/src/guest.c"), join(build, "pocket_guest_quickjs.o"), [
    ...firstPartyWarnings, "-I", join(repository, "engine/guest-quickjs/include"),
    "-I", join(repository, "contracts/generated"), "-isystem", quickjs,
  ]);
  const quickJsObjects: string[] = [];
  for (const source of [
    "quickjs.c",
    "cutils.c",
    "dtoa.c",
    "libregexp.c",
    "libunicode.c",
  ]) {
    const object = join(build, `quickjs-${source.replace(/\.c$/, "")}.o`);
    compile(join(quickjs, source), object, [
      "-I",
      quickjs,
      `-DCONFIG_VERSION=\"${IPHONE2G_TOOLCHAIN.compiler.quickJsVersion}\"`,
    ]);
    quickJsObjects.push(object);
  }

  const rustup = commandPath("rustup");
  if (!rustup) throw new Error("PocketJS iPhone 2G: rustup is unavailable");
  const rustc = mustRun(rustup, [
    "which",
    "--toolchain",
    IPHONE2G_TOOLCHAIN.compiler.rustToolchain,
    "rustc",
  ]);
  const cargo = mustRun(rustup, [
    "which",
    "--toolchain",
    IPHONE2G_TOOLCHAIN.compiler.rustToolchain,
    "cargo",
  ]);
  const coreDirectory = join(repository, "programs/native/cabi");
  const rustTargetSpec = join(
    repository,
    "tools/build/toolchains/iphone2g/armv6-apple-ios.json",
  );
  mustRun(
    cargo,
    [
      "build", "--manifest-path", repositoryPath("programs/native/cabi/Cargo.toml"), "-p", "pocketjs-ui-cabi",
      "--release",
      "--locked",
      "--no-default-features",
      "--features",
      // The MBX Lite predates shaders, so this target takes the core's
      // fixed-function GL pipeline rather than Symbian's ES 2 one.
      "standalone-extension-provider,bare-platform,gles1",
      "--target",
      rustTargetSpec,
      "-Z",
      "json-target-spec",
      "-Z",
      "build-std=core,alloc,compiler_builtins",
      "-Z",
      "build-std-features=compiler-builtins-mem",
    ],
    coreDirectory,
    {
      ...process.env,
      RUSTC: rustc,
      CARGO_TARGET_DIR: rustTarget, CARGO_PROFILE_RELEASE_LTO: "true", CARGO_PROFILE_RELEASE_PANIC: "abort",
      IPHONEOS_DEPLOYMENT_TARGET: "10.0",
    },
  );
  const coreLibrary = join(
    rustTarget,
    "armv6-apple-ios/release/libpocketjs_symbian_core.a",
  );
  if (!existsSync(coreLibrary)) {
    throw new Error(
      `PocketJS iPhone 2G: Rust core archive is absent: ${coreLibrary}`,
    );
  }

  const embeddedJavaScript = join(build, "app.js.bin");
  writeFileSync(
    embeddedJavaScript,
    Buffer.concat([readFileSync(guestJavaScript), Buffer.from([0])]),
  );

  const executable = join(bundle, "PocketJSDemo");
  mustRun(linker, [
    "-arch",
    "armv6",
    "-syslibroot",
    sysroot,
    "-L/usr/lib",
    "-F/System/Library/Frameworks",
    "-iphoneos_version_min",
    IPHONE2G_TOOLCHAIN.compiler.minimumVersion,
    "-no_pie",
    "-no_uuid",
    "-no_function_starts",
    "-no_data_in_code_info",
    "-no_source_version",
    "-no_compact_unwind",
    "-no_adhoc_codesign",
    "-no_encryption",
    "-e",
    "start",
    "-o",
    executable,
    join(build, "csu-start.o"),
    join(build, "csu-dyld-glue.o"),
    join(build, "crt_globals.o"),
    join(build, "runtime.o"),
    join(build, "pocket_runtime.o"),
    join(build, "pocket_guest_quickjs.o"),
    join(build, "compat.o"),
    "-force_load",
    coreLibrary,
    ...quickJsObjects,
    "-sectcreate",
    "__DATA",
    "__pocket_js",
    embeddedJavaScript,
    "-sectcreate",
    "__DATA",
    "__pocket_pak",
    guestPack,
    "-framework",
    "UIKit",
    "-framework",
    "Foundation",
    "-framework",
    "CoreGraphics",
    "-framework",
    "OpenGLES",
    "-lobjc",
    "-lSystem",
    "-lgcc_s.1",
  ]);
  const ldid = commandPath("ldid");
  if (!ldid) {
    throw new Error("PocketJS iPhone 2G: ldid is required for iPhone OS 3.1.3");
  }
  mustRun(ldid, ["-S", executable]);

  cpSync(
    join(repository, "programs/iphone2g/Info.plist"),
    join(bundle, "Info.plist"),
  );
  cpSync(join(repository, "programs/iphone2g/PkgInfo"), join(bundle, "PkgInfo"));
  cpSync(join(repository, "programs/iphone2g/Icon.png"), join(bundle, "Icon.png"));
  chmodSync(executable, 0o755);
  for (const name of ["Info.plist", "PkgInfo", "Icon.png"])
    chmodSync(join(bundle, name), 0o644);
  mustRun("plutil", ["-lint", join(bundle, "Info.plist")]);

  const fileInfo = mustRun("file", [executable]);
  const dependencies = mustRun("xcrun", ["otool-classic", "-L", executable]);
  const loadCommands = mustRun("xcrun", ["otool-classic", "-l", executable]);
  const symbols = mustRun("xcrun", ["nm-classic", executable]);
  if (!fileInfo.includes("Mach-O executable arm_v6")) {
    throw new Error(`PocketJS iPhone 2G: unexpected binary: ${fileInfo}`);
  }
  for (const dependency of [
    "UIKit.framework/UIKit",
    "Foundation.framework/Foundation",
    "CoreGraphics.framework/CoreGraphics",
    // Core ES 1.1 lives here and its install name is unchanged on 3.1.3.
    "OpenGLES.framework/OpenGLES",
    "libobjc.A.dylib",
    "libSystem.B.dylib",
    "libgcc_s.1.dylib",
  ]) {
    if (!dependencies.includes(dependency)) {
      throw new Error(
        `PocketJS iPhone 2G: linked binary is missing ${dependency}`,
      );
    }
  }
  if (dependencies.includes("GraphicsServices.framework/GraphicsServices")) {
    throw new Error(
      "PocketJS iPhone 2G: GraphicsServices must remain a dlsym-only 1.x fallback on 3.1.3",
    );
  }
  // EAGL and OES_framebuffer_object are absent from the 1.1.4 OpenGLES, so a
  // link-time reference to either means the binary would be rejected by dyld.
  for (const runtimeOnly of ["_glGenFramebuffersOES", "_glBindFramebufferOES"]) {
    if (symbols.includes(`U ${runtimeOnly}`)) {
      throw new Error(
        `PocketJS iPhone 2G: ${runtimeOnly} must be resolved with dlsym, not linked`,
      );
    }
  }
  for (const marker of [
    "LC_VERSION_MIN_IPHONEOS",
    "version 1.1.4",
    "sectname __pocket_js",
    "sectname __pocket_pak",
    "LC_CODE_SIGNATURE",
  ]) {
    if (!loadCommands.includes(marker)) {
      throw new Error(
        `PocketJS iPhone 2G: linked binary is missing load-command marker ${marker}`,
      );
    }
  }
  for (const symbol of [
    "_main",
    "_pocket_runtime_boot",
    "_ui_hit_test_bounds",
  ]) {
    if (!symbols.includes(symbol)) {
      throw new Error(
        `PocketJS iPhone 2G: linked binary is missing runtime symbol ${symbol}`,
      );
    }
  }

  const sysrootFiles = Object.fromEntries(
    Object.keys(IPHONE2G_TOOLCHAIN.compiler.sysrootFiles).map((relative) => [
      relative,
      sha256File(join(sysroot, relative)),
    ]),
  );
  const bundleFiles = Object.fromEntries(
    ["PocketJSDemo", "Info.plist", "PkgInfo", "Icon.png"].map((name) => {
      const path = join(bundle, name);
      return [
        name,
        {
          sha256: sha256File(path),
          bytes: lstatSync(path).size,
          mode: (lstatSync(path).mode & 0o777).toString(8).padStart(4, "0"),
        },
      ];
    }),
  );
  const receipt = join(bundle, "build-receipt.json");
  writeFileSync(
    receipt,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        toolchainVersion: IPHONE2G_TOOLCHAIN.toolchainVersion,
        target: IPHONE2G_TOOLCHAIN.compiler.target,
        minimumVersion: IPHONE2G_TOOLCHAIN.compiler.minimumVersion,
        sysrootRawSha256: sha256File(
          join(
            iphone2gCacheRoot(),
            "sysroot-1.1.4",
            IPHONE2G_TOOLCHAIN.firmware.rootFilesystem.rawAsset,
          ),
        ),
        sysrootFiles,
        csuRevision: IPHONE2G_TOOLCHAIN.compiler.csu.revision,
        quickJsRevision: IPHONE2G_TOOLCHAIN.compiler.quickJsRevision,
        quickJsVersion: IPHONE2G_TOOLCHAIN.compiler.quickJsVersion,
        rustToolchain: IPHONE2G_TOOLCHAIN.compiler.rustToolchain,
        hostTools,
        buildId,
        hostContract: hostInputs,
        guestJavaScriptSha256: sha256File(guestJavaScript),
        guestJavaScriptBytes: lstatSync(guestJavaScript).size,
        guestPackSha256: sha256File(guestPack),
        guestPackBytes: lstatSync(guestPack).size,
        coreLibrarySha256: sha256File(coreLibrary),
        executableSha256: sha256File(executable),
        bundleFiles,
        receiptMode: "0644",
        signed: true,
        signer: "ldid -S",
      },
      null,
      2,
    )}\n`,
  );
  chmodSync(receipt, 0o644);
  console.log(fileInfo);
  console.log(`PocketJS iPhone 2G: runtime bundle -> ${bundle}`);
}

const SSHD_CONFIG = `Protocol 2
HostKey /etc/ssh/ssh_host_rsa_key
PermitRootLogin yes
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
StrictModes yes
PasswordAuthentication no
ChallengeResponseAuthentication no
PermitEmptyPasswords no
GatewayPorts no
X11Forwarding no
UsePrivilegeSeparation no
UseDNS no
`;

function identityPath(): string {
  const explicit = process.env.POCKETJS_IPHONE2G_IDENTITY?.trim();
  return explicit
    ? resolve(explicit)
    : join(homedir(), ".ssh", "iphone2g_pocketjs");
}

function buildBootstrapDeviceTool(output: string, scratch: string): void {
  const status = inspectIPhone2GToolchain();
  const clang = xcrunFind("clang");
  const linker = xcrunFind(IPHONE2G_TOOLCHAIN.compiler.linker);
  if (!status.sysroot || !status.csu || !clang || !linker) {
    throw new Error(
      "PocketJS iPhone 2G: verified sysroot, Csu, clang, and ld-classic are required for the device helper",
    );
  }

  const build = join(scratch, "device-tool");
  const sdk = mustRun("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const common = [
    "-target",
    IPHONE2G_TOOLCHAIN.compiler.target,
    `-miphoneos-version-min=${IPHONE2G_TOOLCHAIN.compiler.minimumVersion}`,
    "-march=armv6",
    "-Os",
    "-fno-stack-protector",
    "-fno-builtin",
    "-fno-common",
    "-fwrapv",
    "-funsigned-char",
    "-U_FORTIFY_SOURCE",
    "-D_FORTIFY_SOURCE=0",
    "-isysroot",
    sdk,
  ];
  const compile = (
    source: string,
    destination: string,
    extra: readonly string[] = [],
  ) => {
    mustRun(clang, [...common, ...extra, "-c", source, "-o", destination]);
  };
  mkdirSync(build, { recursive: true });
  compile(join(iphone2gCsuPath(), "start.s"), join(build, "start.o"), [
    "-x",
    "assembler-with-cpp",
  ]);
  compile(join(iphone2gCsuPath(), "dyld_glue.s"), join(build, "dyld-glue.o"), [
    "-x",
    "assembler-with-cpp",
    "-DMACH_HEADER_SYMBOL_NAME=__mh_execute_header",
    "-DCRT",
  ]);
  compile(
    join(repository, "programs/shared/ios-legacy/crt_globals.c"),
    join(build, "crt-globals.o"),
    ["-Wall", "-Wextra", "-Werror", "-Wno-incompatible-sysroot"],
  );
  compile(
    join(repository, "programs/iphone2g/device_tool.c"),
    join(build, "device-tool.o"),
    ["-Wall", "-Wextra", "-Werror", "-Wno-incompatible-sysroot"],
  );
  mkdirSync(dirname(output), { recursive: true });
  mustRun(linker, [
    "-arch",
    "armv6",
    "-syslibroot",
    iphone2gSysrootPath(),
    "-L/usr/lib",
    "-iphoneos_version_min",
    IPHONE2G_TOOLCHAIN.compiler.minimumVersion,
    "-no_pie",
    "-no_uuid",
    "-no_function_starts",
    "-no_data_in_code_info",
    "-no_source_version",
    "-no_compact_unwind",
    "-no_adhoc_codesign",
    "-no_encryption",
    "-e",
    "start",
    "-o",
    output,
    join(build, "start.o"),
    join(build, "dyld-glue.o"),
    join(build, "crt-globals.o"),
    join(build, "device-tool.o"),
    "-lSystem",
    "-lgcc_s.1",
  ]);
  const ldid = commandPath("ldid");
  if (!ldid) {
    throw new Error(
      "PocketJS iPhone 2G: ldid is required for the device helper",
    );
  }
  mustRun(ldid, ["-S", output]);
  const fileInfo = mustRun("file", [output]);
  const dependencies = mustRun("xcrun", ["otool-classic", "-L", output]);
  const loadCommands = mustRun("xcrun", ["otool-classic", "-l", output]);
  if (
    !fileInfo.includes("Mach-O executable arm_v6") ||
    !dependencies.includes("/usr/lib/libSystem.B.dylib") ||
    !dependencies.includes("/usr/lib/libgcc_s.1.dylib") ||
    !loadCommands.includes("version 1.1.4") ||
    !loadCommands.includes("LC_CODE_SIGNATURE")
  ) {
    throw new Error(
      "PocketJS iPhone 2G: generated device helper failed its ARMv6/1.1.4 audit",
    );
  }
  chmodSync(output, 0o755);
}

function verifyRsaKey(
  privateKey: string,
  publicKey: string,
  label: string,
): string {
  const privateText = readFileSync(privateKey, "utf8");
  const publicLines = readFileSync(publicKey, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (
    !privateText.startsWith("-----BEGIN RSA PRIVATE KEY-----") ||
    publicLines.length !== 1
  ) {
    throw new Error(`PocketJS iPhone 2G: ${label} must be one RSA PEM keypair`);
  }
  const stored = publicLines[0].trim().split(/\s+/).slice(0, 2).join(" ");
  const derived = mustRun("ssh-keygen", ["-y", "-f", privateKey])
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  const fingerprint = mustRun("ssh-keygen", ["-lf", publicKey]);
  if (
    !stored.startsWith("ssh-rsa ") ||
    stored !== derived ||
    !/^2048\s/.test(fingerprint) ||
    !fingerprint.endsWith(" (RSA)")
  ) {
    throw new Error(
      `PocketJS iPhone 2G: ${label} must be a matching 2048-bit RSA keypair`,
    );
  }
  return publicLines[0].trim();
}

export function quoteOpenSshConfigValue(value: string): string {
  if (/\0|\r|\n/.test(value)) {
    throw new Error(
      "PocketJS iPhone 2G: SSH config paths cannot contain NUL or newlines",
    );
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function writeDeviceSshConfig(): string {
  const cache = iphone2gCacheRoot();
  const sshConfig = join(cache, "bootstrap/ssh_config");
  const knownHosts = join(cache, "bootstrap/known_hosts");
  mkdirSync(dirname(sshConfig), { recursive: true, mode: 0o700 });
  writeFileSync(
    sshConfig,
    `Host iphone2g-pocketjs
  HostName 127.0.0.1
  Port ${IPHONE2G_TOOLCHAIN.deployment.localPort}
  User ${IPHONE2G_TOOLCHAIN.deployment.bootstrapUser}
  IdentityFile ${quoteOpenSshConfigValue(identityPath())}
  IdentitiesOnly yes
  UserKnownHostsFile ${quoteOpenSshConfigValue(knownHosts)}
  StrictHostKeyChecking yes
  HostKeyAlgorithms +ssh-rsa
  PubkeyAcceptedAlgorithms +ssh-rsa
  KexAlgorithms +diffie-hellman-group14-sha1,diffie-hellman-group1-sha1
  Ciphers +aes128-cbc,3des-cbc,aes192-cbc,aes256-cbc
  MACs +hmac-sha1,hmac-md5
`,
    { mode: 0o600 },
  );
  chmodSync(sshConfig, 0o600);
  return sshConfig;
}

function prepareBootstrap(): void {
  const cache = iphone2gCacheRoot();
  const bootstrapRoot = join(cache, "bootstrap");
  const scratch = join(bootstrapRoot, `.prepare-${process.pid}`);
  const destination = join(bootstrapRoot, "stage");
  mkdirSync(bootstrapRoot, { recursive: true, mode: 0o700 });
  chmodSync(bootstrapRoot, 0o700);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });

  try {
    const stage = join(scratch, "stage");
    buildBootstrapDeviceTool(
      join(stage, "root/usr/libexec/pocketjs-device"),
      scratch,
    );

    const identity = identityPath();
    if (!existsSync(identity)) {
      mkdirSync(dirname(identity), { recursive: true });
      mustRun("ssh-keygen", [
        "-q",
        "-t",
        "rsa",
        "-b",
        "2048",
        "-m",
        "PEM",
        "-N",
        "",
        "-C",
        "pocketjs-iphone2g",
        "-f",
        identity,
      ]);
    }
    chmodSync(identity, 0o600);
    const publicKey = verifyRsaKey(
      identity,
      `${identity}.pub`,
      "client identity",
    );

    const stagedSshConfig = join(stage, "root/private/etc/ssh/sshd_config");
    mkdirSync(dirname(stagedSshConfig), { recursive: true });
    writeFileSync(stagedSshConfig, SSHD_CONFIG, { mode: 0o644 });
    mkdirSync(join(stage, "data/root/.ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stage, "data/root/.ssh/authorized_keys"),
      `${publicKey}\n`,
      { mode: 0o600 },
    );

    const expectedModes: Array<readonly [string, number]> = [
      ["root/usr/libexec/pocketjs-device", 0o755],
      ["root/private/etc/ssh/sshd_config", 0o644],
      ["data/root/.ssh/authorized_keys", 0o600],
    ];
    const files = Object.fromEntries(
      expectedModes.map(([relative, mode]) => {
        const path = join(stage, relative);
        const actualMode = lstatSync(path).mode & 0o777;
        if (actualMode !== mode) {
          throw new Error(
            `PocketJS iPhone 2G: ${relative} mode is ${actualMode.toString(8)}, expected ${mode.toString(8)}`,
          );
        }
        return [
          relative,
          {
            sha256: sha256File(path),
            mode: mode.toString(8).padStart(4, "0"),
          },
        ];
      }),
    );

    writeDeviceSshConfig();
    writeFileSync(
      join(stage, "bootstrap-receipt.json"),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          files,
          deviceHelper: {
            sourceSha256: sha256File(
              join(repository, "programs/iphone2g/device_tool.c"),
            ),
            protocol: "PJS2G003",
            signed: true,
          },
          clientIdentity: identity,
          policy: {
            productVersion: "3.1.3",
            buildVersion: "7E18",
            mountPolicy: "rw-root-data",
            passwordAuthentication: false,
            preserveDeviceSshd: true,
            preserveDeviceHostKey: true,
            preserveDeviceLaunchdPlist: true,
            sftp: false,
            afc2: false,
            fstabMutation: false,
            basebandMutation: false,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    rmSync(destination, { recursive: true, force: true });
    cpSync(stage, destination, { recursive: true, preserveTimestamps: true });
    chmodSync(destination, 0o700);
    console.log(`PocketJS iPhone 2G: key-only bootstrap -> ${destination}`);
    console.log(
      `PocketJS iPhone 2G: dedicated SSH config -> ${writeDeviceSshConfig()}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const DEVICE_BUNDLE_FILES = [
  "PocketJSDemo",
  "Info.plist",
  "PkgInfo",
  "Icon.png",
  "build-receipt.json",
] as const;

interface BootstrapReceipt {
  readonly schemaVersion: 2;
  readonly files: Readonly<
    Record<string, { readonly sha256: string; readonly mode: string }>
  >;
  readonly deviceHelper: {
    readonly sourceSha256: string;
    readonly protocol: "PJS2G003";
    readonly signed: true;
  };
  readonly policy: {
    readonly productVersion: "3.1.3";
    readonly buildVersion: "7E18";
    readonly mountPolicy: "rw-root-data";
    readonly passwordAuthentication: false;
    readonly preserveDeviceSshd: true;
    readonly preserveDeviceHostKey: true;
    readonly preserveDeviceLaunchdPlist: true;
    readonly sftp: false;
    readonly afc2: false;
    readonly fstabMutation: false;
    readonly basebandMutation: false;
  };
}

function verifiedBootstrapReceipt(): BootstrapReceipt {
  const stage = join(iphone2gCacheRoot(), "bootstrap/stage");
  const receiptPath = join(stage, "bootstrap-receipt.json");
  if (!existsSync(receiptPath)) {
    throw new Error(
      "PocketJS iPhone 2G: run `bun iphone2g prepare-bootstrap` first",
    );
  }
  const receipt = JSON.parse(
    readFileSync(receiptPath, "utf8"),
  ) as BootstrapReceipt;
  const expectedFiles = [
    "root/usr/libexec/pocketjs-device",
    "root/private/etc/ssh/sshd_config",
    "data/root/.ssh/authorized_keys",
  ];
  const validPolicy =
    receipt.policy?.passwordAuthentication === false &&
    receipt.policy.productVersion === "3.1.3" &&
    receipt.policy.buildVersion === "7E18" &&
    receipt.policy.mountPolicy === "rw-root-data" &&
    receipt.policy.preserveDeviceSshd === true &&
    receipt.policy.preserveDeviceHostKey === true &&
    receipt.policy.preserveDeviceLaunchdPlist === true &&
    receipt.policy.sftp === false &&
    receipt.policy.afc2 === false &&
    receipt.policy.fstabMutation === false &&
    receipt.policy.basebandMutation === false;
  if (
    receipt.schemaVersion !== 2 ||
    receipt.deviceHelper?.protocol !== "PJS2G003" ||
    receipt.deviceHelper.signed !== true ||
    receipt.deviceHelper.sourceSha256 !==
      sha256File(join(repository, "programs/iphone2g/device_tool.c")) ||
    !validPolicy ||
    JSON.stringify(Object.keys(receipt.files ?? {})) !==
      JSON.stringify(expectedFiles)
  ) {
    throw new Error(
      "PocketJS iPhone 2G: local bootstrap receipt is stale or violates device policy",
    );
  }
  for (const relative of expectedFiles) {
    const path = join(stage, relative);
    const expected = receipt.files[relative];
    const actualMode = existsSync(path)
      ? (lstatSync(path).mode & 0o777).toString(8).padStart(4, "0")
      : "";
    if (
      !expected ||
      !existsSync(path) ||
      sha256File(path) !== expected.sha256 ||
      actualMode !== expected.mode
    ) {
      throw new Error(
        `PocketJS iPhone 2G: local bootstrap file is stale: ${relative}`,
      );
    }
  }
  return receipt;
}

const LEGACY_SSH_OPTIONS = [
  "-o",
  "HostKeyAlgorithms=+ssh-rsa",
  "-o",
  "PubkeyAcceptedAlgorithms=+ssh-rsa",
  "-o",
  "KexAlgorithms=+diffie-hellman-group14-sha1,diffie-hellman-group1-sha1",
  "-o",
  "Ciphers=+aes128-cbc,3des-cbc,aes192-cbc,aes256-cbc",
  "-o",
  "MACs=+hmac-sha1,hmac-md5",
] as const;

function legacyKitBinary(name: "iproxy" | "sshpass"): string {
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  const bundled = join(
    iphone2gLegacyKitPath(),
    "bin/macos",
    architecture,
    name,
  );
  if (existsSync(bundled)) return bundled;
  const host = commandPath(name);
  if (host) return host;
  throw new Error(
    `PocketJS iPhone 2G: ${name} is unavailable; run setup-sources first`,
  );
}

function tunnelIsListening(): boolean {
  const probe = run("/usr/bin/nc", [
    "-z",
    "-w",
    "1",
    "127.0.0.1",
    String(IPHONE2G_TOOLCHAIN.deployment.localPort),
  ]);
  return probe.exitCode === 0;
}

/** Pin the usbmux tunnel to one device when several are attached. */
function iphone2gUdidArgs(): string[] {
  const udid = process.env.POCKETJS_IPHONE2G_UDID?.trim();
  return udid ? ["-u", udid] : [];
}

async function withManagedTunnel<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  if (tunnelIsListening()) return await operation();
  const iproxy = legacyKitBinary("iproxy");
  const child = Bun.spawn({
    cmd: [
      iproxy,
      String(IPHONE2G_TOOLCHAIN.deployment.localPort),
      String(IPHONE2G_TOOLCHAIN.deployment.devicePort),
      ...iphone2gUdidArgs(),
      "-s",
      "127.0.0.1",
    ],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    for (let attempt = 0; attempt < 20 && !tunnelIsListening(); attempt += 1) {
      if (child.exitCode !== null) break;
      await Bun.sleep(100);
    }
    if (!tunnelIsListening()) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(
        `PocketJS iPhone 2G: iproxy did not open USB port ${IPHONE2G_TOOLCHAIN.deployment.localPort}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      );
    }
    return await operation();
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

function runTunnel(): never {
  const iproxy = legacyKitBinary("iproxy");
  if (tunnelIsListening()) {
    throw new Error(
      `PocketJS iPhone 2G: local port ${IPHONE2G_TOOLCHAIN.deployment.localPort} is already in use`,
    );
  }
  const result = Bun.spawnSync({
    cmd: [
      iproxy,
      String(IPHONE2G_TOOLCHAIN.deployment.localPort),
      String(IPHONE2G_TOOLCHAIN.deployment.devicePort),
      ...iphone2gUdidArgs(),
      "-s",
      "127.0.0.1",
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(result.exitCode);
}

function passwordSshArgs(remoteCommand: string): string[] {
  return [
    "-e",
    "/usr/bin/ssh",
    "-T",
    "-p",
    String(IPHONE2G_TOOLCHAIN.deployment.localPort),
    "-o",
    "BatchMode=no",
    "-o",
    "ConnectTimeout=3",
    "-o",
    "NumberOfPasswordPrompts=1",
    "-o",
    "PreferredAuthentications=password",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    ...LEGACY_SSH_OPTIONS,
    `${IPHONE2G_TOOLCHAIN.deployment.bootstrapUser}@127.0.0.1`,
    remoteCommand,
  ];
}

function provisionalKeySshArgs(remoteCommand: string): string[] {
  return [
    "/usr/bin/ssh",
    "-T",
    "-p",
    String(IPHONE2G_TOOLCHAIN.deployment.localPort),
    "-i",
    identityPath(),
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ConnectTimeout=3",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    ...LEGACY_SSH_OPTIONS,
    `${IPHONE2G_TOOLCHAIN.deployment.bootstrapUser}@127.0.0.1`,
    remoteCommand,
  ];
}

function passwordCommand(
  command: readonly string[],
  input?: Uint8Array,
): BinaryCommandResult {
  const remote = command.join(" ");
  return runBinary(
    legacyKitBinary("sshpass"),
    passwordSshArgs(remote),
    input,
    repository,
    { ...process.env, LANG: "C", LC_ALL: "C", SSHPASS: "alpine" },
  );
}

export type PasswordAuthenticationProbeState =
  "accepted" | "rejected" | "indeterminate";

export function classifyPasswordAuthenticationProbe(
  result: Pick<BinaryCommandResult, "exitCode" | "stderr">,
): PasswordAuthenticationProbeState {
  if (result.exitCode === 0) return "accepted";
  if (result.exitCode !== 255) return "indeterminate";

  const denials = [
    ...result.stderr.matchAll(/Permission denied \(([^)\r\n]+)\)\.?/g),
  ];
  const offered = denials
    .at(-1)?.[1]
    ?.split(",")
    .map((method) => method.trim().toLowerCase())
    .filter(Boolean);
  if (
    !offered?.length ||
    offered.some(
      (method) =>
        method === "password" || method.startsWith("keyboard-interactive"),
    )
  ) {
    return "indeterminate";
  }
  return "rejected";
}

function provisionalKeyCommand(
  command: readonly string[],
  input?: Uint8Array,
): BinaryCommandResult {
  return runBinary(
    provisionalKeySshArgs(command.join(" "))[0],
    provisionalKeySshArgs(command.join(" ")).slice(1),
    input,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function passwordShell(
  script: string,
  input?: Uint8Array,
): BinaryCommandResult {
  return passwordCommand(["/bin/sh", "-c", shellQuote(script)], input);
}

type BootstrapCommand = (
  command: readonly string[],
  input?: Uint8Array,
) => BinaryCommandResult;

function bootstrapShell(
  runCommand: BootstrapCommand,
  script: string,
  input?: Uint8Array,
): BinaryCommandResult {
  return runCommand(["/bin/sh", "-c", shellQuote(script)], input);
}

function assert313DeviceAndMounts(runCommand: BootstrapCommand): void {
  const version = bootstrapShell(
    runCommand,
    "/usr/bin/sw_vers -productVersion; /usr/bin/sw_vers -buildVersion; /usr/sbin/sysctl -n hw.machine",
  );
  if (
    version.exitCode !== 0 ||
    version.stdout.toString() !== "3.1.3\n7E18\niPhone1,1\n"
  ) {
    throw new Error(
      "PocketJS iPhone 2G: bootstrap requires a normally booted iPhone1,1 on 3.1.3 (7E18)",
    );
  }
  const mounts = runCommand(["/sbin/mount"]);
  const lines = mounts.stdout.toString().split(/\r?\n/);
  const root = lines.find((line) => line.includes(" on / ("));
  const data = lines.find((line) => line.includes(" on /private/var ("));
  if (
    mounts.exitCode !== 0 ||
    !root ||
    !data ||
    root.includes("read-only") ||
    data.includes("read-only")
  ) {
    throw new Error(
      "PocketJS iPhone 2G: 3.1.3 root and data volumes must both remain read/write",
    );
  }
}

function mergeAuthorizedKeys(existing: Buffer, pocketKey: Buffer): Buffer {
  if (existing.length > 256 * 1024 || existing.includes(0)) {
    throw new Error(
      "PocketJS iPhone 2G: refusing an invalid existing authorized_keys",
    );
  }
  const key = pocketKey.toString("utf8").trim();
  const lines = existing.toString("utf8").split(/\r?\n/).filter(Boolean);
  if (!lines.includes(key)) lines.push(key);
  return Buffer.from(`${lines.join("\n")}\n`);
}

const BOOTSTRAP_MARKER_TIMEOUT_MS = 15_000;
const BOOTSTRAP_ROLLBACK_TIMEOUT_MS = 20_000;

class BootstrapMarkerTimeoutError extends Error {
  constructor(readonly marker: string) {
    super(`PocketJS iPhone 2G: timed out waiting for ${marker.trim()}`);
    this.name = "BootstrapMarkerTimeoutError";
  }
}

export async function readUntilMarker(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
  accumulated: { text: string },
  timeoutMs = BOOTSTRAP_MARKER_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("PocketJS iPhone 2G: bootstrap marker timeout is invalid");
  }
  const deadline = Date.now() + timeoutMs;
  while (!accumulated.text.includes(marker)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BootstrapMarkerTimeoutError(marker);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new BootstrapMarkerTimeoutError(marker)),
          remaining,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (chunk.done) {
      throw new Error(
        `PocketJS iPhone 2G: bootstrap controller exited before ${marker}`,
      );
    }
    accumulated.text += Buffer.from(chunk.value).toString();
  }
}

export function bootstrapControllerScript(identifier: string): string {
  const transaction = `/private/var/tmp/pocketjs-bootstrap-${identifier}`;
  const suffix = `.pocketjs-${identifier}`;
  const script = `set -eu
PATH=/bin:/sbin:/usr/bin:/usr/sbin
txn=${transaction}
helper=/usr/libexec/pocketjs-device
auth=/private/var/root/.ssh/authorized_keys
config=/private/etc/ssh/sshd_config
suffix=${suffix}
rollback() {
  result=$?
  trap - EXIT HUP INT TERM
  set +e
  for target in "$config" "$auth" "$helper"; do
    backup="$target$suffix.old"
    if test -f "$backup"; then
      /bin/rm -f "$target"
      /bin/mv "$backup" "$target"
    elif test -f "$txn/absent$(echo "$target" | /bin/sed 's,/,-,g')"; then
      /bin/rm -f "$target"
    fi
    /bin/rm -f "$target$suffix.new"
  done
  test ! -f "$txn/created-ssh" || /bin/rmdir /private/var/root/.ssh >/dev/null 2>&1
  /bin/rm -rf "$txn"
  exit "$result"
}
trap 'exit 97' HUP INT TERM
trap rollback EXIT
for tool in /bin/cp /bin/mv /bin/rm /bin/chmod /bin/chown /usr/bin/cmp /usr/sbin/sshd; do
  test -x "$tool"
done
if test ! -d /private/var/root/.ssh; then
  /bin/mkdir /private/var/root/.ssh
  /bin/chmod 700 /private/var/root/.ssh
  /bin/chown 0:0 /private/var/root/.ssh
  : > "$txn/created-ssh"
fi
for spec in \
  "0:$helper:755" \
  "1:$auth:600" \
  "2:$config:644"; do
  index=${"${spec%%:*}"}
  rest=${"${spec#*:}"}
  target=${"${rest%:*}"}
  mode=${"${rest##*:}"}
  test ! -e "$target$suffix.new"
  /bin/cp "$txn/payload/$index" "$target$suffix.new"
  /bin/chmod "$mode" "$target$suffix.new"
  /bin/chown 0:0 "$target$suffix.new"
  /usr/bin/cmp "$txn/payload/$index" "$target$suffix.new"
done
swap() {
  target="$1"
  if test -e "$target"; then
    test -f "$target"
    /bin/mv "$target" "$target$suffix.old"
  else
    : > "$txn/absent$(echo "$target" | /bin/sed 's,/,-,g')"
  fi
  /bin/mv "$target$suffix.new" "$target"
}
swap "$helper"
swap "$auth"
/bin/sync
echo PJS_BOOTSTRAP_KEY_READY
IFS= read decision
test "$decision" = secure
/usr/sbin/sshd -t -f "$config$suffix.new"
swap "$config"
echo PJS_BOOTSTRAP_SECURE_READY
IFS= read decision
test "$decision" = commit
trap - EXIT HUP INT TERM
/bin/rm -f "$helper$suffix.old" "$auth$suffix.old" "$config$suffix.old"
/bin/rm -rf "$txn"
echo PJS_BOOTSTRAP_COMMITTED
`;
  const syntax = runBinary("/bin/sh", ["-n"], Buffer.from(script));
  if (syntax.exitCode !== 0) {
    throw new Error(
      `PocketJS iPhone 2G: generated bootstrap transaction is invalid: ${syntax.stderr.trim()}`,
    );
  }
  return script;
}

function verifyInstalledBootstrap(receipt: BootstrapReceipt): void {
  const version = deviceCommand(["/usr/libexec/pocketjs-device", "version"]);
  const helper = deviceCommand(["/usr/libexec/pocketjs-device", "self"]);
  const mounts = deviceCommand(["/usr/libexec/pocketjs-device", "mount-state"]);
  if (
    version.exitCode !== 0 ||
    version.stdout.toString() !== "pocketjs-iphone2g-device 4\n" ||
    helper.exitCode !== 0 ||
    sha256Bytes(helper.stdout) !==
      receipt.files["root/usr/libexec/pocketjs-device"].sha256 ||
    mounts.exitCode !== 0 ||
    mounts.stdout.toString() !== "root_readwrite=1\ndata_readwrite=1\n"
  ) {
    throw new Error(
      "PocketJS iPhone 2G: installed signed helper/key mount contract failed",
    );
  }
}

interface InstalledSshPolicyInspection {
  readonly configMatches: boolean;
  readonly syntaxValid: boolean;
  readonly passwordAuthentication: PasswordAuthenticationProbeState;
}

function inspectInstalledSshPolicy(
  receipt: BootstrapReceipt,
): InstalledSshPolicyInspection {
  const config = deviceCommand(["/bin/cat", "/private/etc/ssh/sshd_config"]);
  const syntax = deviceCommand([
    "/usr/sbin/sshd",
    "-t",
    "-f",
    "/private/etc/ssh/sshd_config",
  ]);
  const passwordProbe = passwordCommand(["/bin/true"]);
  const passwordAuthentication =
    classifyPasswordAuthenticationProbe(passwordProbe);
  if (passwordAuthentication === "indeterminate") {
    const detail = passwordProbe.stderr.trim().replaceAll(/\s+/g, " ");
    throw new Error(
      `PocketJS iPhone 2G: could not prove that password SSH was rejected (${passwordProbe.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }
  return {
    configMatches:
      config.exitCode === 0 &&
      sha256Bytes(config.stdout) ===
        receipt.files["root/private/etc/ssh/sshd_config"].sha256,
    syntaxValid: syntax.exitCode === 0,
    passwordAuthentication,
  };
}

function installedSshPolicyIsSecure(
  inspection: InstalledSshPolicyInspection,
): boolean {
  return (
    inspection.configMatches &&
    inspection.syntaxValid &&
    inspection.passwordAuthentication === "rejected"
  );
}

async function waitForBootstrapRollback(transaction: string): Promise<void> {
  const deadline = Date.now() + BOOTSTRAP_ROLLBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const runCommand of [provisionalKeyCommand, passwordCommand]) {
      const result = bootstrapShell(
        runCommand,
        `test ! -e ${transaction} && echo PJS_BOOTSTRAP_ROLLED_BACK`,
      );
      if (
        result.exitCode === 0 &&
        result.stdout.toString() === "PJS_BOOTSTRAP_ROLLED_BACK\n"
      ) {
        return;
      }
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `PocketJS iPhone 2G: CRITICAL: remote bootstrap rollback was not confirmed for ${transaction}`,
  );
}

async function installBootstrap(): Promise<void> {
  prepareBootstrap();
  const receipt = verifiedBootstrapReceipt();
  const stage = join(iphone2gCacheRoot(), "bootstrap/stage");
  await withManagedTunnel(async () => {
    let bootstrapCommand: BootstrapCommand | undefined;
    let bootstrapAuthentication: "key" | "password" | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (provisionalKeyCommand(["/bin/true"]).exitCode === 0) {
        bootstrapCommand = provisionalKeyCommand;
        bootstrapAuthentication = "key";
        break;
      }
      if (passwordCommand(["/bin/true"]).exitCode === 0) {
        bootstrapCommand = passwordCommand;
        bootstrapAuthentication = "password";
        break;
      }
      await Bun.sleep(250);
    }
    if (!bootstrapCommand || !bootstrapAuthentication) {
      throw new Error(
        "PocketJS iPhone 2G: neither the dedicated key nor temporary root/alpine SSH is available over USB",
      );
    }
    assert313DeviceAndMounts(bootstrapCommand);

    const remoteHostKey = bootstrapCommand([
      "/bin/cat",
      "/private/etc/ssh/ssh_host_rsa_key.pub",
    ]);
    const hostKey = remoteHostKey.stdout.toString().trim();
    if (remoteHostKey.exitCode !== 0 || !hostKey.startsWith("ssh-rsa ")) {
      throw new Error(
        "PocketJS iPhone 2G: existing CustomHJ RSA host public key is unavailable",
      );
    }
    const knownHosts = join(iphone2gCacheRoot(), "bootstrap/known_hosts");
    writeFileSync(
      knownHosts,
      `[127.0.0.1]:${IPHONE2G_TOOLCHAIN.deployment.localPort} ${hostKey.split(/\s+/).slice(0, 2).join(" ")}\n`,
      { mode: 0o600 },
    );
    chmodSync(knownHosts, 0o600);
    writeDeviceSshConfig();

    let installedBootstrapMatches = false;
    try {
      verifyInstalledBootstrap(receipt);
      installedBootstrapMatches = true;
    } catch {}
    if (installedBootstrapMatches) {
      const policy = inspectInstalledSshPolicy(receipt);
      if (installedSshPolicyIsSecure(policy)) {
        console.log(
          "PocketJS iPhone 2G: key-only bootstrap already matches; no device changes needed",
        );
        return;
      }
    }

    const currentKeys = bootstrapShell(
      bootstrapCommand,
      "test ! -f /private/var/root/.ssh/authorized_keys || /bin/cat /private/var/root/.ssh/authorized_keys",
    );
    if (currentKeys.exitCode !== 0) {
      throw new Error(
        "PocketJS iPhone 2G: could not read existing authorized_keys",
      );
    }
    const authorizedKeys = mergeAuthorizedKeys(
      currentKeys.stdout,
      readFileSync(join(stage, "data/root/.ssh/authorized_keys")),
    );
    const payloads = [
      readFileSync(join(stage, "root/usr/libexec/pocketjs-device")),
      authorizedKeys,
      readFileSync(join(stage, "root/private/etc/ssh/sshd_config")),
    ];
    const identifier = randomBytes(16).toString("hex");
    const transaction = `/private/var/tmp/pocketjs-bootstrap-${identifier}`;
    const prepare = bootstrapShell(
      bootstrapCommand,
      `umask 077; test ! -e ${transaction}; /bin/mkdir -p ${transaction}/payload`,
    );
    if (prepare.exitCode !== 0) {
      throw new Error(
        "PocketJS iPhone 2G: could not create bootstrap staging area",
      );
    }
    for (let index = 0; index < payloads.length; index += 1) {
      const upload = bootstrapShell(
        bootstrapCommand,
        `/bin/cat > ${transaction}/payload/${index}`,
        payloads[index],
      );
      const readback = bootstrapCommand([
        "/bin/cat",
        `${transaction}/payload/${index}`,
      ]);
      if (
        upload.exitCode !== 0 ||
        readback.exitCode !== 0 ||
        sha256Bytes(readback.stdout) !== sha256Bytes(payloads[index])
      ) {
        bootstrapShell(bootstrapCommand, `/bin/rm -rf ${transaction}`);
        throw new Error(
          `PocketJS iPhone 2G: bootstrap payload ${index} failed readback`,
        );
      }
    }

    const controllerRemote = `/bin/sh -c ${shellQuote(bootstrapControllerScript(identifier))}`;
    const controllerCommand =
      bootstrapAuthentication === "key"
        ? provisionalKeySshArgs(controllerRemote)
        : [legacyKitBinary("sshpass"), ...passwordSshArgs(controllerRemote)];
    const controller = Bun.spawn({
      cmd: controllerCommand,
      env:
        bootstrapAuthentication === "password"
          ? { ...process.env, SSHPASS: "alpine" }
          : process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = controller.stdout.getReader();
    const output = { text: "" };
    try {
      await readUntilMarker(reader, "PJS_BOOTSTRAP_KEY_READY\n", output);
      verifyInstalledBootstrap(receipt);
      controller.stdin.write("secure\n");
      await controller.stdin.flush();
      await readUntilMarker(reader, "PJS_BOOTSTRAP_SECURE_READY\n", output);
      verifyInstalledBootstrap(receipt);
      const policy = inspectInstalledSshPolicy(receipt);
      if (policy.passwordAuthentication === "accepted") {
        throw new Error("PocketJS iPhone 2G: password SSH remained enabled");
      }
      if (!installedSshPolicyIsSecure(policy)) {
        throw new Error(
          "PocketJS iPhone 2G: installed sshd policy failed byte-exact readback or syntax validation",
        );
      }
      controller.stdin.write("commit\n");
      controller.stdin.end();
      await readUntilMarker(reader, "PJS_BOOTSTRAP_COMMITTED\n", output);
      if ((await controller.exited) !== 0) {
        throw new Error("PocketJS iPhone 2G: bootstrap commit failed");
      }
    } catch (error) {
      const markerTimedOut = error instanceof BootstrapMarkerTimeoutError;
      if (markerTimedOut) {
        if (controller.exitCode === null) {
          controller.kill();
          const exitedAfterTerm = await Promise.race([
            controller.exited.then(() => true),
            Bun.sleep(2_000).then(() => false),
          ]);
          if (!exitedAfterTerm && controller.exitCode === null) {
            controller.kill(9);
          }
        }
      } else {
        try {
          controller.stdin.write("rollback\n");
          controller.stdin.end();
        } catch {}
      }
      await controller.exited;
      if (
        markerTimedOut &&
        !output.text.includes("PJS_BOOTSTRAP_COMMITTED\n")
      ) {
        await waitForBootstrapRollback(transaction);
      }
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    console.log(
      "PocketJS iPhone 2G: signed helper and client key verified; password SSH disabled",
    );
    console.log(
      "PocketJS iPhone 2G: preserved CustomHJ sshd, host key, and launchd plist",
    );
  });
}

function deviceSshConfig(): string {
  verifiedBootstrapReceipt();
  return join(iphone2gCacheRoot(), "bootstrap/ssh_config");
}

function deviceSshArgs(command: readonly string[]): string[] {
  const config = deviceSshConfig();
  if (!existsSync(config))
    throw new Error("PocketJS iPhone 2G: dedicated SSH config is absent");
  return [
    "-F",
    config,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "iphone2g-pocketjs",
    ...command,
  ];
}

function deviceCommand(
  command: readonly string[],
  input?: Uint8Array,
): BinaryCommandResult {
  return runBinary("/usr/bin/ssh", deviceSshArgs(command), input);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ensureDeviceMountPolicy(): void {
  const state = deviceCommand(["/usr/libexec/pocketjs-device", "mount-state"]);
  const mounts = deviceCommand(["/sbin/mount"]);
  const lines = mounts.stdout.toString().split(/\r?\n/);
  const root = lines.find((line) => line.includes(" on / ("));
  const data = lines.find((line) => line.includes(" on /private/var ("));
  if (
    state.exitCode !== 0 ||
    state.stdout.toString() !== "root_readwrite=1\ndata_readwrite=1\n" ||
    mounts.exitCode !== 0 ||
    !root ||
    !data ||
    root.includes("read-only") ||
    data.includes("read-only")
  ) {
    throw new Error(
      "PocketJS iPhone 2G: CRITICAL: 3.1.3 root/data read-write policy changed",
    );
  }
}

function rollbackDeviceInstall(identifier: string): string | undefined {
  const rollback = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "rollback",
    identifier,
  ]);
  try {
    ensureDeviceMountPolicy();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return rollback.exitCode === 0
    ? undefined
    : `device rollback failed (${rollback.exitCode})${rollback.stderr.trim() ? `: ${rollback.stderr.trim()}` : ""}`;
}

function recoverPendingDeviceTransaction(): void {
  const pending = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "transaction-state",
  ]);
  if (pending.exitCode !== 0) {
    throw new Error(
      "PocketJS iPhone 2G: device transaction marker is malformed or unreadable",
    );
  }
  const text = pending.stdout.toString();
  if (text === "state=none\n") return;
  const match = text.match(
    /^state=pending\nphase=([LPMIR])\nhad_previous=([01])\nid=([0-9a-f]{32})\n$/,
  );
  if (!match)
    throw new Error("PocketJS iPhone 2G: malformed pending transaction state");
  const rollback = rollbackDeviceInstall(match[3]);
  if (rollback) throw new Error(`PocketJS iPhone 2G: ${rollback}`);
  const cleared = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "transaction-state",
  ]);
  if (cleared.exitCode !== 0 || cleared.stdout.toString() !== "state=none\n") {
    throw new Error(
      "PocketJS iPhone 2G: pending transaction did not clear after rollback",
    );
  }
}

function deploymentPackage(bundle: string, identifier: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(identifier)) {
    throw new Error(
      "PocketJS iPhone 2G: invalid deployment transaction identifier",
    );
  }
  const parts: Buffer[] = [
    Buffer.from("PJS2G003", "ascii"),
    Buffer.from(identifier, "ascii"),
  ];
  for (const name of DEVICE_BUNDLE_FILES) {
    const bytes = readFileSync(join(bundle, name));
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

function deployDemo(): void {
  const bundle = join(repository, "dist/iphone2g/PocketJSDemo.app");
  const receipt = verifiedBootstrapReceipt();
  const buildReceipt = JSON.parse(
    readFileSync(join(bundle, "build-receipt.json"), "utf8"),
  ) as { buildId?: string };
  if (!buildReceipt.buildId || !/^[0-9a-f]{32}$/.test(buildReceipt.buildId)) {
    throw new Error(
      "PocketJS iPhone 2G: build receipt has no valid transaction identifier",
    );
  }
  const identifier = buildReceipt.buildId;
  const remoteVersion = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "version",
  ]);
  const remoteHelper = deviceCommand(["/usr/libexec/pocketjs-device", "self"]);
  if (
    remoteHelper.exitCode !== 0 ||
    sha256Bytes(remoteHelper.stdout) !==
      receipt.files["root/usr/libexec/pocketjs-device"].sha256 ||
    remoteVersion.exitCode !== 0 ||
    remoteVersion.stdout.toString() !== "pocketjs-iphone2g-device 4\n"
  ) {
    throw new Error(
      "PocketJS iPhone 2G: installed device helper does not match the verified bootstrap",
    );
  }
  const stopPrevious = deviceCommand([
    "/bin/launchctl",
    "stop",
    "com.apple.SpringBoard",
  ]);
  if (stopPrevious.exitCode !== 0) {
    throw new Error(
      "PocketJS iPhone 2G: could not stop the previous app before deployment",
    );
  }
  recoverPendingDeviceTransaction();
  const clearStatus = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "clear-status",
  ]);
  if (clearStatus.exitCode !== 0) {
    throw new Error(
      "PocketJS iPhone 2G: could not clear the previous runtime acceptance record",
    );
  }
  const install = deviceCommand(
    ["/usr/libexec/pocketjs-device", "install"],
    deploymentPackage(bundle, identifier),
  );
  if (install.exitCode !== 0) {
    const rollback = rollbackDeviceInstall(identifier);
    throw new Error(
      `PocketJS iPhone 2G: device install failed (${install.exitCode})${install.stderr.trim() ? `:\n${install.stderr.trim()}` : ""}${rollback ? `\n${rollback}` : ""}`,
    );
  }

  try {
    for (const name of DEVICE_BUNDLE_FILES) {
      const local = readFileSync(join(bundle, name));
      const remote = deviceCommand([
        "/usr/libexec/pocketjs-device",
        "read",
        name,
      ]);
      if (
        remote.exitCode !== 0 ||
        sha256Bytes(remote.stdout) !== sha256Bytes(local)
      ) {
        throw new Error(
          `PocketJS iPhone 2G: read-back verification failed for ${name}`,
        );
      }
    }
    ensureDeviceMountPolicy();
    const commit = deviceCommand([
      "/usr/libexec/pocketjs-device",
      "commit",
      identifier,
    ]);
    if (commit.exitCode !== 0) {
      throw new Error(
        `PocketJS iPhone 2G: device transaction commit failed (${commit.exitCode})`,
      );
    }
    ensureDeviceMountPolicy();
  } catch (error) {
    const rollback = rollbackDeviceInstall(identifier);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}${rollback ? `\n${rollback}` : ""}`);
  }
  const refresh = deviceCommand([
    "/bin/sh",
    "-c",
    shellQuote("cd / && /bin/su mobile -c '/usr/bin/uicache'"),
  ]);
  if (refresh.exitCode !== 0) {
    throw new Error(
      `PocketJS iPhone 2G: app committed, but uicache refresh failed (${refresh.exitCode})${refresh.stderr.trim() ? `: ${refresh.stderr.trim()}` : ""}`,
    );
  }
  const restart = deviceCommand([
    "/bin/launchctl",
    "stop",
    "com.apple.SpringBoard",
  ]);
  if (restart.exitCode !== 0) {
    throw new Error(
      `PocketJS iPhone 2G: app verified, but SpringBoard restart failed (${restart.exitCode})`,
    );
  }
  console.log(
    "PocketJS iPhone 2G: app installed, read back byte-exactly, with root/data still read-write",
  );
  console.log(
    "PocketJS iPhone 2G: application cache refreshed and SpringBoard restarted; launch PocketJS Demo for live acceptance",
  );
}

function launchDemo(): void {
  const localReceipt = join(
    repository,
    "dist/iphone2g/PocketJSDemo.app/build-receipt.json",
  );
  if (!existsSync(localReceipt)) {
    throw new Error(
      "PocketJS iPhone 2G: build and deploy the demo before launching it",
    );
  }
  const remoteReceipt = deviceCommand([
    "/usr/libexec/pocketjs-device",
    "read",
    "build-receipt.json",
  ]);
  if (
    remoteReceipt.exitCode !== 0 ||
    sha256Bytes(remoteReceipt.stdout) !== sha256File(localReceipt)
  ) {
    throw new Error(
      "PocketJS iPhone 2G: installed app does not match the current local build; deploy first",
    );
  }
  const launch = deviceCommand([
    "/usr/bin/uiopen",
    "pocketjs-iphone2g-demo://launch",
  ]);
  if (launch.exitCode !== 0) {
    throw new Error(
      `PocketJS iPhone 2G: SpringBoard launch request failed (${launch.exitCode})${launch.stderr.trim() ? `: ${launch.stderr.trim()}` : ""}`,
    );
  }
  console.log(
    "PocketJS iPhone 2G: launch requested through SpringBoard; tap the blue target for acceptance",
  );
}

const IPHONE2G_STATUS_FIELDS = [
  "schema",
  "build_id",
  "state",
  "pid",
  "written_at",
  "heartbeat",
  "guest_frames",
  "touch_sequences",
  "completed_touch_sequences",
  "touch_down",
  "last_touch_x",
  "last_touch_y",
  "last_touch_hit",
  "action_name",
  "action_value",
  "action_sequence",
  "error",
] as const;

export type IPhone2GDeviceStatus = Readonly<
  Record<(typeof IPHONE2G_STATUS_FIELDS)[number], string>
>;

function statusCounter(
  fields: IPhone2GDeviceStatus,
  name: keyof IPhone2GDeviceStatus,
): bigint {
  return BigInt(fields[name]);
}

export function parseIPhone2GDeviceStatus(
  text: string,
  expectedBuildId: string,
  expectedAction: string = "hero_tap",
): IPhone2GDeviceStatus {
  const lines = text.trim().split(/\r?\n/);
  const pairs = lines.map((line) => {
    const separator = line.indexOf("=");
    return separator >= 0
      ? [line.slice(0, separator), line.slice(separator + 1)]
      : [line, ""];
  });
  const fieldNames = pairs.map(([name]) => name);
  const fields = Object.fromEntries(pairs) as IPhone2GDeviceStatus;
  const countersAreValid = (
    [
      "pid",
      "written_at",
      "heartbeat",
      "guest_frames",
      "touch_sequences",
      "completed_touch_sequences",
      "last_touch_x",
      "last_touch_y",
      "last_touch_hit",
      "action_value",
      "action_sequence",
    ] as const
  ).every((name) => /^(0|[1-9][0-9]*)$/.test(fields[name] ?? ""));
  const positiveAcceptanceCounters = (
    [
      "pid",
      "written_at",
      "heartbeat",
      "guest_frames",
      "touch_sequences",
      "completed_touch_sequences",
      "action_value",
      "action_sequence",
    ] as const
  ).every((name) => /^[1-9][0-9]*$/.test(fields[name] ?? ""));
  if (
    JSON.stringify(fieldNames) !== JSON.stringify(IPHONE2G_STATUS_FIELDS) ||
    fields.schema !== "2" ||
    !/^[0-9a-f]{32}$/.test(fields.build_id ?? "") ||
    fields.build_id !== expectedBuildId ||
    !countersAreValid ||
    !positiveAcceptanceCounters ||
    fields.touch_down !== "0" ||
    fields.action_name !== expectedAction ||
    statusCounter(fields, "completed_touch_sequences") >
      statusCounter(fields, "touch_sequences") ||
    fields.state !== "running" ||
    fields.error !== ""
  ) {
    throw new Error(
      `PocketJS iPhone 2G: runtime acceptance requires a released touch and a completed ${expectedAction} action`,
    );
  }
  return fields;
}

export function assertIPhone2GStatusAdvanced(
  previous: IPhone2GDeviceStatus,
  current: IPhone2GDeviceStatus,
): void {
  if (
    current.build_id !== previous.build_id ||
    current.pid !== previous.pid ||
    statusCounter(current, "heartbeat") <=
      statusCounter(previous, "heartbeat") ||
    statusCounter(current, "written_at") <
      statusCounter(previous, "written_at") ||
    statusCounter(current, "guest_frames") <=
      statusCounter(previous, "guest_frames") ||
    statusCounter(current, "action_sequence") <
      statusCounter(previous, "action_sequence")
  ) {
    throw new Error(
      "PocketJS iPhone 2G: runtime status is stale or the accepted process was replaced",
    );
  }
}

function assertDeviceProcessAlive(pid: string): void {
  const result = deviceCommand(["/bin/sh", "-c", shellQuote(`kill -0 ${pid}`)]);
  if (result.exitCode !== 0) {
    throw new Error(
      `PocketJS iPhone 2G: accepted runtime process ${pid} is no longer alive`,
    );
  }
}

function readCurrentDeviceStatus(buildId: string): {
  readonly text: string;
  readonly fields: IPhone2GDeviceStatus;
} {
  const status = deviceCommand(["/usr/libexec/pocketjs-device", "status"]);
  if (status.exitCode !== 0) {
    throw new Error(
      "PocketJS iPhone 2G: no runtime acceptance record is available; launch the app first",
    );
  }
  const text = status.stdout.toString();
  return {
    text,
    fields: parseIPhone2GDeviceStatus(text, buildId, iphone2gExpectedAction()),
  };
}

async function printDeviceStatus(): Promise<void> {
  const receiptPath = join(
    repository,
    "dist/iphone2g/PocketJSDemo.app/build-receipt.json",
  );
  const receipt = existsSync(receiptPath)
    ? (JSON.parse(readFileSync(receiptPath, "utf8")) as { buildId?: string })
    : undefined;
  if (!receipt?.buildId || !/^[0-9a-f]{32}$/.test(receipt.buildId)) {
    throw new Error(
      "PocketJS iPhone 2G: current local build receipt is absent or invalid",
    );
  }

  const previous = readCurrentDeviceStatus(receipt.buildId);
  assertDeviceProcessAlive(previous.fields.pid);
  await Bun.sleep(1_500);
  const current = readCurrentDeviceStatus(receipt.buildId);
  assertDeviceProcessAlive(current.fields.pid);
  assertIPhone2GStatusAdvanced(previous.fields, current.fields);
  process.stdout.write(
    current.text.endsWith("\n") ? current.text : `${current.text}\n`,
  );
}

function usage(): never {
  console.error(
    "usage: bun tools/iphone2g.ts <doctor|setup-sources|setup-csu|prepare-bootstrap|install-bootstrap|tunnel|build-demo|build-runtime|build-probe|build|deploy|launch|device-status>",
  );
  process.exit(64);
}

if (import.meta.main) {
  try {
    if (command === "doctor") doctor();
    else if (command === "setup-csu") {
      ensureCsu();
      console.log(
        `PocketJS iPhone 2G: verified Apple Csu -> ${iphone2gCsuPath()}`,
      );
    } else if (command === "setup-sources") {
      ensureSources();
      console.log(
        `PocketJS iPhone 2G: verified Apple Csu -> ${iphone2gCsuPath()}`,
      );
      console.log(
        `PocketJS iPhone 2G: verified QuickJS -> ${iphone2gQuickJsPath()}`,
      );
      console.log(
        `PocketJS iPhone 2G: verified Legacy-iOS-Kit -> ${iphone2gLegacyKitPath()}`,
      );
    } else if (command === "build-demo") buildDemo();
    else if (command === "prepare-bootstrap") prepareBootstrap();
    else if (command === "install-bootstrap") await installBootstrap();
    else if (command === "tunnel") runTunnel();
    else if (command === "build-runtime" || command === "build-probe") {
      await runProgramBuild("iphone2g", Bun.argv.slice(3));
    } else if (command === "build") {
      await runProgramBuild("iphone2g", Bun.argv.slice(3));
    } else if (command === "deploy") await withManagedTunnel(deployDemo);
    else if (command === "launch") await withManagedTunnel(launchDemo);
    else if (command === "device-status")
      await withManagedTunnel(printDeviceStatus);
    else usage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
