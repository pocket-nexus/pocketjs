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

/** The wasm core: the AOT compiler's layout oracle and the core of the web and sim hosts. */
export const HOST_WASM = OUT;

/**
 * The error text for a `pocketjs.wasm` that is not on disk, with its remedy.
 * `role` names the file for the caller ("the layout oracle"); `passed` is a
 * path the caller was given in place of HOST_WASM. A checkout contains the
 * crate `bun tools/wasm.ts` builds; the npm package ships the `.wasm` without
 * that crate (package.json `files`), so the crate's manifest tells the two
 * layouts apart.
 */
export function missingHostWasm(role: string, passed?: { option: string; path: string }): string {
  if (passed) return `${role} passed as ${passed.option} does not exist: ${resolve(passed.path)}`;
  if (existsSync(join(WASM_DIR, "Cargo.toml"))) {
    return `${role} ${OUT} is missing; build it with \`bun tools/wasm.ts\` in ${ROOT} (needs \`rustup target add wasm32-unknown-unknown\`)`;
  }
  return `${role} ${OUT} is missing from the installed @pocketjs/framework package, which ships it; reinstall the package`;
}

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
