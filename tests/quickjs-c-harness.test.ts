import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { writeHostProfileHeader } from "../tools/host-profile.ts";
import { lockedQuickJsSources, quickJsVendorObjects } from "../tools/quickjs-vendor.ts";
import { hashPocketProfile, parsePocketProfile } from "../framework/src/profile.ts";
import { encodeIdentity, encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const build = join(repository, `.pocket-build/validation/quickjs-c/${Date.now()}-${process.pid}`);
mkdirSync(build, { recursive: true });
let serial = 0;
function run(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = Bun.spawnSync([...args], { cwd: repository, env, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  writeFileSync(join(build, `${serial++}.log`), output);
  expect(result.success, `${args.join(" ")} (signal=${result.signalCode})\n${output.slice(-8000)}`).toBe(true);
  return result.stdout.toString();
}

describe("portable QuickJS C canonical composition", () => {
  test("real QuickJS and runtime archive execute every capability combination", () => {
    const cc = Bun.which("cc"); expect(cc).not.toBeNull();
    const quickjs = lockedQuickJsSources();
    // The workspace target directory: the profile overrides below fingerprint
    // their own artifacts, and the dependency graph is shared with every other
    // cabi build in the suite and with the CI cache.
    const target = process.env.CARGO_TARGET_DIR ?? join(repository, "target");
    run(["cargo", "+stable", "build", "--locked", "--release", "--manifest-path", "programs/native/runtime/Cargo.toml", "--no-default-features", "--features", "std,software-only", "--target-dir", target], { ...process.env, CARGO_PROFILE_RELEASE_PANIC: "abort", CARGO_PROFILE_RELEASE_LTO: "true" });
    const vendor = quickJsVendorObjects({ cc: cc!, quickjs, units: ["quickjs", "dtoa", "libregexp", "libunicode"],
      flags: ["-std=gnu11", "-O1", "-D_GNU_SOURCE", '-DCONFIG_VERSION="test"'], log: (_, output) => writeFileSync(join(build, `${serial++}.log`), output) });
    const profile = parsePocketProfile({format:"pocket-host/2",id:"harness-test",platform:"fixture",form:"embedded",cadences:[60],display:{logicalViewports:[[32,24]],rasterDensity:1,presentations:["native"],animation:"repaint"},panel:{primary:[32,24]},capabilities:["input.buttons","input.touch","ui.physics"],roleCapabilities:{}});
    const profileHeader = writeHostProfileHeader(build, profile);
    // Complete packages for the host composition cases: one the profile
    // admits, and one whose plan asks for a capability the profile lacks.
    const encoder = new TextEncoder();
    const harnessPackage = (features: Record<string, boolean>) => encodePocketPackage({manifest: new Uint8Array(), variants: [{
      target: profile.id, hostAbi: POCKET_BINDING_GENERATION, profileHash: hashPocketProfile(profile), sections: [
        {kind: POCKET_SECTION.identity, bytes: encodeIdentity({output: "harness", id: "dev.harness", title: "Harness"})},
        {kind: POCKET_SECTION.plan, bytes: encoder.encode(JSON.stringify({animation: "repaint", profile: {tickHz: 60}, viewport: {logical: [32, 24], presentation: "native", rasterDensity: 1}, features}))},
        {kind: POCKET_SECTION.js, bytes: encoder.encode("globalThis.packaged=true;globalThis.count=0;globalThis.textures=('__textures' in ui);globalThis.frame=function(buttons){globalThis.lastButtons=buttons;count++;};\0")},
      ],
    }]});
    writeFileSync(join(build, "harness_package.h"), `static const unsigned char harness_package[] = {${[...harnessPackage({})].join(",")}};\n` +
      `static const unsigned char harness_package_rejected[] = {${[...harnessPackage({"camera.qr": true})].join(",")}};\n`);
    const common = ["-include", profileHeader,"-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", '-DPOCKETJS_TARGET_ID="harness-test"', `-DPOCKETJS_HOST_ABI=${POCKET_BINDING_GENERATION}`,
      ...["programs/native/quickjs", "programs/native/runtime/include", "engine/guest-quickjs/include", "contracts/generated", "platforms/posix/svc-wire/include"].flatMap(path => ["-I", join(repository, path)]), "-isystem", quickjs];
    const stale = Bun.spawnSync([cc!, ...common.map(arg => arg.startsWith("-DPOCKETJS_HOST_ABI=")
      ? `-DPOCKETJS_HOST_ABI=${POCKET_BINDING_GENERATION - 1}` : arg), "-fsyntax-only", "programs/native/quickjs/pocket_qjs_program.c"],
      { cwd: repository, stdout: "pipe", stderr: "pipe" });
    expect(stale.success).toBe(false);
    expect(stale.stderr.toString()).toContain("POCKETJS_HOST_ABI must match POCKET_BINDING_GENERATION");
    const variants: [string, string[]][] = [
      ["production", []], ["native-extension", ["-DPOCKET_RUNTIME_EXTENSION"]], ["stages", ["-DPOCKET_RUNTIME_STAGE_HOOKS"]],
      ["physics", ["-DPOCKET_PHYSICS"]], ["services", ["-DPOCKET_SVC_WIRE"]],
    ];
    for (const [name, defines] of variants) {
      const binary = join(build, name);
      run([cc!, ...common, ...defines, "-I", build, "programs/native/quickjs/pocket_qjs_program.c", "engine/guest-quickjs/src/guest.c", "tests/fixtures/quickjs-c-harness/runtime_harness.c",
        ...vendor, join(target, "release/libpocket_native_program.a"), "-lm", "-lpthread", "-ldl", "-o", binary]);
      expect(run([binary])).toContain("quickjs-c canonical composition: ok");
    }
  }, 180_000);
});
