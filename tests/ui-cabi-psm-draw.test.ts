import { BUILD_STD_NIGHTLY } from "../tools/build/toolchains/rust.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Host-side coverage for the texture pattern reported in issue #415.
// This exercises the shared upload + software-raster path through the C
// ABI; it does not establish whether the d211 device crash is fixed.
// The C ABI drives 5650/4444/8888 textures through an 8x8 image and
// the issue's two 512x512 pow2 tiles, against both the release archive
// (the device build configuration) and a debug archive (debug_assertions and
// integer-overflow checks, panic=abort like release).
const repository = fileURLToPath(new URL("..", import.meta.url));
const build = mkdtempSync(join(tmpdir(), "pocketjs-ui-cabi-psm-draw-"));
const crate = join(repository, "engine/ui-cabi");

afterAll(() => rmSync(build, { recursive: true, force: true }));

function run(command: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = Bun.spawnSync(command, {
    cwd: repository,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result;
}

function expectOk(result: ReturnType<typeof run>) {
  expect(
    result.success,
    `signal=${result.signalCode}\n${result.stdout}${result.stderr}`,
  ).toBe(true);
}

function compileAndRun(profile: "release" | "debug") {
  // A Homebrew rustc earlier on PATH must not turn the pinned nightly Cargo
  // invocation into a stable no_std build.
  const cargo = run(["rustup", "which", "--toolchain", BUILD_STD_NIGHTLY, "cargo"]);
  expectOk(cargo);
  const rustc = run(["rustup", "which", "--toolchain", BUILD_STD_NIGHTLY, "rustc"]);
  expectOk(rustc);
  const cc = Bun.which("cc");
  expect(cc).not.toBeNull();

  // Both no_std archives need abort; debug retains its overflow checks.
  // The root workspace keeps desktop unwind behavior, so select it here.
  const cargoArgs = [
    cargo.stdout.toString().trim(), "build", "--locked",
    "--manifest-path", join(crate, "Cargo.toml"),
    "--target-dir", join(build, `target-${profile}`),
    "--no-default-features", "--features", "standalone-extension-provider,bare-platform,software-only",
  ];
  if (profile === "release") cargoArgs.splice(2, 0, "--release");
  else cargoArgs.splice(2, 0, "--config", 'profile.dev.panic="abort"');

  expectOk(run(cargoArgs, { ...process.env, RUSTC: rustc.stdout.toString().trim(), CARGO_PROFILE_RELEASE_PANIC: "abort", CARGO_PROFILE_RELEASE_LTO: "true" }));

  const archive = join(build, `target-${profile}/${profile}/libpocketjs_symbian_core.a`);
  const binary = join(build, `psm_draw-${profile}`);
  expectOk(
    run([
      cc!, "-std=c99", "-Wall", "-Wextra", "-Werror",
      "-I", join(crate, "include"),
      join(repository, "tests/fixtures/ui-cabi-psm-draw/psm_draw.c"),
      archive, "-lm", "-o", binary,
    ]),
  );
  const ran = run([binary]);
  expectOk(ran);
  return ran.stdout.toString();
}

function assertDrawOutput(stdout: string) {
  const lines = stdout.trim().split("\n");
  // Two init/upload/draw/shutdown rounds for the 8x8 image, all three psm.
  for (const psm of ["PSM_5650", "PSM_4444", "PSM_8888"]) {
    const small = lines.filter((l) => l.startsWith(`${psm}: 8x8 `) && l.endsWith("RED-OK"));
    expect(small).toHaveLength(2);
  }
  // The issue's real shape: two 512x512 tiles per psm, four cross-tile probes.
  for (const psm of ["PSM_5650", "PSM_4444", "PSM_8888"]) {
    const full = lines.filter((l) => l.startsWith(`${psm}: two 512x512 tiles `) && l.endsWith("RED-OK"));
    expect(full).toHaveLength(1);
  }
  expect(stdout).toContain("psm draw: 5650/4444/8888 upload, 8x8 and 512x512 two-tile draw, all red");
  expect(stdout).not.toContain("WRONG-COLOR");
  expect(stdout).not.toContain("FAILED");
}

test("5650/4444/8888 textures upload and draw through the release C ABI archive", () => {
  assertDrawOutput(compileAndRun("release"));
}, 240_000);

test("5650/4444/8888 textures upload and draw through the debug archive (assertions and overflow checks)", () => {
  assertDrawOutput(compileAndRun("debug"));
}, 240_000);
