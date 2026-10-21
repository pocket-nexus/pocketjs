import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_COMPONENTS, NATIVE_POLICY, RUST_TARGETS, nativeSourceFiles, nativeSourceDigest,
  sha256, verifyNativeReceipt, type NativeReceipt } from "../tools/esp-idf-native-receipt.ts";
import { verifyComponentVersions } from "../tools/esp-idf-component-versions.ts";
import { generatedIdfContracts } from "../tools/esp-idf-contracts.ts";
import { stageEspIdfComponents } from "../tools/esp-idf-release.ts";

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
  const pin = JSON.parse(readFileSync(join(directory, "hosts/esp-idf/native/toolchains.json"), "utf8")).esp32p4;
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
  test("generated C/Rust ABI contracts match their authority", () => {
    for (const [path, contents] of generatedIdfContracts()) expect(readFileSync(join(root, path), "utf8")).toBe(contents);
  });
  test("accepts matching source and archive", async () => {
    const f = await fixture();
    expect((await f.verify()).archiveBytes).toBe(4);
  });
  test("rejects old archives paired with modified sources", async () => {
    const f = await fixture();
    writeFileSync(join(f.directory, "hosts/esp-idf/native/ui-core/src/lib.rs"), "changed source");
    await expect(f.verify()).rejects.toThrow(/sources\/build rules changed/);
  });
  test.each([
    "engine/spec/src/lib.rs", "engine/spec/Cargo.toml",
    "engine/drivers/src/lib.rs", "engine/drivers/Cargo.toml",
    "engine/raster/src/lib.rs", "engine/raster/Cargo.toml",
    "engine/present/src/lib.rs", "engine/present/Cargo.toml",
    "engine/package/src/lib.rs", "engine/package/Cargo.toml",
    "engine/modules/media/src/lib.rs", "engine/modules/media/Cargo.toml",
  ])("rejects old archives after contract dependency changes: %s", async (path) => {
    const f = await fixture();
    writeFileSync(join(f.directory, path), "changed contract dependency");
    await expect(f.verify()).rejects.toThrow(/sources\/build rules changed/);
  });
  test("staged components resolve every native path dependency outside the repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-release-")); temporary.push(directory);
    const components = join(directory, "hosts/esp-idf/components");
    cpSync(join(root, "hosts/esp-idf/components"), components, {
      recursive: true,
      filter: path => !path.split("/").some(part => part === "lib" || part === "vendor"),
    });
    cpSync(join(root, "LICENSE"), join(directory, "LICENSE"));
    for (const native of NATIVE_COMPONENTS) {
      for (const path of await nativeSourceFiles(root, native)) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        cpSync(join(root, path), join(directory, path));
      }
      const pins = JSON.parse(readFileSync(join(directory, "hosts/esp-idf/native/toolchains.json"), "utf8"));
      for (const target of ["esp32p4", "esp32s3"] as const) {
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
    // Resolve the staged graph with Cargo, including core's extracted subsystems.
    // No workspace file or dependency path from the source tree is available.
    for (const native of NATIVE_COMPONENTS) {
      const result = Bun.spawnSync([
        "cargo", "metadata", "--offline", "--locked", "--format-version=1",
        "--manifest-path", join(output, native.component, "vendor/native/Cargo.toml"),
      ], { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const packages = JSON.parse(result.stdout.toString()).packages as Array<{ name: string; manifest_path: string }>;
      for (const name of ["pocketjs-core", "pocket-spec", "pocket-drivers", "pocket-raster", "pocket-present", "pocket-package", "pocket-media"])
        expect(packages.find(pkg => pkg.name === name)?.manifest_path).toStartWith(join(output, native.component, "vendor"));
    }
  }, 30_000);
  test("archive preparation rules participate in source identity", async () => {
    const f = await fixture();
    writeFileSync(join(f.directory, "hosts/esp-idf/components/pocketjs_ui_core/prepare_archive.cmake"), "changed rules");
    await expect(f.verify()).rejects.toThrow(/sources\/build rules changed/);
  });
  test("rejects archive tampering and size drift", async () => {
    const f = await fixture();
    writeFileSync(join(f.archive, spec.archive), new Uint8Array([9, 2, 3, 4]));
    await expect(f.verify()).rejects.toThrow(/digest\/size mismatch/);
    writeFileSync(join(f.archive, spec.archive), new Uint8Array([1, 2, 3, 4, 5]));
    await expect(f.verify()).rejects.toThrow(/digest\/size mismatch/);
  });
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
    expect(names).toHaveLength(7);
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-versions-")); temporary.push(directory);
    const components = join(directory, "hosts/esp-idf/components");
    mkdirSync(components, { recursive: true });
    cpSync(join(root, "hosts/esp-idf/components/versions.json"), join(components, "versions.json"));
    for (const name of names) {
      mkdirSync(join(components, name));
      cpSync(join(root, "hosts/esp-idf/components", name, "idf_component.yml"), join(components, name, "idf_component.yml"));
    }
    expect(verifyComponentVersions(directory)).toEqual(names);
    const file = join(components, "pocketjs_ui_qjs/idf_component.yml");
    writeFileSync(file, readFileSync(file, "utf8").replace('pocket-nexus/pocketjs_ui_core: "0.1.0"', 'pocket-nexus/pocketjs_ui_core: "9.0.0"'));
    expect(() => verifyComponentVersions(directory)).toThrow(/dependency version drift/);
  });
});
