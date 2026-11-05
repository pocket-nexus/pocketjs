import { STABLE_RUST_TOOLCHAIN } from "./build/toolchains/rust.ts";
// tools/wasm.ts — build programs/web/wasm/ for the browser/Bun hosts:
//   cargo build --release --target wasm32-unknown-unknown
// then copy target/wasm32-unknown-unknown/release/pocketjs_wasm.wasm to
// platforms/web/pocketjs.wasm and print its size.
//
//   bun tools/wasm.ts
//
// Needs the wasm target: rustup target add wasm32-unknown-unknown

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, delimiter } from "node:path";
import { homedir } from "node:os";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url))); // PocketJS/
const WASM_DIR = join(ROOT, "programs", "web", "wasm");
const OUT = join(ROOT, "platforms/web/pocketjs.wasm");
const BUILT = join(WASM_DIR, "target/wasm32-unknown-unknown/release/pocketjs_wasm.wasm");

// cargo lives in ~/.cargo/bin, which non-login shells may not have on PATH.
const env = {
  ...process.env,
  CARGO_TARGET_DIR: join(WASM_DIR, "target"),
  CARGO_PROFILE_RELEASE_LTO: "true",
  PATH: `${join(homedir(), ".cargo/bin")}${delimiter}${process.env.PATH ?? ""}`,
};

let pending: Promise<string> | undefined;
/** Build the current checkout core once, for headless consumers and the web host. */
export function ensureHostWasm(): Promise<string> {
  return pending ??= (async () => {
const proc = Bun.spawnSync(
  ["cargo", `+${STABLE_RUST_TOOLCHAIN}`, "build", "-p", "pocketjs-wasm", "--locked", "--release", "--target", "wasm32-unknown-unknown"],
  { cwd: WASM_DIR, env, stdout: "inherit", stderr: "inherit" },
);
if (!proc.success) {
  console.error(
    "PocketJS wasm: cargo build failed" +
      " (missing target? run: rustup target add wasm32-unknown-unknown)",
  );
  throw new Error(`PocketJS wasm build failed: ${proc.signalCode ?? proc.exitCode}`);
}
if (!existsSync(BUILT)) {
  console.error(`PocketJS wasm: build succeeded but ${BUILT} is missing`);
  throw new Error(`missing wasm build output: ${BUILT}`);
}

const bytes = await Bun.file(BUILT).arrayBuffer();
await Bun.write(OUT, bytes);
console.log(
  `PocketJS wasm: platforms/web/pocketjs.wasm (${bytes.byteLength} bytes, ${(bytes.byteLength / 1024).toFixed(1)} KiB)`,
);

return OUT;
  })();
}

if (import.meta.main) await ensureHostWasm();
