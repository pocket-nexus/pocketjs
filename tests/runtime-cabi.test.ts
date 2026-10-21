import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cc = Bun.which("cc");
const runDir = resolve(root, `.pocket-build/validation/runtime-cabi/${Date.now()}-${process.pid}`);
const profile = '{"capabilities":[],"display":{"logicalViewports":[[4,4]],"physicalViewport":[4,4],"presentations":["native"],"rasterDensity":1},"form":"takeover","id":"fixture","platform":"test","tickHz":60}';
function packageFixture(): Uint8Array {
  const identity: number[] = [];
  for (const text of ["app", "test.app", "App"]) { const bytes = [...new TextEncoder().encode(text)]; identity.push(bytes.length, 0, ...bytes); }
  const sections = [identity, [...new TextEncoder().encode('{"viewport":{"logical":[4,4],"rasterDensity":1},"features":{}}')], [...new TextEncoder().encode("test\0")]];
  const bytes = new Array<number>(104).fill(0);
  const u32 = (offset: number, value: number) => { for (let i = 0; i < 4; i++) bytes[offset + i] = (value >>> (i * 8)) & 255; };
  bytes.splice(0, 4, ...new TextEncoder().encode("PCKT")); u32(4, 1); u32(12, 1);
  bytes.splice(16, 7, ...new TextEncoder().encode("fixture")); u32(32, 1); u32(36, 3); u32(40, 56);
  for (const [index, payload] of sections.entries()) {
    while (bytes.length % 16) bytes.push(0);
    const offset = bytes.length, entry = 56 + index * 16;
    u32(entry, index + 1); u32(entry + 8, offset); u32(entry + 12, payload.length); bytes.push(...payload);
  }
  let hash = 14695981039346656037n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  for (let i = 0; i < 8; i++) bytes.push(Number((hash >> BigInt(i * 8)) & 255n));
  return Uint8Array.from(bytes);
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
  writeFileSync(resolve(runDir, "fixture.h"), `static const uint8_t profile_json[] = ${JSON.stringify(profile)};\n` + array("profile_hash", createHash("sha256").update(profile).digest()) + array("package_bytes", packageFixture()));
  const target = resolve(root, ".pocket-build/validation/runtime-cabi/cargo-target");
  run(["cargo", "+stable", "build", "--locked", "--manifest-path", "engine/Cargo.toml", "-p", "pocket-runtime-cabi", "--no-default-features", "--release", "--target-dir", target], { ...process.env, RUSTFLAGS: "-C panic=abort" });
  const binary = resolve(runDir, "contract");
  run([cc!, "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", resolve(root, "contracts/generated"), "-I", runDir, resolve(root, "tests/fixtures/runtime-cabi/contract.c"), resolve(target, "release/libpocket_runtime_cabi.a"), "-lm", "-o", binary]);
  expect(run([binary])).toContain("runtime C ABI: prefixes, reentry, range source, raster and terminal lifecycle passed");
}, 180_000);
