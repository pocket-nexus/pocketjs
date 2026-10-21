import { STABLE_RUST_TOOLCHAIN } from "./build/toolchains/rust.ts";
import { resolve } from "node:path";
import { copyFileSync } from "node:fs";
const root = resolve(import.meta.dir, "..");
const crate = resolve(root, "engine/crates/pocket-text");
const child = Bun.spawn(
  [
    "cargo",
    `+${STABLE_RUST_TOOLCHAIN}`,
    "build",
    "--release",
    "--locked",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    resolve(crate, "Cargo.toml"),
  ],
  { stdout: "inherit", stderr: "inherit", env: { ...process.env, CARGO_TARGET_DIR: resolve(crate, "target"), CARGO_PROFILE_RELEASE_LTO: "true" } },
);
if ((await child.exited) !== 0 || child.signalCode) process.exit(1);
copyFileSync(
  resolve(crate, "target/wasm32-unknown-unknown/release/pocket_text.wasm"),
  resolve(root, "hosts/web/pocket_text.wasm"),
);
