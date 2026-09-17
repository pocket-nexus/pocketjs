import { resolve } from "node:path";
import { copyFileSync } from "node:fs";
const root = resolve(import.meta.dir, "..");
const crate = resolve(root, "engine/crates/pocket-text");
copyFileSync(resolve(crate, "FreeType-LICENSE.txt"), resolve(root, "hosts/web/FreeType-LICENSE.txt"));
// FreeType runs in the text worker in a separate Emscripten memory. The port
// definition shipped with Emscripten pins the upstream source and integrity hash.
// Both generated files are build output, alongside pocket_text.wasm.
const freetype = Bun.spawn(
  [
    "emcc",
    resolve(crate, "src/freetype.c"),
    "-sUSE_FREETYPE=1",
    "-Oz",
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sENVIRONMENT=web,worker,node",
    '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]',
    "-sALLOW_MEMORY_GROWTH=1",
    "-sINITIAL_MEMORY=8388608",
    "-sMAXIMUM_MEMORY=134217728",
    '-sEXPORTED_FUNCTIONS=["_malloc","_free","_pocket_ft_face","_pocket_ft_drop","_pocket_ft_render","_pocket_ft_copy"]',
    "--no-entry",
    "-o",
    resolve(root, "hosts/web/pocket_freetype.js"),
  ],
  {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      EM_NODE_JS: process.env.EM_NODE_JS ?? Bun.which("node") ?? "node",
    },
  },
);
if ((await freetype.exited) !== 0) process.exit(1);
const child = Bun.spawn(
  [
    "cargo",
    "build",
    "--release",
    "--locked",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    resolve(crate, "Cargo.toml"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await child.exited) !== 0) process.exit(1);
copyFileSync(
  resolve(crate, "target/wasm32-unknown-unknown/release/pocket_text.wasm"),
  resolve(root, "hosts/web/pocket_text.wasm"),
);
