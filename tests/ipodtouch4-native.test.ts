import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileIPodHost, compileIPodUIKit, type IPodNative } from "../tools/ipodtouch4.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { ensureQuickJsCheckout, quickJsCheckout } from "../tools/native-source.ts";
import { ios6SharedCacheLinkIdentity } from "../tools/build/toolchains/ios6.ts";
import { IPODTOUCH4_TOOLCHAIN, ipodtouch4QuickJsPath } from "../tools/build/toolchains/ipodtouch4.ts";

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
  const compiler = IPODTOUCH4_TOOLCHAIN.compiler;
  const checkout = ipodtouch4QuickJsPath();
  ensureQuickJsCheckout("touch4 compile test", checkout, { repository: compiler.quickJsRepository, revision: compiler.quickJsRevision, version: compiler.quickJsVersion });
  const quickjs = quickJsCheckout(checkout).source;
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
  for (const packaged of [false, true]) {
    compileIPodUIKit(native, join(build, packaged ? "package.o" : "embedded.o"), {
      profile, target: profile.id, hostAbi: POCKET_BINDING_GENERATION,
      buildId: "compile-test", keepAwake: true, svcWire: true,
      ...(packaged ? {} : { embedded: { logical: [320, 480] as const, rasterDensity: 2 } }),
    });
  }
}, 120_000);


test("iOS 6 cache link identity ignores live data and covers code, symbols and mapping metadata", () => {
  const build = resolve(import.meta.dir, `../.pocket-build/validation/ipodtouch4-native/cache-${Date.now()}-${process.pid}`);
  mkdirSync(build, { recursive: true });
  const path = join(build, "cache");
  const bytes = Buffer.alloc(768, 0xa5);
  bytes.write("dyld_v1   armv7\0", 0, "ascii");
  bytes.writeUInt32LE(88, 16); bytes.writeUInt32LE(3, 20);
  for (let index = 0; index < 3; index++) {
    const entry = 88 + index * 32;
    bytes.writeBigUInt64LE(BigInt(0x30000000 + index * 256), entry);
    bytes.writeBigUInt64LE(256n, entry + 8);
    bytes.writeBigUInt64LE(BigInt(index * 256), entry + 16);
    bytes.writeUInt32LE(index === 1 ? 3 : 5, entry + 24);
    bytes.writeUInt32LE(index === 1 ? 3 : 5, entry + 28);
  }
  const digest = (value: Buffer) => { writeFileSync(path, value); return ios6SharedCacheLinkIdentity(path); };
  const expected = digest(bytes);
  const live = Buffer.from(bytes); live.fill(0x77, 256, 512);
  expect(digest(live)).toBe(expected);
  for (const offset of [40, 200, 512, 767]) {
    const changed = Buffer.from(bytes); changed[offset] ^= 1;
    expect(digest(changed)).not.toBe(expected);
  }
  for (const change of [
    (value: Buffer) => value.write("invalid", 0),
    (value: Buffer) => value.writeUInt32LE(4, 20),
    (value: Buffer) => value.writeBigUInt64LE(32n, 88 + 32 + 16),
    (value: Buffer) => value.writeBigUInt64LE(1024n, 88 + 32 + 8),
    (value: Buffer) => value.writeUInt32LE(1, 88 + 32 + 28),
  ]) {
    const changed = Buffer.from(bytes); change(changed);
    expect(() => digest(changed)).toThrow();
  }
});
