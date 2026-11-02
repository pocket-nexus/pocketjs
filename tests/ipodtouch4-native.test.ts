import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compileIPodHost, type IPodNative } from "../tools/ipodtouch4.ts";
import { writeHostProfileHeader } from "../tools/host-profile.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";

test.skipIf(process.platform !== "darwin")("touch4 UIKit and QuickJS composition compile for ARMv7 with all host capabilities", () => {
  const root = resolve(import.meta.dir, "..");
  const build = join(root, `.pocket-build/validation/ipodtouch4-native/${Date.now()}-${process.pid}`);
  mkdirSync(build, { recursive: true });
  let sequence = 0;
  function run(command: string[]): string {
    const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const output = result.stdout.toString() + result.stderr.toString();
    writeFileSync(join(build, `${sequence++}.log`), output);
    expect(result.success, `${command.join(" ")}\n${output}`).toBe(true);
    return result.stdout.toString().trim();
  }
  const metadata = JSON.parse(run(["cargo", "metadata", "--locked", "--format-version=1"]));
  const quickjs = join(dirname(metadata.packages.find((p: { name: string }) => p.name === "rquickjs-sys").manifest_path), "quickjs");
  const clang = run(["xcrun", "--find", "clang"]);
  const sdk = run(["xcrun", "--sdk", "macosx", "--show-sdk-path"]);
  const compile: IPodNative["compile"] = (source, output, extra = []) => {
    run([clang, "-target", "armv7-apple-ios6.0", "-march=armv7", "-Os", "-fno-stack-protector", "-fno-builtin",
      "-isysroot", sdk, ...extra, "-c", source, "-o", output]);
  };
  const profile = POCKET_PROFILES["ipodtouch4-dev"];
  const native: IPodNative = { compile, nativeBuild: build, quickjs, sysroot: sdk,
    linker: "", csuStart: "", csuDyldGlue: "", quickJsObjects: [], rustLibrary: "" };
  for (const extended of [false, true]) {
    compileIPodHost(native, { profile, target: profile.id, hostAbi: POCKET_BINDING_GENERATION, rasterDensity: 2,
      features: extended ? { "ui.physics": true } : {}, svcWire: extended,
      ...(extended ? { nativeCore: { manifest: "", library: "", features: [], sources: [] } } : {}) });
  }
  const header = writeHostProfileHeader(build, profile);
  for (const packaged of [false, true]) {
    compile(join(root, "programs/ipodtouch4/runtime.c"), join(build, packaged ? "package.o" : "embedded.o"), [
      "-Wall", "-Wextra", "-Werror", "-Wno-incompatible-sysroot", "-Wno-cast-function-type-mismatch", "-include", header,
      `-DPOCKETJS_TARGET_ID="${profile.id}"`, `-DPOCKETJS_HOST_ABI=${POCKET_BINDING_GENERATION}`,
      "-DPOCKET_SVC_WIRE", ...(packaged ? ["-DPOCKET_PACKAGE_RUNTIME"] : ["-DPOCKET_LOGICAL_WIDTH=320", "-DPOCKET_LOGICAL_HEIGHT=480", "-DPOCKET_RASTER_DENSITY=2"]),
      "-I", join(root, "programs/native/quickjs"), "-I", join(root, "programs/native/runtime/include"),
      "-I", join(root, "contracts/generated"),
    ]);
  }
}, 120_000);
