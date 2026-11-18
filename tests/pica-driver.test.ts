import { STABLE_RUST_TOOLCHAIN } from "../tools/build/toolchains/rust.ts";
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
  run(["cargo", `+${STABLE_RUST_TOOLCHAIN}`, "rustc", "--lib", "--crate-type", "staticlib", "--locked", "--manifest-path", "Cargo.toml", "-p", "pocket-archive", "--no-default-features", "--features", "software-renderer", "--release", "--target-dir", target], { ...process.env, RUSTFLAGS: "-C panic=abort" });
  const binary = resolve(runDir, "driver");
  run([cc!, "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", resolve(root,"tests/fixtures/pica-driver"),
    "-I", resolve(root,"devices/3ds/pocket-3ds-pica/include"), "-I", resolve(root,"contracts/generated"),
    resolve(root,"tests/fixtures/pica-driver/driver.c"), resolve(target,"release/libpocket_archive.a"), "-lm", "-o", binary]);
  expect(run([binary])).toContain("PICA driver lifecycle, versioning, guarded fonts and real DrawList visitor passed");
}, 180_000);
