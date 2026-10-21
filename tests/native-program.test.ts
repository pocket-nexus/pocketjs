import profile from "../profiles/symbian-e7-dev.ts";
import { writeHostProfileHeader } from "../tools/host-profile.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import { encodePocketPackage, encodeIdentity, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const build = join(repository, `.pocket-build/validation/native-program/${Date.now()}-${process.pid}`);
mkdirSync(build, { recursive: true });
let serial = 0;
function run(args: readonly string[]): string {
  const result = Bun.spawnSync([...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  writeFileSync(join(build, `${serial++}.log`), output);
  expect(result.success, `${args.join(" ")} (signal=${result.signalCode})\n${output.slice(-8000)}`).toBe(true);
  return result.stdout.toString();
}

describe("native program composition", () => {
  test("real guest uses GPU viewports, terminal waits, collect and canonical input", () => {
    const cc = Bun.which("cc"); expect(cc).not.toBeNull();
    const metadata = JSON.parse(run(["cargo", "+stable", "metadata", "--locked", "--format-version=1", "--manifest-path", "engine/Cargo.toml"]));
    const dependency = metadata.packages.find((p: { name: string }) => p.name === "rquickjs-sys");
    expect(dependency).toBeDefined();
    const quickjs = join(dirname(dependency.manifest_path), "quickjs");
    const target = join(repository, ".pocket-build/validation/native-program/target");
    run(["cargo", "+stable", "build", "--locked", "--release", "--manifest-path", "engine/ui-cabi/Cargo.toml", "--no-default-features", "--features", "standalone-extension-provider", "--target-dir", target]);
    const vendor = ["quickjs", "dtoa", "libregexp", "libunicode"].map(name => {
      const object = join(build, `${name}.o`);
      run([cc!, "-std=gnu11", "-O1", "-D_GNU_SOURCE", '-DCONFIG_VERSION="test"', "-I", quickjs, "-c", join(quickjs, `${name}.c`), "-o", object]);
      return object;
    });
    const profileHeader = writeHostProfileHeader(build, profile);
    const bytes = encodePocketPackage({manifest: new Uint8Array(), variants:[{
      target: profile.id, hostAbi: 4, profileHash: hashPocketProfile(profile), sections: [
        {kind: POCKET_SECTION.identity, bytes: encodeIdentity({output:"fixture", id:"dev.fixture", title:"Fixture"})},
        {kind: POCKET_SECTION.plan, bytes: new TextEncoder().encode(JSON.stringify({viewport:{logical:[360,640],rasterDensity:1},features:{}}))},
        {kind: POCKET_SECTION.js, bytes: new TextEncoder().encode("globalThis.frame=()=>{};\0")},
      ],
    }]});
    const packageHeader = join(build, "fixture_package.h");
    writeFileSync(packageHeader, `static const unsigned char fixture_package[] = {${[...bytes].join(",")}};\n`);
    const common = ["-include", profileHeader, "-include", packageHeader,"-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter",
      ...["engine/ui-cabi/include", "engine/guest-quickjs/include", "contracts/generated"].flatMap(path => ["-I", join(repository, path)]), "-isystem", quickjs];
    const binary = join(build, "program");
    run([cc!, ...common, "engine/guest-quickjs/src/guest.c", "tests/fixtures/native-program/program.c",
      ...vendor, join(target, "release/libpocketjs_symbian_core.a"), "-lm", "-lpthread", "-ldl", "-o", binary]);
    expect(run([binary])).toContain("native program GPU/collect/input/lifetime: ok");
  }, 180_000);
});
