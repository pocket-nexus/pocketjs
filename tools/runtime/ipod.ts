// tools/runtime/ipod.ts [--out=<dir>] — the generic iPod touch 4 runtime: the
// legacy UIKit host built once, with no game, in dist/runtime/ipod/.
//
//   PocketJSRuntime        the armv7 executable, signed ad hoc by ldid with no
//                          Info.plist beside it, so the signature covers the
//                          code pages and binds no Info.plist or resources
//   Default@2x.png         launch images (the PocketJS mark)
//   Default-568h@2x.png
//   Icon.png, Icon@2x.png  the 57 and 114 px PocketJS icons, for a game that
//                          brings none
//   PkgInfo
//   runtime.json           { target, hostAbi, pocketjs, profile, files, host }
//
// The executable has no __pocket_js / __pocket_pak section. It is compiled with
// POCKET_PACKAGE_RUNTIME: at launch it reads app.pocket beside itself, admits
// the ipodtouch4-dev ABI 8 variant, and takes the logical surface (320x480 or
// 480x320) and raster density from that variant's plan (hosts/ios-legacy/
// runtime.c). ui.physics (ops 52..56) and io.offload are compiled in for every
// game; keep-awake and the svc wire are not, and a plan that names companion
// services is refused. tools/repack/ipod.ts writes a game's .ipa from it.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { bakeClassicIPhoneArtwork, IPHONE_USER_ICON_FILE, IPHONE_USER_RETINA_ICON_FILE } from "../iphone-classic-icon.ts";
import {
  buildIPodInstaller,
  checkIPodExecutable,
  compileIPodHost,
  hashInputs,
  IPOD_WARNINGS,
  linkIPodExecutable,
  prepareIPodNative,
  sysrootIdentityInputs,
} from "../ipodtouch4.ts";
import { IPODTOUCH4_DEV_HOST_ABI, IPODTOUCH4_DEV_TARGET_ID, IPODTOUCH4_RASTER_DENSITY } from "../ipodtouch4-profile.ts";
import { IPODTOUCH4_TOOLCHAIN } from "../ipodtouch4-toolchain.ts";
import { IPOD_RUNTIME_EXECUTABLE, IPOD_RUNTIME_FILES } from "../repack/ipod.ts";
import { writeRuntimeManifest } from "./manifest.ts";

const repository = resolvePath(new URL("../..", import.meta.url).pathname);
const BUILD_ID_PLACEHOLDER = "00000000000000000000000000000000";

