import { STABLE_RUST_TOOLCHAIN } from "../../../tools/build/toolchains/rust.ts";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeBuildContext } from "../../../framework/src/host-config.ts";
import { requireApplication } from "./application.ts";

export async function buildPocketBook(context: RuntimeBuildContext): Promise<void> {
  const application = requireApplication(context);
  if (!Bun.which("cargo-zigbuild", { PATH: process.env.PATH }) || !Bun.which("zig", { PATH: process.env.PATH })) {
    throw new Error("PocketBook native build requires cargo-zigbuild and Zig, plus the armv7-unknown-linux-gnueabi Rust target");
  }
  const root = resolve(import.meta.dir, "../../..");
  const target = resolve(context.outdir, "cargo-target");
  await context.run(["cargo", `+${STABLE_RUST_TOOLCHAIN}`, "zigbuild", "--manifest-path", resolve(root, "programs/pocketbook/Cargo.toml"), "--release", "--locked", "--target", "armv7-unknown-linux-gnueabi.2.23", ...context.args], {
    cwd: root, env: { CARGO_TARGET_DIR: target, CARGO_PROFILE_RELEASE_LTO: "true", CARGO_PROFILE_RELEASE_PANIC: "abort" },
  });
  const artifact = resolve(context.outdir, "application");
  const directory = resolve(artifact, context.output);
  mkdirSync(directory, { recursive: true });
  copyFileSync(resolve(target, "armv7-unknown-linux-gnueabi/release/pocketbook-host"), resolve(directory, "pocketbook-host"));
  chmodSync(resolve(directory, "pocketbook-host"), 0o755);
  copyFileSync(application.jsPath, resolve(directory, "app.js"));
  copyFileSync(application.pakPath, resolve(directory, "app.pak"));
  copyFileSync(application.packagePath, resolve(directory, "app.pocket"));
  const launcher = resolve(artifact, `${context.output}.app`);
  writeFileSync(launcher, `#!/bin/sh\ncd "$(dirname "$0")/${context.output}" || exit 1\nexport POCKET_JS="$PWD/app.js" POCKET_PAK="$PWD/app.pak"\nexec ./pocketbook-host >pocketjs.log 2>&1\n`);
  chmodSync(launcher, 0o755);
}
