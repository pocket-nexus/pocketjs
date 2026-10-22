import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_COMPONENTS, NATIVE_POLICY, RUST_TARGETS, nativeSourceFiles, nativeSourceDigest, sha256, verifyNativeReceipt, type NativeReceipt } from "../tools/packaging/esp-idf/receipt.ts";
import { verifyComponentVersions } from "../tools/packaging/esp-idf/component-versions.ts";
import { stageEspIdfComponents } from "../tools/packaging/esp-idf/stage.ts";

const root = new URL("..", import.meta.url).pathname;
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const spec = NATIVE_COMPONENTS[0];

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pocketjs-receipt-"));
  temporary.push(directory);
  for (const path of await nativeSourceFiles(root, spec)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    cpSync(join(root, path), join(directory, path));
  }
  const archive = join(directory, "archive");
  mkdirSync(archive);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  writeFileSync(join(archive, spec.archive), bytes);
  const pin = JSON.parse(readFileSync(join(directory, "tools/build/toolchains/esp-idf/compiler-pins.json"), "utf8")).esp32p4;
  const receipt: NativeReceipt = {
    schemaVersion: 2, component: spec.component, target: "esp32p4", rustTarget: RUST_TARGETS.esp32p4,
    compiler: `release: ${pin.release}\ncommit-hash: ${pin.commit}`,
    archiver: { version: "test archiver", executableSha256: "0".repeat(64) },
    sourceSha256: await nativeSourceDigest(directory, spec), archiveSha256: sha256(bytes),
    archiveBytes: bytes.length, policy: NATIVE_POLICY,
  };
  const save = () => writeFileSync(join(archive, "build-receipt.json"), JSON.stringify(receipt));
  save();
  return { directory, archive, receipt, save, verify: () => verifyNativeReceipt(directory, spec, "esp32p4", archive) };
}

