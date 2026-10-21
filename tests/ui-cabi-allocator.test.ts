import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const build = mkdtempSync(join(tmpdir(), "pocketjs-ui-cabi-allocator-"));
const crate = join(repository, "engine/ui-cabi");
const config = Bun.TOML.parse(readFileSync(join(crate, "rust-toolchain.toml"), "utf8")) as {
  toolchain: { channel: string };
};

afterAll(() => rmSync(build, { recursive: true, force: true }));

function run(command: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = Bun.spawnSync(command, {
    cwd: repository,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(
    result.exitCode,
    `${command.join(" ")} (signal=${result.signalCode})\n${result.stdout}${result.stderr}`,
  ).toBe(0);
  return result.stdout.toString().trim();
}

test("real CAllocator uploads textures through malloc and host callbacks", () => {
  // Resolve both binaries: a Homebrew rustc earlier on PATH must not turn a
  // pinned nightly Cargo invocation into a stable no_std build.
  const cargo = run(["rustup", "which", "--toolchain", config.toolchain.channel, "cargo"]);
  const rustc = run(["rustup", "which", "--toolchain", config.toolchain.channel, "rustc"]);
  const cc = Bun.which("cc");
  expect(cc).not.toBeNull();

  for (const hostAllocator of [false, true]) {
    const features = ["standalone-extension-provider", "bare-platform", "software-only"];
    if (hostAllocator) features.push("host-allocator");
    run([
      cargo, "build", "--locked", "--release",
      "--manifest-path", join(crate, "Cargo.toml"),
      "--target-dir", join(build, "target"),
      "--no-default-features", "--features", features.join(","),
    ], { ...process.env, RUSTC: rustc });

    const binary = join(build, hostAllocator ? "host-allocator" : "malloc");
    run([
      cc!, "-std=c99", "-Wall", "-Wextra", "-Werror",
      ...(hostAllocator ? ["-DTEST_HOST_ALLOCATOR"] : []),
      "-I", join(crate, "include"),
      join(repository, "tests/fixtures/ui-cabi-allocator/texture_upload.c"),
      join(build, "target/release/libpocketjs_symbian_core.a"),
      "-lm", "-o", binary,
    ]);
    expect(run([binary])).toBe(
      "ui-cabi C allocator: 200 texture uploads and shutdown cleanup passed",
    );
  }
}, 180_000);