export async function buildRuntimeIPod(argv: readonly string[] = []): Promise<string> {
  let out = join(repository, "dist/runtime/ipod");
  for (const argument of argv) {
    if (argument.startsWith("--out=")) out = resolvePath(argument.slice("--out=".length));
    else throw new Error(`usage: bun tools/runtime.ts ipod [--out=<dir>] (unknown argument ${argument})`);
  }
  const nativeBuild = join(repository, ".pocket-build/ipodtouch4/runtime/native");
  const native = prepareIPodNative(nativeBuild);
  const host = compileIPodHost(native, {
    target: IPODTOUCH4_DEV_TARGET_ID,
    hostAbi: IPODTOUCH4_DEV_HOST_ABI,
    rasterDensity: IPODTOUCH4_RASTER_DENSITY,
    features: { "ui.physics": true },
    svcWire: false,
  });
  const runtimeDefines = (buildId: string) => [
    ...IPOD_WARNINGS,
    "-DPOCKET_PACKAGE_RUNTIME",
    `-DPOCKETJS_TARGET_ID="${IPODTOUCH4_DEV_TARGET_ID}"`,
    `-DPOCKETJS_HOST_ABI=${IPODTOUCH4_DEV_HOST_ABI}`,
    `-DPOCKET_BUILD_ID="${buildId}"`,
    "-I", join(repository, "engine/quickjs-c"),
    "-I", join(repository, "engine/ui-cabi/include"),
    "-Wno-cast-function-type-mismatch",
  ];
  const identityObject = join(nativeBuild, "runtime.build-id-input.o");
  native.compile(join(repository, "hosts/ipodtouch4/runtime.c"), identityObject, runtimeDefines(BUILD_ID_PLACEHOLDER));
  // The runtime's build id names the program alone: the status record on the
  // device reports it for every game repacked onto this runtime.
  const buildId = hashInputs([
    join(repository, "tools/ipodtouch4.ts"),
    join(repository, "tools/runtime/ipod.ts"),
    join(repository, "hosts/ipodtouch4/armv7-apple-ios.json"),
    ...sysrootIdentityInputs(native.sysroot),
    { label: "native/csu-start.o", path: native.csuStart },
    { label: "native/csu-dyld-glue.o", path: native.csuDyldGlue },
    { label: "native/crt_globals.o", path: host.crtGlobals },
    { label: "native/runtime.build-id-input.o", path: identityObject },
    { label: "native/pocket_runtime.o", path: host.pocketRuntime },
    { label: "native/offload_posix.o", path: host.offload },
    { label: "native/compat.o", path: host.compat },
    ...native.quickJsObjects.map((path) => ({ label: `native/${path.slice(nativeBuild.length + 1)}`, path })),
    { label: "native/libpocketjs_symbian_core.a", path: native.rustLibrary },
  ]);
  const runtimeObject = join(nativeBuild, "runtime.o");
  native.compile(join(repository, "hosts/ipodtouch4/runtime.c"), runtimeObject, runtimeDefines(buildId));

  // Linked and signed in a directory of its own: ldid finds no Info.plist or
  // resources to bind, so the signature stays valid in any bundle.
  const signing = join(nativeBuild, "sign");
  mkdirSync(signing, { recursive: true });
  const linked = join(signing, IPOD_RUNTIME_EXECUTABLE);
  linkIPodExecutable(native, host, runtimeObject, linked);
  const fileInfo = checkIPodExecutable(linked, false);
  // A repack replaces Info.plist and adds files: the signature must bind neither.
  const signature = Bun.spawnSync(["codesign", "-d", "-vvvv", linked], { stdout: "pipe", stderr: "pipe" });
  const description = `${signature.stdout.toString()}${signature.stderr.toString()}`;
  for (const fact of ["Info.plist=not bound", "Sealed Resources=none"]) {
    if (!description.includes(fact)) throw new Error(`runtime ipod: the executable's signature does not say ${fact}:\n${description}`);
  }
  buildIPodInstaller(native);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(linked, join(out, IPOD_RUNTIME_EXECUTABLE));
  const artwork = join(nativeBuild, "artwork");
  await bakeClassicIPhoneArtwork(artwork, "User");
  cpSync(join(artwork, IPHONE_USER_ICON_FILE), join(out, "Icon.png"));
  cpSync(join(artwork, IPHONE_USER_RETINA_ICON_FILE), join(out, "Icon@2x.png"));
  for (const name of ["Default@2x.png", "Default-568h@2x.png"]) cpSync(join(artwork, name), join(out, name));
  cpSync(join(repository, "hosts/ipodtouch4/PkgInfo"), join(out, "PkgInfo"));
  for (const name of IPOD_RUNTIME_FILES) {
    if (!existsSync(join(out, name))) throw new Error(`runtime ipod: ${name} was not written`);
  }
  const manifest = await writeRuntimeManifest(out, {
    target: IPODTOUCH4_DEV_TARGET_ID,
    hostAbi: IPODTOUCH4_DEV_HOST_ABI,
    profile: IPODTOUCH4_DEV_TARGET_ID,
    files: IPOD_RUNTIME_FILES,
    extra: {
      host: {
        buildId,
        executable: IPOD_RUNTIME_EXECUTABLE,
        deploymentTarget: IPODTOUCH4_TOOLCHAIN.compiler.minimumVersion,
      },
    },
  });
  writeFileSync(join(nativeBuild, "file.txt"), `${fileInfo}\n`);
  console.log(fileInfo);
  console.log(
    `output: ${out} (${manifest.files[IPOD_RUNTIME_EXECUTABLE]!.bytes} byte executable, build ${buildId}, PocketJS ${manifest.pocketjs})`,
  );
  return out;
}

if (import.meta.main) {
  try {
    await buildRuntimeIPod(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
