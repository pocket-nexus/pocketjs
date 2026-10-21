import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { writeHostProfileHeader } from "../tools/host-profile.ts";
import { defineProfile } from "../framework/src/profile.ts";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const build = join(repository, `.pocket-build/validation/quickjs-c/${Date.now()}-${process.pid}`);
mkdirSync(build, { recursive: true });
let serial = 0;
function run(args: readonly string[]): string {
  const result = Bun.spawnSync([...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  writeFileSync(join(build, `${serial++}.log`), output);
  expect(result.success, `${args.join(" ")} (signal=${result.signalCode})\n${output.slice(-8000)}`).toBe(true);
  return result.stdout.toString();
}

describe("portable QuickJS C canonical composition", () => {
  test("real QuickJS and runtime archive execute every capability combination", () => {
    const cc = Bun.which("cc"); expect(cc).not.toBeNull();
    const metadata = JSON.parse(run(["cargo", "+stable", "metadata", "--locked", "--format-version=1", "--manifest-path", "engine/Cargo.toml"]));
    const dependency = metadata.packages.find((p: { name: string }) => p.name === "rquickjs-sys");
    expect(dependency).toBeDefined();
    const quickjs = join(dirname(dependency.manifest_path), "quickjs");
    const target = join(repository, ".pocket-build/validation/quickjs-c/target");
    run(["cargo", "+stable", "build", "--locked", "--release", "--manifest-path", "engine/ui-cabi/Cargo.toml", "--no-default-features", "--features", "std,software-only", "--target-dir", target]);
    const vendor = ["quickjs", "dtoa", "libregexp", "libunicode"].map(name => {
      const object = join(build, `${name}.o`);
      run([cc!, "-std=gnu11", "-O1", "-D_GNU_SOURCE", '-DCONFIG_VERSION="test"', "-I", quickjs, "-c", join(quickjs, `${name}.c`), "-o", object]);
      return object;
    });
    const profileHeader = writeHostProfileHeader(build, defineProfile({id:"harness-test",platform:"fixture",form:"embedded",tickHz:60,display:{physicalViewport:[32,24],logicalViewports:[[32,24]],rasterDensity:1,presentations:["native"]},capabilities:["input.buttons","input.touch"],roleCapabilities:{}}));
    const common = ["-include", profileHeader,"-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter", '-DPOCKETJS_TARGET_ID="harness-test"', `-DPOCKETJS_HOST_ABI=${POCKET_BINDING_GENERATION}`,
      ...["engine/quickjs-c", "engine/ui-cabi/include", "engine/guest-quickjs/include", "contracts/generated", "hosts/nokia-e7/runtime", "hosts/ios-legacy"].flatMap(path => ["-I", join(repository, path)]), "-isystem", quickjs];
    const stale = Bun.spawnSync([cc!, ...common.map(arg => arg.startsWith("-DPOCKETJS_HOST_ABI=")
      ? `-DPOCKETJS_HOST_ABI=${POCKET_BINDING_GENERATION - 1}` : arg), "-fsyntax-only", "engine/quickjs-c/pocket_runtime.c"],
      { cwd: repository, stdout: "pipe", stderr: "pipe" });
    expect(stale.success).toBe(false);
    expect(stale.stderr.toString()).toContain("POCKETJS_HOST_ABI must match POCKET_BINDING_GENERATION");
    const variants: [string, string[]][] = [
      ["production", []], ["native-extension", ["-DPOCKET_RUNTIME_EXTENSION"]], ["stages", ["-DPOCKET_RUNTIME_STAGE_HOOKS"]],
      ["harness", ["-DPOCKET_RUNTIME_HARNESS"]], ["stages-and-harness", ["-DPOCKET_RUNTIME_STAGE_HOOKS", "-DPOCKET_RUNTIME_HARNESS"]],
      ["physics", ["-DPOCKET_PHYSICS"]], ["services", ["-DPOCKET_SVC_WIRE"]],
    ];
    for (const [name, defines] of variants) {
      const binary = join(build, name);
      run([cc!, ...common, ...defines, "engine/quickjs-c/pocket_runtime.c", "engine/guest-quickjs/src/guest.c", "tests/fixtures/quickjs-c-harness/runtime_harness.c",
        ...vendor, join(target, "release/libpocketjs_symbian_core.a"), "-lm", "-lpthread", "-ldl", "-o", binary]);
      expect(run([binary])).toContain("quickjs-c canonical composition: ok");
    }
  }, 180_000);
});
