import { STABLE_RUST_TOOLCHAIN } from "./build/toolchains/rust.ts";
// Host contract runner: actual file source, Runtime archive and Bellard guest.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { canonicalProfileJson, hashPocketProfile } from "../framework/src/profile.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { encodeIdentity, encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import profile from "../profiles/3ds-runtime.ts";
import { exportProfile } from "./profile-export.ts";
import { ensureQuickJsSources } from "./build/toolchains/3ds.ts";
const root = resolve(import.meta.dir, "..");
export function test3dsMinimal(out: string, packagePath?: string): string {
  mkdirSync(out, { recursive: true });
  let commandIndex = 0;
  const run = (args: string[], env = process.env): string => {
    const result = Bun.spawnSync(args, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const output = result.stdout.toString() + result.stderr.toString();
    writeFileSync(join(out, `${++commandIndex}.log`), `${args.join(" ")}\n${output}`);
    if (!result.success) throw new Error(`${args[0]} failed (${result.signalCode ?? result.exitCode}):\n${output}`);
    return output;
  };
  exportProfile({ profile, profileHash: hashPocketProfile(profile), hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, out);
  const cc = process.env.CC ?? "cc";
  const includes = ["-I", "contracts/generated", "-I", "programs/3ds", "-I", "platforms/3ds", "-I", out];
  const hid = join(out, "input");
  run([cc, "-std=c11", "-Wall", "-Wextra", "-Werror", ...includes,
    "-I", "tests/fixtures/3ds-minimal/mock", "-I", "products/3ds/src",
    "tests/fixtures/3ds-minimal/input.c", "platforms/3ds/input.c", "products/3ds/src/input_policy.c", "-o", hid]);
  run([hid]);
  const source = join(out, "source");
  run([cc, "-std=c11", "-Wall", "-Wextra", "-Werror", ...includes, "tests/fixtures/3ds-minimal/source.c",
    "programs/3ds/package_source.c", "platforms/3ds/input_source.c", "-o", source]);
  run([source, join(out, "range.bin")]);
  const target = resolve(root, ".pocket-build/validation/pica-driver/cargo-target");
  run(["cargo", `+${STABLE_RUST_TOOLCHAIN}`, "rustc", "--lib", "--crate-type", "staticlib", "--locked", "-p", "pocket-runtime-cabi",
    "--no-default-features", "--release", "--target-dir", target], { ...process.env, RUSTFLAGS: "-C panic=abort" });
  const quickjs = ensureQuickJsSources(), objects: string[] = [];
  const flags = ["-DPOCKET_QJS_BELLARD", "-DJS_NO_NAN_BOXING"];
  for (const name of ["quickjs", "dtoa", "libregexp", "libunicode", "cutils"]) {
    const object = join(out, `${name}.o`); objects.push(object);
    run([cc, "-std=gnu11", "-D_GNU_SOURCE", '-DCONFIG_VERSION="test"', ...flags, "-O1", "-I", quickjs, "-c", join(quickjs, `${name}.c`), "-o", object]);
  }
  const binary = join(out, "runtime");
  run([cc, "-std=c11", "-Wall", "-Wextra", "-Werror", ...flags, ...includes,
    "-I", "engine/guest-quickjs/include", "-isystem", quickjs, "tests/fixtures/3ds-minimal/runtime.c",
    "programs/3ds/package_source.c", "platforms/3ds/input_source.c", "engine/guest-quickjs/src/guest.c",
    ...objects, join(target, "release/libpocket_runtime_cabi.a"), "-lm", "-lpthread", "-o", binary]);
  if (packagePath) return run([binary, "--smoke", resolve(packagePath)]);
  const makePackage = (profileHash: string, rasterDensity = 1) => encodePocketPackage({ manifest: new Uint8Array(), variants: [{
    target: profile.id, hostAbi: POCKET_BINDING_GENERATION, profileHash, sections: [
      { kind: 1, bytes: encodeIdentity({ output: "minimal", id: "test.3ds.minimal", title: "Minimal file source" }) },
      { kind: 2, bytes: new TextEncoder().encode(`{"animation":"composited","profile":{"tickHz":60},"viewport":{"logical":[400,240],"presentation":"native","rasterDensity":${rasterDensity}},"features":{}}`) },
      { kind: 3, bytes: new TextEncoder().encode(`if(ui.__host!=="3ds-runtime"||ui.__hostAbi!==${POCKET_BINDING_GENERATION}||ui.__auxiliarySurface.root<=0)throw new Error("metadata");if(ui.svcOpen||ui.appTable)throw new Error("product provider");globalThis.__turns=0;globalThis.frame=(buttons,analog,touches,hits,surfaces,right)=>{if(buttons!==8192||analog!==255||right!==65280)throw new Error("input");const n=ui.createNode(0);if(n<=0)throw new Error("core op");ui.destroyNode(n);__turns++};\0`) },
    ] }] });
  const valid = makePackage(hashPocketProfile(profile));
  writeFileSync(join(out, "valid.pocket"), valid);
  // Another profile hash with the same facts is admitted; another density is not.
  writeFileSync(join(out, "mismatch.pocket"), makePackage(`sha256:${"11".repeat(32)}`, 2));
  writeFileSync(join(out, "truncated.pocket"), valid.subarray(0, valid.length - 8));
  const result = run([binary, join(out, "valid.pocket"), join(out, "mismatch.pocket"), join(out, "truncated.pocket")]);
  writeFileSync(join(out, "receipt.json"), JSON.stringify({ status: "passed", kind: "host contract; not hardware rendering", profileHash: hashPocketProfile(profile), canonicalProfileJson: canonicalProfileJson(profile), result }, null, 2) + "\n");
  return result;
}
if (import.meta.main) {
  const out = resolve(process.argv[2] ?? `.pocket-build/validation/3ds-minimal/${Date.now()}-${process.pid}`);
  console.log(test3dsMinimal(out, process.argv[3]));
}
