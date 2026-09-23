import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGuestBundle,
  ensureQuickJsCheckout,
  type GuestBundle,
  type GuestBundleRequest,
  mustRunCommand,
  packageIdentity,
  type PackageIdentity,
  printCheck,
  quickJsCheckout,
  quickJsCheckoutStatus,
  readGuestBundle,
  renderTemplate,
  runCommand,
  sha256File,
  xmlEscape,
} from "./native-host-build.ts";

import { MOTO_G_PLAY_TARGET, resolveMotoGPlayBuildPlan } from "./moto-g-play-profile.ts";
const profile = "moto-g-play";
const requestedProfile = Bun.argv.slice(2).find(arg => arg.startsWith("--profile="))?.slice(10);
if (requestedProfile !== undefined && requestedProfile !== profile) {
  throw new Error(`Unsupported Android profile: ${requestedProfile}; use ${profile}`);
}
const LABEL = `PocketJS Android (${profile})`;
const target = MOTO_G_PLAY_TARGET;
const repository = fileURLToPath(new URL("..", import.meta.url));
const command = Bun.argv.slice(2).find(a => !a.startsWith("--")) ?? "doctor";
const toolchain = JSON.parse(
  readFileSync(
    join(repository, `tools/cli/${profile}-toolchain.json`),
    "utf8",
  ),
) as {
  readonly toolchainVersion: string;
  readonly cachePath: string;
  readonly quickjs: {
    readonly version: string;
    readonly repository: string;
    readonly revision: string;
  };
  readonly rust: {
    readonly toolchain: string;
    readonly target: string;
  };
  readonly android: {
    readonly apiLevel: number;
    readonly platformVersion: string;
    readonly buildToolsVersion: string;
    readonly ndkVersion: string;
    readonly abi: string;
    readonly clangTarget: string;
  };
  readonly app: {
    readonly manifest: string;
    readonly output: string;
  };
};

/**
 * The NDK ships one LLVM prebuilt per host operating system. Linux x86-64 is
 * the verified host; the macOS prebuilt is x86-64 as well and runs under
 * Rosetta on Apple silicon.
 */
function ndkHostTag(): string {
  switch (process.platform) {
    case "linux":
      return "linux-x86_64";
    case "darwin":
      return "darwin-x86_64";
    default:
      throw new Error(`${LABEL}: no NDK ${toolchain.android.ndkVersion} prebuilt for host ${process.platform}`);
  }
}

const cache = join(homedir(), ".cache/pocket-stack", toolchain.cachePath);
const sdk = process.env.POCKETJS_ANDROID_SDK_ROOT ?? (process.platform === "darwin" ? "/opt/homebrew/share/android-commandlinetools" : join(cache, "sdk"));
const buildTools = join(sdk, "build-tools", toolchain.android.buildToolsVersion);
const ndk = join(sdk, "ndk", toolchain.android.ndkVersion);
const llvm = join(ndk, "toolchains/llvm/prebuilt", ndkHostTag(), "bin");
const clang = join(llvm, `${toolchain.android.clangTarget}-clang`);
const readelf = join(llvm, "llvm-readelf");
const androidJar = join(
  sdk,
  "platforms",
  `android-${toolchain.android.apiLevel}`,
  "android.jar",
);
const appHost = join(repository, "hosts/android/app");
const build = join(repository, `.pocket-build/${profile}`);
const staging = join(build, "staging");
const appOutput = join(repository, toolchain.app.output);
const signing = join(cache, "signing");
/* Moto builds also used these legacy cache filenames. Reuse an existing key
 * so installed Android apps can still upgrade; new caches use android-debug.jks. */
const keystoreName = ["blackberry-android-probe.jks", "blackberry-classic.jks", "android-debug.jks"]
  .find(name => existsSync(join(signing, name))) ?? "android-debug.jks";
