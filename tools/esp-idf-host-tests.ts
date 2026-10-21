#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePocketPackage, findSection, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { pack, unpack } from "../framework/compiler/pak.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = process.env.POCKETJS_HOST_TEST_BUILD ?? mkdtempSync(join(tmpdir(), "pocketjs-idf-host-"));
const quickjs = resolve(process.env.POCKETJS_QUICKJS_SOURCE ?? join(root,
  "hosts/esp-idf/examples/smoke/managed_components/espressif__quickjs-ng/quickjs-ng"));
function run(cmd: string[], env: Record<string, string | undefined> = process.env) {
  const result = Bun.spawnSync(cmd, { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`command failed: ${cmd.join(" ")}`);
}
const pkg = decodePocketPackage(new Uint8Array(readFileSync(join(root, "hosts/esp-idf/examples/prebuilt/idf-smoke.pocket"))));
const blobs = unpack(findSection(pkg.variants[0], POCKET_SECTION.pak)!);
blobs.push({ key: "ui:img.transaction-test", dtype: 1, data: new Uint8Array([1,0,1,0,3,0,0,0,4,5,6,255]) });
await Bun.write(join(output, "valid.pak"), pack(blobs));
await Bun.write(join(output, "invalid.pak"), pack(blobs.map(b => b.key === "ui:styles" ? { ...b, data: new Uint8Array([0]) } : b)));
run(["cargo", "build", "--locked", "--release", "--no-default-features", "--manifest-path", "hosts/esp-idf/native/ui-core/Cargo.toml"],
  { ...process.env, CARGO_ENCODED_RUSTFLAGS: "", RUSTFLAGS: "", RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "",
    CARGO_TARGET_DIR: join(output, "cargo/ui-core") });
run(["cargo", "test", "--locked", "--manifest-path", "hosts/esp-idf/tests/native/Cargo.toml"]);
run(["cmake", "-S", "hosts/esp-idf/tests/host", "-B", output, "-G", "Ninja", `-DPOCKETJS_QUICKJS_SOURCE=${quickjs}`,
  `-DPOCKETJS_UI_CORE_ARCHIVE=${join(output, "cargo/ui-core/release/libpocketjs_idf_ui_core.a")}`]);
run(["cmake", "--build", output, "-j", "4"]);
run(["ctest", "--test-dir", output, "--output-on-failure"]);
console.log(`ESP-IDF host regression artifacts: ${output}`);
