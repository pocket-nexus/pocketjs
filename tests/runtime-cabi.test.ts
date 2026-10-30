import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encodeIdentity, encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalProfileJson, type PocketProfile } from "../contracts/spec/profile.ts";
import { profileFactsC } from "../tools/profile-export.ts";

const root = resolve(import.meta.dir, "..");
const cc = Bun.which("cc");
const runDir = resolve(root, `.pocket-build/validation/runtime-cabi/${Date.now()}-${process.pid}`);
const fixtureProfile: PocketProfile = { format: "pocket-host/2", id: "fixture", platform: "test", form: "takeover", cadences: [60], display: { logicalViewports: [[4, 4]], presentations: ["native"], rasterDensity: 1, animation: "repaint" }, panel: { primary: [4, 4] }, capabilities: [] };
const profile = canonicalProfileJson(fixtureProfile);
function packageFixture(): Uint8Array {
  const text = new TextEncoder();
  return encodePocketPackage({ manifest: new Uint8Array(), variants: [{
    target: "fixture", hostAbi: POCKET_BINDING_GENERATION, profileHash: "sha256:" + createHash("sha256").update(profile).digest("hex"),
    sections: [
      {kind:1,bytes:encodeIdentity({output:"app",id:"test.app",title:"App"})},
      {kind:2,bytes:text.encode('{"animation":"repaint","profile":{"tickHz":60},"viewport":{"logical":[4,4],"presentation":"native","rasterDensity":1},"features":{}}')},
      {kind:3,bytes:text.encode("test\0")}
    ]
  }]});
}
function run(args: string[], env = process.env): string {
  const result = Bun.spawnSync(args, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  writeFileSync(resolve(runDir, `${args[0]!.split("/").at(-1)}-${Date.now()}.log`), output);
  expect(result.success, `${args.join(" ")} (exit=${result.exitCode}, signal=${result.signalCode})\n${output}`).toBe(true);
  return result.stdout.toString();
}
test.skipIf(!cc)("a C program links the no_std archive with six hooks and exercises prefix and lifecycle contracts", () => {
  mkdirSync(runDir, { recursive: true });
  const array = (name: string, data: Uint8Array) => `static const uint8_t ${name}[] = {${[...data].join(",")}};\n`;
  writeFileSync(resolve(runDir, "fixture.h"), profileFactsC(fixtureProfile, "profile_facts") + array("profile_hash", createHash("sha256").update(profile).digest()) + array("package_bytes", packageFixture()));
  const target = resolve(root, ".pocket-build/validation/runtime-cabi/cargo-target");
  run(["cargo", "+stable", "rustc", "--lib", "--crate-type", "staticlib", "--locked", "--manifest-path", "Cargo.toml", "-p", "pocket-runtime-cabi", "--no-default-features", "--release", "--target-dir", target], { ...process.env, RUSTFLAGS: "-C panic=abort" });
  const binary = resolve(runDir, "contract");
  run([cc!, "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", resolve(root, "contracts/generated"), "-I", runDir, resolve(root, "tests/fixtures/runtime-cabi/contract.c"), resolve(target, "release/libpocket_runtime_cabi.a"), "-lm", "-o", binary]);
  expect(run([binary])).toContain("runtime C ABI: prefixes, reentry, range source, raster and terminal lifecycle passed");
}, 180_000);