const keystore = join(signing, keystoreName);
const quickJs = quickJsCheckout(join(cache, "sources/quickjs-rs"));
const guest: GuestBundleRequest = {
  label: LABEL,
  repository,
  target,
  resolvePlan: resolveMotoGPlayBuildPlan,
  manifestPath: join(repository, toolchain.app.manifest),
  planPath: join(repository, `.pocket/${profile}/app.plan.json`),
  outputDirectory: join(repository, `dist/${profile}/guest`),
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

const javaHome = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@17";

function runJava(args: readonly string[]): string {
  const mapped = args.map(a => a.replace(/^\/repo(?=\/)/, repository).replace(/^\/android-sdk(?=\/)/, sdk)
    .replace(/^\/build(?=\/)/, build).replace(/^\/signing(?=\/)/, signing));
  const program = mapped[0].includes("/") ? mapped[0] : join(javaHome, "bin", mapped[0]);
  return mustRun(program, mapped.slice(1), repository, { ...process.env, JAVA_HOME: javaHome });
}

function javaInstalled(): boolean {
  return existsSync(join(javaHome, "bin/javac"));
}

function sdkPackages(): string[] {
  return [
    `platforms;android-${toolchain.android.apiLevel}`,
    `build-tools;${toolchain.android.buildToolsVersion}`,
    `ndk;${toolchain.android.ndkVersion}`,
  ];
}

/**
 * Checks the target's std directory in the pinned toolchain's sysroot. `rustup
 * target list --toolchain X` would install a missing X on the spot, which a
 * doctor must not do.
 */
function rustTargetInstalled(): boolean {
  const sysroot = run("rustup", ["run", toolchain.rust.toolchain, "rustc", "--print", "sysroot"]);
  if (sysroot.exitCode !== 0) return false;
  return existsSync(
    join(sysroot.stdout.trim(), "lib/rustlib", toolchain.rust.target, "lib"),
  );
}

function checkPath(label: string, path: string): boolean {
  return printCheck(label, existsSync(path), path);
}

function doctor(): void {
  const rust = run("rustup", ["run", toolchain.rust.toolchain, "rustc", "--version"]);
  const quickjs = quickJsCheckoutStatus(quickJs.root, toolchain.quickjs);
  const sdkChecks = [
    checkPath(`Android SDK Platform ${toolchain.android.apiLevel}`, androidJar),
    checkPath(`NDK ${toolchain.android.ndkVersion} clang`, clang),
    checkPath("NDK llvm-readelf", readelf),
    checkPath("aapt2", join(buildTools, "aapt2")),
    checkPath("aapt", join(buildTools, "aapt")),
    checkPath("d8", join(buildTools, "d8")),
    checkPath("zipalign", join(buildTools, "zipalign")),
    checkPath("apksigner", join(buildTools, "apksigner")),
  ];
  const checks = [
    ...sdkChecks,
    printCheck("Java 17", javaInstalled(), javaHome),
    printCheck(
      "Rust nightly",
      rust.exitCode === 0,
      rust.stdout.trim() || toolchain.rust.toolchain,
    ),
    printCheck(
      "Rust Android target",
      rustTargetInstalled(),
      `${toolchain.rust.target} on ${toolchain.rust.toolchain}`,
    ),
    printCheck("pinned QuickJS", quickjs.ok, quickjs.detail),
  ];
  if (sdkChecks.some((ok) => !ok)) {
    console.log(
      `Run \`bun android setup\` to install the pinned SDK packages into ${sdk}, ` +
        `or point POCKETJS_ANDROID_SDK_ROOT at an SDK that already holds ` +
        `${sdkPackages().join(", ")}.`,
    );
  }
  if (checks.some((ok) => !ok)) process.exitCode = 1;
  else console.log(`[ok] toolchain: ${toolchain.toolchainVersion}`);
}

function requireToolchain(): void {
  doctor();
  if (process.exitCode) {
    throw new Error(`${LABEL}: toolchain is incomplete; see the doctor report above`);
  }
}

function setup(): void {
  if (!javaInstalled()) throw new Error("Install Java 17 and set JAVA_HOME");
  const manager = join(sdk, "cmdline-tools/latest/bin/sdkmanager");
  mustRun(manager, [`--sdk_root=${sdk}`, ...sdkPackages()], repository,
    { ...process.env, JAVA_HOME: javaHome });
  ensureQuickJsCheckout(LABEL, quickJs.root, toolchain.quickjs);
  if (!rustTargetInstalled()) {
    mustRun("rustup", [
      "target",
      "add",
      toolchain.rust.target,
      "--toolchain",
      toolchain.rust.toolchain,
    ]);
  }
  doctor();
}

function ensureKeystore(): void {
  mkdirSync(signing, { recursive: true });
  if (existsSync(keystore)) return;
  runJava([
    "keytool",
    "-genkeypair",
    "-noprompt",
    "-keystore",
    `/signing/${keystoreName}`,
    "-storepass",
    "android",
    "-alias",
    "androiddebugkey",
    "-keypass",
    "android",
    "-dname",
    "CN=PocketJS Android,O=PocketJS,C=HK",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
  ]);
}

/** javac → jar → d8 for PocketActivity, into staging/classes.dex. */
function compileActivity(): void {
  mkdirSync(join(build, "classes"), { recursive: true });
  mkdirSync(join(build, "dex"), { recursive: true });
  runJava([
    "javac",
    "-encoding",
    "UTF-8",
    "-source",
    "8",
    "-target",
    "8",
    "-bootclasspath",
    `/android-sdk/platforms/android-${toolchain.android.apiLevel}/android.jar`,
    "-d",
    "/build/classes",
    "/repo/hosts/android/app/src/dev/pocketstack/android/PocketActivity.java",
  ]);
  runJava(["jar", "cf", "/build/classes.jar", "-C", "/build/classes", "."]);
  runJava([
    `/android-sdk/build-tools/${toolchain.android.buildToolsVersion}/d8`,
    "--min-api",
    "23",
    "--output",
    "/build/dex",
    "/build/classes.jar",
  ]);
  copyFileSync(join(build, "dex/classes.dex"), join(staging, "classes.dex"));
}

/**
 * aapt2 → zipalign → apksigner over staging/ (classes.dex + lib/) plus the
 * guest assets. APKs carry v1 and v2 signatures for Android API 23 and later.
 */
function packageApk(identity: PackageIdentity, resources: string, assets: string): {
  readonly signature: string;
  readonly badging: string;
} {
  const compiled = join(build, "app-res.zip");
  mustRun(join(buildTools, "aapt2"), ["compile", "--dir", resources, "-o", compiled]);
  const manifest = join(build, "AndroidManifest.xml");
  writeFileSync(
    manifest,
    renderTemplate(readFileSync(join(appHost, "AndroidManifest.xml"), "utf8"), {
      PACKAGE: identity.packageId,
      VERSION_CODE: identity.versionCode,
      VERSION_NAME: identity.version,
    }),
  );
  const unsigned = join(build, "app-unsigned.apk");
  mustRun(join(buildTools, "aapt2"), [
    "link",
    "-o",
    unsigned,
    "--manifest",
    manifest,
    "-I",
    androidJar,
    "-A",
    assets,
    "--min-sdk-version",
    "23",
    "--target-sdk-version",
    String(toolchain.android.apiLevel),
    compiled,
  ]);
  mustRun("zip", ["-q", "-r", unsigned, "classes.dex", "lib"], staging);
  const aligned = join(build, "app-aligned.apk");
  mustRun(join(buildTools, "zipalign"), ["-f", "-p", "4", unsigned, aligned]);
  ensureKeystore();
  runJava([
    `/android-sdk/build-tools/${toolchain.android.buildToolsVersion}/apksigner`,
    "sign",
    "--ks",
    `/signing/${keystoreName}`,
    "--ks-key-alias",
    "androiddebugkey",
    "--ks-pass",
    "pass:android",
    "--key-pass",
    "pass:android",
    "--min-sdk-version",
    "23",
    "--v1-signing-enabled",
    "true",
    "--v2-signing-enabled",
    "true",
    "--v3-signing-enabled",
    "false",
    "--v4-signing-enabled",
    "false",
    "--out",
    "/build/app-signed.apk",
    "/build/app-aligned.apk",
  ]);
  mkdirSync(dirname(appOutput), { recursive: true });
  copyFileSync(join(build, "app-signed.apk"), appOutput);
  const signature = runJava([
    `/android-sdk/build-tools/${toolchain.android.buildToolsVersion}/apksigner`,
    "verify",
    "--verbose",
    "--print-certs",
    "--min-sdk-version",
    "23",
    "/build/app-signed.apk",
  ]);
  const badging = mustRun(join(buildTools, "aapt"), ["dump", "badging", appOutput]);
  return { signature, badging };
}

function resetBuild(): void {
  rmSync(build, { recursive: true, force: true });
  mkdirSync(join(staging, "lib", toolchain.android.abi), { recursive: true });
}

function buildRustCore(): string {
  const rustTarget = join(build, "rust");
  mustRun(
    "rustup",
    [
      "run",
      toolchain.rust.toolchain,
      "cargo",
      "build",
      "--release",
      "--locked",
      "--target",
      toolchain.rust.target,
      "--features",
      "bare-platform",
      "--target-dir",
      rustTarget,
    ],
    join(repository, "engine/ui-cabi"),
    {
      ...process.env,
      CARGO_PROFILE_RELEASE_LTO: "false",
      CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: clang,
    },
  );
  const library = join(rustTarget, toolchain.rust.target, "release/libpocketjs_symbian_core.a");
  if (!existsSync(library)) {
    throw new Error(`${LABEL}: Rust core archive is absent: ${library}`);
  }
  return library;
}

function buildQuickJs(): string {
  const objects = join(build, "objects/quickjs");
  mkdirSync(objects, { recursive: true });
  const flags = [
    "-std=gnu11",
    "-O2",
    "-fPIC",
    "-funsigned-char",
    "-fno-strict-aliasing",
    "-ffunction-sections",
    "-fdata-sections",
    "-D_GNU_SOURCE",
    `-DCONFIG_VERSION="${toolchain.quickjs.version}"`,
    `-I${quickJs.source}`,
  ];
  const objectPaths: string[] = [];
  for (const source of ["cutils.c", "dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"]) {
    const object = join(objects, source.replace(/\.c$/, ".o"));
    mustRun(clang, [...flags, "-c", join(quickJs.source, source), "-o", object]);
    objectPaths.push(object);
  }
  const staticFunctions = join(objects, "static-functions.o");
  mustRun(clang, [...flags, "-c", quickJs.staticFunctions, "-o", staticFunctions]);
  objectPaths.push(staticFunctions);
  const library = join(build, "libquickjs.a");
  mustRun(join(llvm, "llvm-ar"), ["rcs", library, ...objectPaths]);
  return library;
}

function buildNativeLibrary(bundle: GuestBundle, quickJsLibrary: string, coreLibrary: string): string {
  const objects = join(build, "objects");
  const cFlags = [
    "-std=gnu11",
    "-Os",
    "-fPIC",
    "-fno-strict-aliasing",
    "-ffunction-sections",
    "-fdata-sections",
    "-fvisibility=hidden",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wno-unused-parameter",
    "-DPOCKET_OFFLOAD_POSIX",
    `-I${join(repository, "hosts/shared")}`,
  ];
  const portableRuntime = join(objects, "pocket_runtime.o");
  mustRun(clang, [
    ...cFlags,
    `-DPOCKETJS_TARGET_ID="${bundle.inputs.target}"`,
    `-DPOCKETJS_HOST_ABI=${bundle.inputs.hostAbi}`,
    `-DPOCKET_RASTER_DENSITY=${bundle.inputs.viewport.rasterDensity}`,
    `-I${join(repository, "engine/quickjs-c")}`,
    `-I${join(repository, "engine/ui-cabi/include")}`,
    `-I${join(repository, "contracts/generated")}`,
    `-I${quickJs.source}`,
    "-c",
    join(repository, "engine/quickjs-c/pocket_runtime.c"),
    "-o",
    portableRuntime,
  ]);
  const androidRuntime = join(objects, "android_runtime.o");
  mustRun(clang, [
    ...cFlags,
    `-DPOCKET_LOGICAL_WIDTH=${bundle.inputs.viewport.logical[0]}`,
    `-DPOCKET_LOGICAL_HEIGHT=${bundle.inputs.viewport.logical[1]}`,
    `-I${join(repository, "engine/quickjs-c")}`,
    `-I${join(repository, "hosts/blackberry-classic")}`,
    `-I${join(repository, "contracts/generated")}`,
    "-c",
    join(appHost, "jni/runtime.c"),
    "-o",
    androidRuntime,
  ]);
  const sharedSources = [
    {
      name: "pocket_input",
      source: join(repository, "hosts/blackberry-classic/pocket_input.c"),
      includes: [
        `-I${join(repository, "hosts/blackberry-classic")}`,
        `-I${join(repository, "contracts/generated")}`,
      ],
    },
    {
      name: "rust_eh_personality",
      source: join(repository, "engine/quickjs-c/rust_eh_personality.c"),
      includes: [],
    },
  ] satisfies Array<{ name: string; source: string; includes: string[] }>;
  sharedSources.push({ name: "offload_posix", source: join(repository, "hosts/shared/offload_posix.c"), includes: [] });
  const sharedObjects = sharedSources.map(({ name, source, includes }) => {
    const object = join(objects, `${name}.o`);
    mustRun(clang, [
      ...cFlags,
      ...includes,
      "-c",
      source,
      "-o",
      object,
    ]);
    return object;
  });
  const nativeLibrary = join(staging, "lib", toolchain.android.abi, "libpocketjs.so");
  /* No -landroid: the library needs nothing beyond GLESv2/log/dl/m/c, and
   * --no-undefined turns any missing native symbol into a link failure. */
  mustRun(clang, [
    "-shared",
    "-Wl,--build-id=none",
    "-Wl,--gc-sections",
    "-Wl,--exclude-libs,ALL",
    "-Wl,--no-undefined",
    androidRuntime,
    portableRuntime,
    ...sharedObjects,
    quickJsLibrary,
    coreLibrary,
    "-o",
    nativeLibrary,
    "-lGLESv2",
    "-llog",
    "-ldl",
    "-lm",
  ]);
  return nativeLibrary;
}

function buildApp(): void {
  requireToolchain();
  const bundle = readGuestBundle(guest);
  resetBuild();
  const coreLibrary = buildRustCore();
  const quickJsLibrary = buildQuickJs();
  const nativeLibrary = buildNativeLibrary(bundle, quickJsLibrary, coreLibrary);
  compileActivity();

  const assets = join(build, "assets");
  mkdirSync(assets, { recursive: true });
  copyFileSync(bundle.javaScript, join(assets, "app.js"));
  copyFileSync(bundle.pack, join(assets, "app.pak"));
  const identity = packageIdentity(bundle.inputs.app);
  const resources = join(build, "resources");
  cpSync(join(appHost, "res"), resources, { recursive: true });
  writeFileSync(
    join(resources, "values/strings.xml"),
    renderTemplate(readFileSync(join(appHost, "res/values/strings.xml"), "utf8"), {
      /* Android string resources also need apostrophes escaped. */
      TITLE: xmlEscape(identity.title).replace(/'/g, "\\'"),
    }),
  );
  mkdirSync(join(resources, "drawable"), { recursive: true });
  copyFileSync(
    join(repository, "assets/images/logo.png"),
    join(resources, "drawable/icon.png"),
  );
  const { signature, badging } = packageApk(identity, resources, assets);
  for (const marker of [
    `package: name='${identity.packageId}' versionCode='${identity.versionCode}' versionName='${identity.version}'`,
    "sdkVersion:'23'",
  ]) {
    if (!badging.includes(marker)) {
      throw new Error(`${LABEL}: APK badging is missing ${marker}`);
    }
  }
  const receipt = {
    schema: 1,
    toolchain: toolchain.toolchainVersion,
    planHash: bundle.plan.planHash,
    package: identity,
    target: bundle.inputs.target,
    hostAbi: bundle.inputs.hostAbi,
    viewport: bundle.inputs.viewport,
    apk: {
      path: toolchain.app.output,
      bytes: readFileSync(appOutput).byteLength,
      sha256: sha256File(appOutput),
    },
    guest: {
      javaScript: sha256File(bundle.javaScript),
      pack: sha256File(bundle.pack),
    },
    nativeLibrary: {
      bytes: readFileSync(nativeLibrary).byteLength,
      sha256: sha256File(nativeLibrary),
      elf: mustRun(readelf, ["-h", "-A", "-d", nativeLibrary]),
    },
    quickjs: {
      version: toolchain.quickjs.version,
      revision: toolchain.quickjs.revision,
    },
    rust: toolchain.rust,
    signature,
    badging,
  };
  const receiptPath = join(dirname(appOutput), `${profile}.receipt.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`${LABEL}: APK -> ${appOutput}`);
  console.log(`SHA-256: ${receipt.apk.sha256}`);
  console.log(`Receipt: ${receiptPath}`);
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
  case "build-app":
    buildApp();
    break;
  case "build":
    buildGuestBundle(guest);
    buildApp();
    break;
  default:
    throw new Error(
      `usage: bun tools/android.ts [--profile=moto-g-play] <doctor|setup|build-demo|build-app|build>`,
    );
}
