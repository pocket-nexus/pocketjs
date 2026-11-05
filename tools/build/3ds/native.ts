// Native mechanisms shared by the minimal 3DS program and independent product.
import { existsSync, mkdirSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeBuildContext } from "../../../framework/src/host-config.ts";
import { canonicalProfileJson, hashPocketProfile, type PocketProfile } from "../../../framework/src/profile.ts";
import { RUST_TOOLCHAINS } from "../toolchains/rust.ts";
import { containerPathFor, ensureQuickJs, runContainer, THREE_DS_CONTAINER_IMAGE, type Mount } from "../toolchains/3ds.ts";
export { containerPathFor, ensureQuickJs, THREE_DS_CONTAINER_IMAGE } from "../toolchains/3ds.ts";
const repository = resolve(import.meta.dir, "../../..");
const RUST_TARGET = "armv6k-nintendo-3ds";
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function capture(
  command: string,
  args: readonly string[],
  cwd = repository,
): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [command, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: child.signalCode ? 128 : exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function preflightContainer(): Promise<string> {
  if (!Bun.which("docker")) {
    throw new Error(
      "PocketJS 3ds: docker was not found on PATH. The 3DS C toolchain " +
        "(arm-none-eabi-gcc, libctru, citro3d, picasso, 3dsxtool) only exists " +
        "in a container; install Docker Desktop and start it.",
    );
  }
  const daemon = await capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (daemon.exitCode !== 0) {
    throw new Error(
      "PocketJS 3ds: the Docker daemon is not responding — start Docker Desktop and retry.\n" +
        (daemon.stderr.trim() || daemon.stdout.trim()),
    );
  }
  const image = await capture("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    THREE_DS_CONTAINER_IMAGE,
  ]);
  if (image.exitCode !== 0) {
    throw new Error(
      `PocketJS 3ds: the ${THREE_DS_CONTAINER_IMAGE} image is not present locally. Run:\n` +
        `  docker pull ${THREE_DS_CONTAINER_IMAGE}`,
    );
  }
  return image.stdout.trim();
}

/**
 * The shared BUILD_STD_NIGHTLY pin supplies the target and rust-src.
 */
async function preflightRust(): Promise<{ rustup: string; toolchain: string; rustcPath: string }> {
  const rustup = Bun.which("rustup") ?? `${homedir()}/.cargo/bin/rustup`;
  if (!existsSync(rustup)) {
    throw new Error(
      "PocketJS 3ds: rustup not found (expected ~/.cargo/bin/rustup). Install Rust from https://rustup.rs.",
    );
  }
  const toolchain = RUST_TOOLCHAINS.threeDs;
  const rustc = await capture(rustup, ["run", toolchain, "rustc", "--version"]);
  if (rustc.exitCode !== 0) {
    throw new Error(
      `PocketJS 3ds: the ${toolchain} toolchain is not installed. Run:\n` +
        `  rustup toolchain install ${toolchain}`,
    );
  }
  const components = await capture(rustup, [
    "component",
    "list",
    "--toolchain",
    toolchain,
    "--installed",
  ]);
  if (!components.stdout.split(/\r?\n/).some((line) => line.startsWith("rust-src"))) {
    throw new Error(
      `PocketJS 3ds: rust-src is required to build core/alloc for ${RUST_TARGET}. Run:\n` +
        `  rustup component add rust-src --toolchain ${toolchain}`,
    );
  }
  const compiler = await capture(rustup, ["which", "--toolchain", toolchain, "rustc"]);
  if (compiler.exitCode !== 0) throw new Error("PocketJS 3ds: cannot resolve the pinned Rust compiler");
  return { rustup, toolchain, rustcPath: compiler.stdout.trim() };
}


export interface Native3ds {
  readonly imageId: string;
  readonly library: string;
  readonly quickJsDirectory: string;
  readonly mounts: readonly Mount[];
}
export async function prepareNative3ds(options: {
  packageName: string; archiveName: string; targetDirectory: string;
  cargoArgs?: readonly string[]; roots: readonly string[];
  context?: RuntimeBuildContext;
}): Promise<Native3ds> {
  const imageId = await preflightContainer();
  const { rustup, toolchain, rustcPath } = await preflightRust();
  const targetDirectory = resolve(options.targetDirectory);
  const command = [rustup, "run", toolchain, "cargo", "rustc", "--locked", "--release",
    "-p", options.packageName, "--no-default-features", "--lib", "--crate-type", "staticlib",
    "--target", RUST_TARGET, "-Zbuild-std=core,alloc,compiler_builtins",
    "-Zbuild-std-features=compiler-builtins-mem", ...(options.cargoArgs ?? [])];
  const env = { ...process.env, RUSTC: rustcPath, CARGO_TARGET_DIR: targetDirectory,
    CARGO_PROFILE_RELEASE_PANIC: "abort", CARGO_PROFILE_RELEASE_LTO: "true" };
  if (options.context) await options.context.run(command, { cwd: repository, env });
  else {
    const child = Bun.spawn(command, { cwd: repository, env, stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0 || child.signalCode) throw new Error(`3DS ${options.packageName} compilation failed`);
  }
  const library = join(targetDirectory, RUST_TARGET, "release", options.archiveName);
  if (!existsSync(library)) throw new Error(`3DS archive build did not produce ${library}`);
  const mounts: Mount[] = [{ hostPath: repository, containerPath: "/repo" }];
  for (const path of [...options.roots, targetDirectory].map(path => resolve(path))) {
    if (mounts.some(mount => path === mount.hostPath || path.startsWith(`${mount.hostPath}/`))) continue;
    mkdirSync(path, { recursive: true });
    mounts.push({ hostPath: path, containerPath: `/external${mounts.length}` });
  }
  const quickJsDirectory = join(repository, "dist/3ds/quickjs");
  await ensureQuickJs(quickJsDirectory, imageId, mounts);
  return { imageId, library, quickJsDirectory, mounts };
}
export async function runNative3dsMake(options: {
  directory: string; environment: Readonly<Record<string, string>>;
  mounts: readonly Mount[]; profile: PocketProfile; context?: RuntimeBuildContext;
}): Promise<void> {
  const { environment, profile, mounts } = options;
  if (environment.POCKETJS_PROFILE_JSON !== canonicalProfileJson(profile) ||
      environment.POCKETJS_PROFILE_HASH !== hashPocketProfile(profile))
    throw new Error("PocketJS 3ds: native build requires the selected program profile");
  await runContainer(`make -j${availableParallelism()}`, mounts,
    containerPathFor(options.directory, mounts), environment, `${options.directory}/Makefile`,
    THREE_DS_CONTAINER_IMAGE, options.context?.run);
}
