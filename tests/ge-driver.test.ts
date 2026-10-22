import { STABLE_RUST_TOOLCHAIN } from "../tools/build/toolchains/rust.ts";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

test("independent GE renderer retains owned and zero-copy resources through terminal completion", () => {
  const directory = resolve(root, `.pocket-build/validation/ge-driver/${Date.now()}-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const result = Bun.spawnSync([
    "cargo", `+${STABLE_RUST_TOOLCHAIN}`, "test", "--locked", "--manifest-path",
    "devices/psp/pocket-psp-render/Cargo.toml", "--lib", "--target-dir",
    resolve(root, ".pocket-build/validation/ge-driver/host-target"),
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  writeFileSync(resolve(directory, "tests.log"), output);
  expect(result.success, `GE tests (exit=${result.exitCode}, signal=${result.signalCode})\n${output}`).toBe(true);
  expect(output).toContain("test result: ok.");
}, 120_000);
