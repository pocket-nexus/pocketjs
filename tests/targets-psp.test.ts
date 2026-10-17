import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePspBuildToolchain } from "../tools/psp-toolchain.ts";
import { catalogEntry } from "../tools/targets/index.ts";
import { RECEIPT_SCHEMA, RECORD_SCHEMA, frameworkIdentity, storeLayout, storeTree, writeRecord, expectedFiles } from "../tools/targets/store.ts";
import {
  componentDigest,
  toolchainDigest,
  type CargoInstallComponent,
  type Component,
  type FileComponent,
  type RustupComponent,
  type Source,
} from "../tools/targets/toolchain.ts";
import { currentHost } from "../tools/targets/types.ts";
import { fakeRustup } from "./helpers/fake-rustup.ts";

const root = new URL("..", import.meta.url).pathname;
const psp = catalogEntry("psp")!;
const manifest = psp.toolchain!;
const component = <T extends Component>(name: string) => manifest.components.find((item) => item.name === name) as T;
const rust = component<RustupComponent>("rust");
const cargoPsp = component<CargoInstallComponent>("cargo-psp");
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

/** The libquickjs-sys revision a Cargo manifest pins. */
function quickjsRevision(source: string): string | undefined {
  return source.match(/libquickjs-sys = \{ git = "https:\/\/github\.com\/pocket-nexus\/quickjs-rs\.git", rev = "([0-9a-f]{40})" \}/)?.[1];
}

describe("PSP toolchain manifest", () => {
  test("pins organization-owned sources and binaries", () => {
    expect(rust).toMatchObject({ kind: "rustup", toolchain: "nightly-2026-05-28", components: ["rust-src"] });
    expect(cargoPsp.source).toEqual({ git: "https://github.com/pocket-nexus/rust-psp.git", revision: "2cbaf8c9bc72569c76240a1d9743de10731e5f6b" });
    expect(cargoPsp.toolchain).toBe(rust.toolchain);
    expect(component("sdk")).toMatchObject({
      kind: "archive",
      source: {
        url: "https://github.com/pocket-nexus/pspdev/releases/download/sdk-noabicalls-normalized-2026-06-19/mipsel-sony-psp.zip",
        sha256: "fc7d7d502d53987f356871bc8c58396fb0f2a6eb6f5828b16c3bc3f22991a273",
      },
    });
    expect((quickjs.source as Source).url).toStartWith("https://github.com/pocket-nexus/quickjs-rs/releases/download/prebuilt-psp-");
    // No compiler for C: the one C dependency arrives as a pinned archive.
    expect(manifest.components.map((item) => item.kind)).toEqual(["rustup", "cargo-install", "archive", "file"]);
    expect(psp.hosts).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);
  });

  test("the prebuilt QuickJS comes from the revision hosts/psp links", async () => {
    const revision = quickjsRevision(await Bun.file(join(root, "hosts/psp/Cargo.toml")).text());
    expect(revision).toBeDefined();
    expect((quickjs.source as Source).url).toContain(`/prebuilt-psp-${revision!.slice(0, 12)}/`);
    expect(await Bun.file(join(root, "hosts/psp/Cargo.lock")).text()).toContain(`rev=${revision}#`);
  });

  test("hosts/psp builds against the rust-psp revision cargo-psp comes from", async () => {
    const source = await Bun.file(join(root, "hosts/psp/Cargo.toml")).text();
    expect(source).toContain(`git = "${cargoPsp.source.git}"`);
    expect(source).toContain(`rev = "${cargoPsp.source.revision}"`);
    expect(await Bun.file(join(root, "hosts/psp/Cargo.lock")).text()).toContain(cargoPsp.source.revision);
  });

  test("production entrypoints have no personal, DreamCart, or sibling toolchain fallback", async () => {
    const productionFiles = [
      "tools/targets/psp.toolchain.json",
      "tools/psp-toolchain.ts",
      "tools/psp.ts",
      "tools/psp-all.ts",
      "tools/cli/bin.mjs",
      "hosts/psp/Cargo.toml",
      "hosts/vita/Cargo.toml",
      "devices/psp/pocket-psp-ge/Cargo.toml",
    ];
    for (const file of productionFiles) {
      const source = await Bun.file(join(root, file)).text();
      expect(source.toLowerCase(), file).not.toMatch(
        /(?:github\.com\/[^\s"']*dreamcart|(?:^|["'`\s])(?:\.\.\/|~\/|\/)[^\s"'`]*dreamcart|code\/dreamcart|bootstrap[^\n]*dreamcart)/m,
      );
      expect(source, file).not.toMatch(/github\.com\/doodlewind\/(?:quickjs-rs|rust-psp|pspdev)/);
      expect(source, file).not.toMatch(/path\s*=\s*"[^"]*(?:quickjs-rs|rust-psp)/);
    }
    for (const file of ["hosts/psp/Cargo.lock", "hosts/vita/Cargo.lock"]) {
      expect(await Bun.file(join(root, file)).text(), file).not.toContain("github.com/doodlewind/");
    }
  });
});

describe("PSP build environment", () => {
  const host = currentHost();

  test("comes from the install record, with the prebuilt QuickJS and no C compiler", () => {
    if (!host) return;
    const cache = tempDir();
    const env: NodeJS.ProcessEnv = { ...process.env, POCKET_NEXUS_CACHE_DIR: cache };
    const { rustup } = fakeRustup(join(cache, "rustup-home"), { [rust.toolchain]: { components: ["rust-src"] } });
    env.PATH = `${dirname(rustup)}:${process.env.PATH}`;
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
    expect(toolchain.rustToolchain).toBe("nightly-2026-05-28");
    expect(toolchain.sdk).toBe(tree("sdk"));
    expect(toolchain.environment.PSP_SDK).toBe(tree("sdk"));
    expect(toolchain.environment.PSPDEV).toBe(tree("sdk"));
    expect(toolchain.environment.QUICKJS_PREBUILT_LIB).toBe(join(tree("quickjs"), quickjs.file));
    expect(toolchain.environment.RUSTUP_AUTO_INSTALL).toBe("0");
    expect(toolchain.environment.PATH!.split(":")[0]).toBe(join(tree("cargo-psp"), "bin"));
    for (const variable of ["TARGET_CFLAGS", "AR_mipsel_sony_psp", "POCKETJS_LLVM_BIN"]) {
      expect(toolchain.environment[variable], variable).toBe(process.env[variable]);
    }
  });
});