describe("ESP-IDF release integrity", () => {
  test("staged components resolve every native path dependency outside the repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-release-")); temporary.push(directory);
    const components = join(directory, "platforms/esp-idf");
    cpSync(join(root, "platforms/esp-idf"), components, {
      recursive: true,
      filter: path => !path.split("/").some(part => part === "lib" || part === "vendor"),
    });
    cpSync(join(root, "LICENSE"), join(directory, "LICENSE"));
    for (const native of NATIVE_COMPONENTS) {
      for (const path of await nativeSourceFiles(root, native)) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        cpSync(join(root, path), join(directory, path));
      }
      const pins = JSON.parse(readFileSync(join(directory, "tools/build/toolchains/esp-idf/compiler-pins.json"), "utf8"));
      for (const target of Object.keys(RUST_TARGETS) as (keyof typeof RUST_TARGETS)[]) {
        const archive = join(components, native.component, "lib", target);
        mkdirSync(archive, { recursive: true });
        const bytes = new Uint8Array([1, 2, 3, 4]);
        writeFileSync(join(archive, native.archive), bytes);
        const receipt: NativeReceipt = {
          schemaVersion: 2, component: native.component, target, rustTarget: RUST_TARGETS[target],
          compiler: `release: ${pins[target].release}\ncommit-hash: ${pins[target].commit}`,
          archiver: target === "esp32p4" ? { version: "test archiver", executableSha256: "0".repeat(64) } : null,
          sourceSha256: await nativeSourceDigest(directory, native), archiveSha256: sha256(bytes),
          archiveBytes: bytes.length, policy: NATIVE_POLICY,
        };
        writeFileSync(join(archive, "build-receipt.json"), JSON.stringify(receipt));
      }
    }
    const output = join(directory, "staged");
    await stageEspIdfComponents(directory, output);
    const include = join(output, "pocket_runtime/include");
    for (const name of ["pocket_drivers.h", "pocket_runtime.h", "pocket_spec.h"])
      expect(readFileSync(join(include, name), "utf8")).toBe(readFileSync(join(root, "contracts/generated", name), "utf8"));
    const compile = Bun.spawnSync(["cc", "-x", "c", "-std=c11", "-Werror", "-fsyntax-only", "-I", include,
      "-I", join(output, "pocket_render_esp_ppa/include"), "-"], {
      stdin: new Blob(['#include "pocket/render_esp_ppa.h"\nint main(void) { return sizeof(pocket_ppa_config) == 0; }\n']), stdout: "pipe", stderr: "pipe",
    });
    expect(compile.success, compile.stderr.toString()).toBe(true);
    // Resolve the staged graph with Cargo, including core's extracted subsystems.
    // No workspace file or dependency path from the source tree is available.
    for (const native of NATIVE_COMPONENTS) {
      const result = Bun.spawnSync([
        "cargo", "metadata", "--offline", "--locked", "--format-version=1",
        "--manifest-path", join(output, native.component, "vendor/native/Cargo.toml"),
      ], { cwd: join(output, native.component, "vendor"), stdout: "pipe", stderr: "pipe" });
      expect(result.success, result.stderr.toString()).toBe(true);
      const packages = JSON.parse(result.stdout.toString()).packages as Array<{ name: string; manifest_path: string }>;
      for (const name of ["pocket-gles", "pocket-gles1", "pocket-gles2"])
        expect(readFileSync(join(output, native.component, "vendor/packages", name, "Cargo.toml"), "utf8")).not.toContain("../../../engine");
      for (const name of ["pocketjs-core", "pocket-spec", "pocket-drivers", "pocket-raster", "pocket-present", "pocket-package", "pocket-media", "pocket-draw-ops", "pocket-glyph-pages", "pocket-runtime", "pocket-runtime-cabi", "pocket-render-esp-ppa"])
        expect(packages.find(pkg => pkg.name === name)?.manifest_path).toStartWith(join(output, native.component, "vendor"));
      const cargoHome = join(directory, "empty-cargo-home"); mkdirSync(cargoHome, { recursive: true });
      const offline = Bun.spawnSync(["cargo", "check", "--release", "--offline", "--locked", "--no-default-features", "-p", "pocket-idf-runtime"], {
        cwd: join(output, native.component, "vendor"), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: join(directory, "cargo-target") },
      });
      expect(offline.success, offline.stderr.toString()).toBe(true);
    }
  }, 120_000);
  test("rejects target, compiler, and archiver identity drift", async () => {
    const f = await fixture();
    f.receipt.rustTarget = RUST_TARGETS.esp32s3; f.save();
    await expect(f.verify()).rejects.toThrow(/mismatch/);
    f.receipt.rustTarget = RUST_TARGETS.esp32p4;
    const compiler = f.receipt.compiler;
    f.receipt.compiler = "different compiler"; f.save();
    await expect(f.verify()).rejects.toThrow(/compiler differs/);
    f.receipt.compiler = compiler; f.receipt.archiver = null; f.save();
    await expect(f.verify()).rejects.toThrow(/tool identity/);
  });
  test("component versions and internal dependency ranges are checked", () => {
    const names = verifyComponentVersions(root);
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-versions-")); temporary.push(directory);
    const components = join(directory, "platforms/esp-idf");
    mkdirSync(components, { recursive: true });
    cpSync(join(root, "platforms/esp-idf/versions.json"), join(components, "versions.json"));
    for (const name of names) {
      mkdirSync(join(components, name));
      cpSync(join(root, "platforms/esp-idf", name, "idf_component.yml"), join(components, name, "idf_component.yml"));
    }
    expect(verifyComponentVersions(directory)).toEqual(names);
    const file = join(components, "pocket_guest_quickjs/idf_component.yml");
    writeFileSync(file, readFileSync(file, "utf8").replace('pocket-nexus/pocket_runtime: "0.1.0"', 'pocket-nexus/pocket_runtime: "9.0.0"'));
    expect(() => verifyComponentVersions(directory)).toThrow(/dependency version drift/);
  });
});
