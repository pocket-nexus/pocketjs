import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGuestBundle,
  buildGuestBundleFromPlan,
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
import { REDMI_1S_TARGET, resolveRedmi1sBuildPlan } from "./redmi-1s-profile.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";

/**
 * One Android host (hosts/android), built for a named device profile. A
 * profile is its target id, the resolver of that target, and the toolchain
 * file `tools/cli/<profile>-toolchain.json`.
 */
const PROFILES: Readonly<Record<string, {
  readonly target: string;
  readonly resolvePlan: (manifest: unknown) => ResolvedBuildPlan;
}>> = {
  "moto-g-play": { target: MOTO_G_PLAY_TARGET, resolvePlan: resolveMotoGPlayBuildPlan },
  "redmi-1s": { target: REDMI_1S_TARGET, resolvePlan: resolveRedmi1sBuildPlan },
};
const argv = Bun.argv.slice(2);
function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}
const profile = option("profile") ?? "moto-g-play";
if (!(profile in PROFILES)) {
  throw new Error(`Unsupported Android profile: ${profile}; use ${Object.keys(PROFILES).join(" or ")}`);
}
const LABEL = `PocketJS Android (${profile})`;
const { target, resolvePlan } = PROFILES[profile];
const repository = fileURLToPath(new URL("..", import.meta.url));
const command = argv.find(a => !a.startsWith("--")) ?? "doctor";
/** A resolved plan for the profile's target, in place of the toolchain file's manifest. */
const planOption = option("plan");
const projectRoot = resolve(option("project-root") ?? repository);
const outOption = option("out");
/** Signed with the Pocket Nexus Android release key and not debuggable. */
const release = argv.includes("--release");

interface AndroidAbi {
  /** The APK's `lib/<abi>` directory. */
  readonly abi: string;
  /** The NDK clang wrapper's prefix; its trailing number is the API level it links against. */
  readonly clangTarget: string;
  readonly rustTarget: string;
  readonly cFlags?: readonly string[];
  readonly linkFlags?: readonly string[];
}
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
  };
  readonly android: {
    /** The platform whose android.jar the Activity compiles against. */
    readonly apiLevel: number;
    readonly platformVersion: string;
    readonly buildToolsVersion: string;
    readonly ndkVersion: string;
    readonly minSdkVersion: number;
    readonly targetSdkVersion: number;
    readonly abis: readonly AndroidAbi[];
  };
  readonly app: {
    readonly manifest: string;
    readonly output: string;
  };
};
const { minSdkVersion, targetSdkVersion, abis } = toolchain.android;

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

