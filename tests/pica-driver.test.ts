import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import profile from "../profiles/3ds-dev.ts";
import { encodeIdentity, encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cc = Bun.which(process.env.CC || "cc");
const runDir = resolve(root, `.pocket-build/validation/pica-driver/${Date.now()}-${process.pid}`);
function run(args: string[], env = process.env): string {
  const result = Bun.spawnSync(args, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  writeFileSync(resolve(runDir, `${args[0]!.split("/").at(-1)}-${Date.now()}.log`), output);
  expect(result.success, `${args.join(" ")} (exit=${result.exitCode}, signal=${result.signalCode})\n${output}`).toBe(true);
  return output;
}
test.skipIf(!cc)("PICA driver retains independent screen submissions and exact resource versions until terminal waits", () => {
  mkdirSync(runDir, { recursive: true });
  const target = resolve(root, ".pocket-build/validation/pica-driver/cargo-target");
  run(["cargo", "+stable", "rustc", "--lib", "--crate-type", "staticlib", "--locked", "--offline", "--manifest-path", "Cargo.toml", "-p", "pocket-runtime-cabi", "--no-default-features", "--release", "--target-dir", target], { ...process.env, RUSTFLAGS: "-C panic=abort" });
  const binary = resolve(runDir, "driver");
  run([cc!, "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", resolve(root,"tests/fixtures/pica-driver"),
    "-I", resolve(root,"devices/3ds/pocket-3ds-pica/include"), "-I", resolve(root,"contracts/generated"),
    resolve(root,"tests/fixtures/pica-driver/driver.c"), resolve(target,"release/libpocket_runtime_cabi.a"), "-lm", "-o", binary]);
  expect(run([binary])).toContain("PICA driver lifecycle, versioning, guarded fonts and real DrawList visitor passed");
  const encoder = new TextEncoder();
  const packageBytes = encodePocketPackage({manifest: new Uint8Array(), variants: [{target: "3ds-dev", hostAbi: POCKET_BINDING_GENERATION, profileHash: hashPocketProfile(profile), sections: [
    {kind: 1, bytes: encodeIdentity({output: "fixture", id: "test.3ds", title: "3DS composition"})},
    {kind: 2, bytes: encoder.encode('{"viewport":{"logical":[400,240],"rasterDensity":1},"features":{}}')},
    {kind: 3, bytes: encoder.encode("test\0")},
  ]}]});
  writeFileSync(resolve(runDir, "package_fixture.h"), `static const uint8_t package_bytes[] = {${[...packageBytes].join(",")}};\n`);
  const instance = resolve(runDir, "instance");
  run([cc!, "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-variable", `-DPOCKETJS_HOST_ABI=${POCKET_BINDING_GENERATION}`,
    "-I", resolve(root,"tests/fixtures/pica-driver"), "-I", resolve(root,"products/3ds/include"),
    "-I", resolve(root,"contracts/generated"), "-I", resolve(root,"platforms/3ds"), "-I", runDir,
    resolve(root,"tests/fixtures/pica-driver/instance.c"), resolve(root,"platforms/3ds/hooks.c"), resolve(root,"platforms/3ds/input_source.c"), resolve(target,"release/libpocket_runtime_cabi.a"), "-lm", "-o", instance]);
  expect(run([instance])).toContain("3DS runtime composition: package, auxiliary metadata, providers and exact input passed");
}, 180_000);
