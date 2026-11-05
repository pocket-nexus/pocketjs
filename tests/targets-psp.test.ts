import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePspBuildToolchain } from "../tools/build/toolchains/psp/build.ts";
import { BUILD_STD_NIGHTLY } from "../tools/build/toolchains/rust.ts";
import { catalogEntry } from "../tools/targets/index.ts";
import { RECEIPT_SCHEMA, RECORD_SCHEMA, expectedFiles, frameworkIdentity, storeLayout, storeTree, writeRecord } from "../tools/targets/store.ts";
import {
componentDigest,
toolchainDigest,
type Component,
type FileComponent,
type RustupComponent
} from "../tools/targets/toolchain.ts";
import { currentHost } from "../tools/targets/types.ts";
import { fakeRustup } from "./helpers/fake-rustup.ts";

const root = new URL("..", import.meta.url).pathname;
const psp = catalogEntry("psp")!;
const manifest = psp.toolchain!;
const component = <T extends Component>(name: string) => manifest.components.find((item) => item.name === name) as T;
const rust = component<RustupComponent>("rust");
const quickjs = component<FileComponent>("quickjs");

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = `/tmp/pocketjs-psp-toolchain-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(path, { recursive: true });
  temporary.push(path);
  return path;
}


describe("PSP build environment", () => {
  const host = currentHost();

  test("comes from the install record and resolves the guest compiler and Rust linker", () => {
    if (!host) return;
    const cache = tempDir();
    const env: NodeJS.ProcessEnv = { ...process.env, POCKET_NEXUS_CACHE_DIR: cache };
    const { rustup } = fakeRustup(join(cache, "rustup-home"), { [rust.toolchain]: { components: ["rust-src"] } });
    env.PATH = `${dirname(rustup)}:${process.env.PATH}`;
    const llvm = join(cache, "llvm/bin");
    const rustLib = join(cache, "rust/lib/rustlib/test-host/lib");
    const quickjsManifest = join(cache, "quickjs/libquickjs-sys/Cargo.toml");
    mkdirSync(llvm, { recursive: true });
    mkdirSync(join(dirname(rustLib), "bin"), { recursive: true });
    writeFileSync(join(llvm, "clang"), '#!/bin/sh\n[ "$1" = "--print-targets" ] || exit 2\nprintf "mipsel - MIPS little endian\\n"\n');
    chmodSync(join(llvm, "clang"), 0o755);
    writeFileSync(join(llvm, "llvm-ar"), "fixture");
    writeFileSync(join(dirname(rustLib), "bin/rust-lld"), "fixture");
    const metadataPath = join(cache, "metadata.json");
    writeFileSync(metadataPath, JSON.stringify({ packages: [{ name: "pocketjs-psp", dependencies: [{name:"libquickjs-sys", source:"git+https://example.invalid/psp?rev=pinned"}] }, {name:"libquickjs-sys", manifest_path:"/wrong-vita/Cargo.toml", source:"git+https://example.invalid/vita?rev=other#other"}, { name: "libquickjs-sys", manifest_path: quickjsManifest, source:"git+https://example.invalid/psp?rev=pinned#pinned" }] }));
    env.POCKETJS_LLVM_BIN = llvm;
    env.FAKE_PSP_METADATA = metadataPath;
    env.FAKE_PSP_LIBDIR = rustLib;
    env.FAKE_PSP_SYSROOT = join(cache, "rust");
    writeFileSync(rustup, readFileSync(rustup, "utf8").replace("set -e", `set -e
if [ "$1" = "run" ] && [ "$3 $4" = "cargo metadata" ]; then cat "$FAKE_PSP_METADATA"; exit 0; fi
if [ "$1" = "run" ] && [ "$3 $4 $5" = "rustc --print target-libdir" ]; then printf '%s\\n' "$FAKE_PSP_LIBDIR"; exit 0; fi
if [ "$1" = "run" ] && [ "$3 $4 $5" = "rustc --print sysroot" ]; then printf '%s\\n' "$FAKE_PSP_SYSROOT"; exit 0; fi`));
    expect(() => resolvePspBuildToolchain(env)).toThrow("run: pocket target add psp");

    // Publish every store component by hand, as `pocket target add psp` would.
    const layout = storeLayout(env);
    const components: Record<string, unknown> = {};
    for (const item of manifest.components) {
      const digest = componentDigest(item, host);
      if (item.kind === "rustup") {
        components[item.name] = { kind: item.kind, role: item.role, digest, location: { rustup: item.toolchain } };
        continue;
      }
      for (const file of expectedFiles(item)) {
        mkdirSync(dirname(join(storeTree(layout, digest), file)), { recursive: true });
        writeFileSync(join(storeTree(layout, digest), file), "fixture");
      }
      writeFileSync(join(layout.store, digest, "receipt.json"), JSON.stringify({ schema: RECEIPT_SCHEMA, digest, pin: {}, verified: {}, installedAt: "" }));
      components[item.name] = { kind: item.kind, role: item.role, digest, location: { store: digest } };
    }
    writeRecord(layout, {
      schema: RECORD_SCHEMA,
      target: "psp",
      digest: toolchainDigest(manifest, host),
      host,
      framework: frameworkIdentity(),
      components: components as never,
      installedAt: new Date().toISOString(),
    });

    const toolchain = resolvePspBuildToolchain(env);
    const tree = (name: string) => storeTree(layout, componentDigest(component(name), host));
    expect(toolchain.rustToolchain).toBe(BUILD_STD_NIGHTLY);
    expect(toolchain.sdk).toBe(tree("sdk"));
    expect(toolchain.environment.PSP_SDK).toBe(tree("sdk"));
    expect(toolchain.environment.PSPDEV).toBe(tree("sdk"));
    expect(toolchain.environment.QUICKJS_PREBUILT_LIB).toBe(join(tree("quickjs"), quickjs.file));
    expect(toolchain.environment.RUSTUP_AUTO_INSTALL).toBe("0");
    expect(toolchain.environment.PATH!.split(":")[0]).toBe(join(tree("cargo-psp"), "bin"));
    expect(toolchain.environment.POCKET_QJS_SOURCE).toBe(join(dirname(quickjsManifest), "embed/quickjs"));
    expect(toolchain.environment.POCKET_PSP_CC).toBe(join(llvm, "clang"));
    expect(toolchain.environment.POCKET_PSP_AR).toBe(join(llvm, "llvm-ar"));
    expect(toolchain.environment.POCKET_PSP_LLD).toBe(join(dirname(rustLib), "bin/rust-lld"));
    expect(toolchain.environment.CARGO_TARGET_MIPSEL_SONY_PSP_LINKER).toBe(join(root, "tools/psp-linker.ts"));
    for (const variable of ["TARGET_CFLAGS", "AR_mipsel_sony_psp"]) {
      expect(toolchain.environment[variable], variable).toBe(process.env[variable]);
    }
    writeFileSync(join(llvm, "clang"), '#!/bin/sh\nprintf "aarch64 - ARM64\\n"\n');
    expect(() => resolvePspBuildToolchain(env)).toThrow("Clang with the MIPS backend");
  });
});