const cache = join(homedir(), ".cache/pocket-nexus", toolchain.cachePath);
const sdk = process.env.POCKETJS_ANDROID_SDK_ROOT ?? (process.platform === "darwin" ? "/opt/homebrew/share/android-commandlinetools" : join(cache, "sdk"));
const buildTools = join(sdk, "build-tools", toolchain.android.buildToolsVersion);
const ndk = join(sdk, "ndk", toolchain.android.ndkVersion);
const llvm = join(ndk, "toolchains/llvm/prebuilt", ndkHostTag(), "bin");
const clangFor = (abi: AndroidAbi) => join(llvm, `${abi.clangTarget}-clang`);
/** The API level an ABI's library links against: the number its clang wrapper ends in. */
function abiApiLevel(abi: AndroidAbi): number {
  const match = /(\d+)$/.exec(abi.clangTarget);
  if (!match) throw new Error(`${LABEL}: ${abi.clangTarget} names no API level`);
  return Number(match[1]);
}
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
const appOutput = outOption ? resolve(outOption) : join(repository, toolchain.app.output);
/** The receipt stands beside the APK: `<profile>.receipt.json` beside the toolchain file's output, `<name>.receipt.json` beside `--out=<name>.apk`. */
const receiptPath = outOption
  ? appOutput.replace(/\.apk$/, "") + ".receipt.json"
  : join(dirname(appOutput), `${profile}.receipt.json`);
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
  resolvePlan,
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
function rustTargetInstalled(rustTarget: string): boolean {
  const sysroot = run("rustup", ["run", toolchain.rust.toolchain, "rustc", "--print", "sysroot"]);
  if (sysroot.exitCode !== 0) return false;
  return existsSync(
    join(sysroot.stdout.trim(), "lib/rustlib", rustTarget, "lib"),
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
    ...abis.map(abi => checkPath(`NDK ${toolchain.android.ndkVersion} clang (${abi.abi})`, clangFor(abi))),
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
    ...abis.map(abi => printCheck(
      `Rust Android target (${abi.abi})`,
      rustTargetInstalled(abi.rustTarget),
      `${abi.rustTarget} on ${toolchain.rust.toolchain}`,
    )),
    printCheck("pinned QuickJS", quickjs.ok, quickjs.detail),
  ];
  if (sdkChecks.some((ok) => !ok)) {
    console.log(
      `Run \`bun android --profile=${profile} setup\` to install the pinned SDK packages into ${sdk}, ` +
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
  for (const abi of abis) {
    if (rustTargetInstalled(abi.rustTarget)) continue;
    mustRun("rustup", [
      "target",
      "add",
      abi.rustTarget,
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

/**
 * What apksigner signs with. A development build: the debug key in the
 * toolchain cache. A release: the Pocket Nexus Android release key, a PKCS #12
 * keystore outside every repository that `POCKET_NEXUS_ANDROID_KEY` names
 * (default `~/.config/pocket-nexus/signing/pocket-nexus-android-release.p12`,
 * alias `pocket-nexus`). Its password is the first line of the `.password`
 * file beside it, which apksigner reads itself, so it is in no command line
 * and no log.
 */
function signerArguments(): string[] {
  if (!release) {
    ensureKeystore();
    return [
      "--ks", keystore,
      "--ks-key-alias", "androiddebugkey",
      "--ks-pass", "pass:android",
      "--key-pass", "pass:android",
    ];
  }
  const key = process.env.POCKET_NEXUS_ANDROID_KEY ||
    join(homedir(), ".config/pocket-nexus/signing/pocket-nexus-android-release.p12");
  const password = key.replace(/\.[^./]*$/, "") + ".password";
  for (const file of [key, password]) {
    if (!existsSync(file)) {
      throw new Error(
        `${LABEL}: a release is signed with the Pocket Nexus Android release key, and ${file} is absent ` +
          `(POCKET_NEXUS_ANDROID_KEY names the keystore; its password is the first line of the .password file beside it)`,
      );
    }
  }
  return ["--ks", key, "--ks-type", "PKCS12", "--ks-pass", `file:${password}`, "--ks-key-alias", "pocket-nexus"];
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
    "/repo/hosts/android/app/src/dev/pocketnexus/android/PocketActivity.java",
  ]);
  runJava(["jar", "cf", "/build/classes.jar", "-C", "/build/classes", "."]);
  runJava([
    `/android-sdk/build-tools/${toolchain.android.buildToolsVersion}/d8`,
    "--min-api",
    String(minSdkVersion),
    "--output",
    "/build/dex",
    "/build/classes.jar",
  ]);
  copyFileSync(join(build, "dex/classes.dex"), join(staging, "classes.dex"));
}

/**
 * aapt2 → zip → zipalign → apksigner over staging/ (classes.dex + lib/) plus
 * the guest assets. APKs carry v1 and v2 signatures, which Android reads from
 * the profile's minSdkVersion on.
 *
 * Two builds of one checkout give the same bytes: aapt2 dates its entries
 * 1980-01-01; `zip` dates an entry by its file and adds the file's access
 * time, so the staged files take aapt2's date, `-X` leaves the access times
 * out, and the entries are named in a fixed order; apksigner dates its own
 * entries by one of its input's.
 */
function packageApk(identity: PackageIdentity, resources: string, assets: string): {
  readonly signature: string;
  readonly certificateSha256: string;
  readonly badging: string;
} {
  // Before any packaging: a release without its key stops here.
  const signer = signerArguments();
  const compiled = join(build, "app-res.zip");
  mustRun(join(buildTools, "aapt2"), ["compile", "--dir", resources, "-o", compiled]);
  const manifest = join(build, "AndroidManifest.xml");
  writeFileSync(
    manifest,
    renderTemplate(readFileSync(join(appHost, "AndroidManifest.xml"), "utf8"), {
      PACKAGE: identity.packageId,
      VERSION_CODE: identity.versionCode,
      VERSION_NAME: identity.version,
      MIN_SDK: minSdkVersion,
      TARGET_SDK: targetSdkVersion,
      DEBUGGABLE: String(!release),
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
    String(minSdkVersion),
    "--target-sdk-version",
    String(targetSdkVersion),
    compiled,
  ]);
  const staged = ["classes.dex", ...abis.map(abi => `lib/${abi.abi}/libpocketjs.so`).sort()];
  const epoch = new Date(1980, 0, 1);
  for (const entry of staged) utimesSync(join(staging, entry), epoch, epoch);
  mustRun("zip", ["-q", "-X", unsigned, ...staged], staging);
  const aligned = join(build, "app-aligned.apk");
  mustRun(join(buildTools, "zipalign"), ["-f", "-p", "4", unsigned, aligned]);
  const signed = join(build, "app-signed.apk");
  const apksigner = join(buildTools, "apksigner");
  runJava([
    apksigner,
    "sign",
    ...signer,
    "--min-sdk-version",
    String(minSdkVersion),
    "--v1-signing-enabled",
    "true",
    "--v2-signing-enabled",
    "true",
    "--v3-signing-enabled",
    "false",
    "--v4-signing-enabled",
    "false",
    "--out",
    signed,
    aligned,
  ]);
  mkdirSync(dirname(appOutput), { recursive: true });
  copyFileSync(signed, appOutput);
  const signature = runJava([
    apksigner,
    "verify",
    "--verbose",
    "--print-certs",
    "--min-sdk-version",
    String(minSdkVersion),
    signed,
  ]);
  const certificate = /^Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})$/m.exec(signature);
  if (!certificate) throw new Error(`${LABEL}: apksigner printed no signer certificate`);
  const badging = mustRun(join(buildTools, "aapt"), ["dump", "badging", appOutput]);
  return { signature, certificateSha256: certificate[1], badging };
}

function resetBuild(): void {
  rmSync(build, { recursive: true, force: true });
  for (const abi of abis) mkdirSync(join(staging, "lib", abi.abi), { recursive: true });
}

function buildRustCore(abi: AndroidAbi): string {
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
      abi.rustTarget,
      "--features",
      "bare-platform",
      "--target-dir",
      rustTarget,
    ],
    join(repository, "engine/ui-cabi"),
    {
      ...process.env,
      CARGO_PROFILE_RELEASE_LTO: "false",
      [`CARGO_TARGET_${abi.rustTarget.toUpperCase().replace(/-/g, "_")}_LINKER`]: clangFor(abi),
    },
  );
  const library = join(rustTarget, abi.rustTarget, "release/libpocketjs_symbian_core.a");
  if (!existsSync(library)) {
    throw new Error(`${LABEL}: Rust core archive is absent: ${library}`);
  }
  return library;
}

function buildQuickJs(abi: AndroidAbi): string {
  const clang = clangFor(abi);
  const objects = join(build, "objects", abi.abi, "quickjs");
  mkdirSync(objects, { recursive: true });
  const flags = [
    "-std=gnu11",
    "-O2",
    "-fPIC",
    "-funsigned-char",
    "-fno-strict-aliasing",
    "-ffunction-sections",
    "-fdata-sections",
    ...(abi.cFlags ?? []),
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
  const library = join(build, `libquickjs-${abi.abi}.a`);
  mustRun(join(llvm, "llvm-ar"), ["rcs", library, ...objectPaths]);
  return library;
}

function buildNativeLibrary(abi: AndroidAbi, bundle: GuestBundle, quickJsLibrary: string, coreLibrary: string): string {
  const clang = clangFor(abi);
  const objects = join(build, "objects", abi.abi);
  mkdirSync(objects, { recursive: true });
  const cFlags = [
    "-std=gnu11",
    "-Os",
    "-fPIC",
    "-fno-strict-aliasing",
    "-ffunction-sections",
    "-fdata-sections",
    "-fvisibility=hidden",
    ...(abi.cFlags ?? []),
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
  const sharedSources: Array<{ name: string; source: string; includes: string[] }> = [
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
    { name: "offload_posix", source: join(repository, "hosts/shared/offload_posix.c"), includes: [] },
  ];
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
  const nativeLibrary = join(staging, "lib", abi.abi, "libpocketjs.so");
  /* No -landroid: the library needs nothing beyond GLESv2/log/dl/m/c, and
   * --no-undefined turns any missing native symbol into a link failure
   * against the C library of the ABI's API level. */
  mustRun(clang, [
    "-shared",
    ...(abi.cFlags ?? []),
    "-Wl,--build-id=none",
    "-Wl,--gc-sections",
    "-Wl,--exclude-libs,ALL",
    "-Wl,--no-undefined",
    ...(abi.linkFlags ?? []),
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

/** The ELF header and dynamic section, with the build attributes where this NDK's readelf prints them (`-A`, LLVM 11 and later). */
function elfSummary(library: string): string {
  const full = run(readelf, ["-h", "-A", "-d", library]);
  return full.exitCode === 0 ? full.stdout.trim() : mustRun(readelf, ["-h", "-d", library]);
}

/**
 * The guest of this build: the plan `--plan` names, compiled from
 * `--project-root`, or the bundle `build-demo` left for the toolchain file's
 * manifest.
 */
function guestBundle(): GuestBundle {
  if (!planOption) return readGuestBundle(guest);
  return buildGuestBundleFromPlan({
    label: LABEL,
    repository,
    target,
    planPath: resolve(planOption),
    projectRoot,
    outputDirectory: join(build, "guest"),
  });
}

function buildApp(): void {
  requireToolchain();
  resetBuild();
  const bundle = guestBundle();
  const libraries = abis.map((abi) => {
    const coreLibrary = buildRustCore(abi);
    const quickJsLibrary = buildQuickJs(abi);
    return { abi, path: buildNativeLibrary(abi, bundle, quickJsLibrary, coreLibrary) };
  });
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
  const { signature, certificateSha256, badging } = packageApk(identity, resources, assets);
  for (const marker of [
    `package: name='${identity.packageId}' versionCode='${identity.versionCode}' versionName='${identity.version}'`,
    `sdkVersion:'${minSdkVersion}'`,
    `targetSdkVersion:'${targetSdkVersion}'`,
    ...abis.map(abi => `'${abi.abi}'`),
  ]) {
    if (!badging.includes(marker)) {
      throw new Error(`${LABEL}: APK badging is missing ${marker}`);
    }
  }
  if (badging.includes("application-debuggable") === release) {
    throw new Error(`${LABEL}: ${release ? "the release APK is debuggable" : "the development APK is not debuggable"}`);
  }
  const receipt = {
    schema: 2,
    toolchain: toolchain.toolchainVersion,
    planHash: bundle.plan.planHash,
    package: identity,
    target: bundle.inputs.target,
    hostAbi: bundle.inputs.hostAbi,
    viewport: bundle.inputs.viewport,
    release,
    minSdkVersion,
    targetSdkVersion,
    apk: {
      path: appOutput.startsWith(repository) ? appOutput.slice(repository.length) : appOutput,
      bytes: readFileSync(appOutput).byteLength,
      sha256: sha256File(appOutput),
    },
    signer: {
      certificateSha256,
    },
    guest: {
      javaScript: sha256File(bundle.javaScript),
      pack: sha256File(bundle.pack),
    },
    nativeLibraries: libraries.map(({ abi, path }) => ({
      abi: abi.abi,
      apiLevel: abiApiLevel(abi),
      bytes: readFileSync(path).byteLength,
      sha256: sha256File(path),
      elf: elfSummary(path),
    })),
    quickjs: {
      version: toolchain.quickjs.version,
      revision: toolchain.quickjs.revision,
    },
    rust: { toolchain: toolchain.rust.toolchain, targets: abis.map(abi => abi.rustTarget) },
    signature,
    badging,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`${LABEL}: APK -> ${appOutput}`);
  console.log(`SHA-256: ${receipt.apk.sha256}`);
  console.log(`Signer certificate SHA-256: ${certificateSha256}`);
  console.log(`Receipt: ${receiptPath}`);
}

const USAGE =
  `usage: bun tools/android.ts [--profile=${Object.keys(PROFILES).join("|")}] <doctor|setup|build-demo|build-app|build>\n` +
  `       build-app --plan=<plan.json> [--project-root=<dir>] [--out=<file.apk>] [--release]`;

if (planOption && command !== "build-app" && command !== "build") {
  throw new Error(`${LABEL}: --plan goes with build-app\n${USAGE}`);
}
if (outOption && !outOption.endsWith(".apk")) {
  throw new Error(`${LABEL}: --out names an .apk file`);
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
    if (!planOption) buildGuestBundle(guest);
    buildApp();
    break;
  default:
    throw new Error(USAGE);
}
