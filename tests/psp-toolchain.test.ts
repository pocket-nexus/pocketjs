import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  PSP_TOOLCHAIN,
  cargoHostTriple,
  cachedCargoPspBin,
  cachedCargoPspRoot,
  cachedPspSdk,
  hasVerifiedCachedPspSdk,
  hasPinnedCargoPspRoot,
  hasPinnedCargoPspTools,
  pocketNexusCacheRoot,
  publishStagedDirectory,
  resolvePspBuildToolchain,
  resolvePspSdk,
  withArtifactLock,
} from "../tools/psp-toolchain.ts";

const root = new URL("..", import.meta.url).pathname;
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempRoot(): string {
  const path = `/tmp/pocketjs-toolchain-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(path, { recursive: true });
  temporary.push(path);
  return path;
}

describe("canonical PSP toolchain", () => {
  test("pins organization-owned source and binary inputs", () => {
    expect(PSP_TOOLCHAIN).toMatchObject({
      schemaVersion: 1,
      rust: { toolchain: "nightly-2026-05-28", components: ["rust-src"] },
      rustPsp: {
        repository: "https://github.com/pocket-nexus/rust-psp.git",
        rev: "2cbaf8c9bc72569c76240a1d9743de10731e5f6b",
      },
      quickJsRs: {
        repository: "https://github.com/pocket-nexus/quickjs-rs.git",
        rev: "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b",
      },
      sdk: {
        repository: "https://github.com/pocket-nexus/pspdev",
        tag: "sdk-noabicalls-normalized-2026-06-19",
        sha256: "fc7d7d502d53987f356871bc8c58396fb0f2a6eb6f5828b16c3bc3f22991a273",
      },
    });
  });

  test("uses explicit SDK authorities before the shared cache", () => {
    const env = { HOME: "/home/test", XDG_CACHE_HOME: "/var/cache/test" };
    expect(pocketNexusCacheRoot(env)).toBe("/var/cache/test/pocket-nexus");
    expect(resolvePspSdk(env)).toEqual({ path: cachedPspSdk(env), source: "cache" });
    expect(resolvePspSdk({ ...env, PSPDEV: "/opt/pspdev" })).toEqual({
      path: "/opt/pspdev",
      source: "PSPDEV",
    });
    expect(resolvePspSdk({ ...env, PSPDEV: "/opt/pspdev", PSP_SDK: "/opt/sdk" })).toEqual({
      path: "/opt/sdk",
      source: "PSP_SDK",
    });
  });

  test("only calls a cached SDK verified when its receipt matches the manifest", () => {
    const cache = tempRoot();
    const env = { HOME: cache, POCKET_NEXUS_CACHE_DIR: cache };
    const sdk = cachedPspSdk(env);
    mkdirSync(join(sdk, "psp/lib"), { recursive: true });
    writeFileSync(join(sdk, "psp/lib/libc.a"), "fixture");
    expect(hasVerifiedCachedPspSdk(env)).toBe(false);
    writeFileSync(join(sdk, PSP_TOOLCHAIN.sdk.receipt), JSON.stringify({
      tag: PSP_TOOLCHAIN.sdk.tag,
      asset: PSP_TOOLCHAIN.sdk.asset,
      url: PSP_TOOLCHAIN.sdk.url,
      sha256: PSP_TOOLCHAIN.sdk.sha256,
    }));
    expect(hasVerifiedCachedPspSdk(env)).toBe(true);
  });

  test("exports PSP_SDK and PSPDEV from the same resolved authority", () => {
    const cache = tempRoot();
    const sdk = join(cache, "override-sdk");
    const llvm = join(cache, "llvm");
    mkdirSync(join(sdk, "psp/lib"), { recursive: true });
    mkdirSync(llvm, { recursive: true });
    writeFileSync(join(sdk, "psp/lib/libc.a"), "fixture");
    writeFileSync(join(llvm, "clang"), "fixture");
    writeFileSync(join(llvm, "llvm-ar"), "fixture");
    for (const tool of PSP_TOOLCHAIN.cargoPsp.tools) {
      const path = join(cachedCargoPspBin({ HOME: cache, POCKET_NEXUS_CACHE_DIR: cache }), tool);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "fixture");
    }
    writeFileSync(join(cachedCargoPspRoot({ HOME: cache, POCKET_NEXUS_CACHE_DIR: cache }), ".crates2.json"), JSON.stringify({
      installs: {
        [`cargo-psp 0.2.8 (git+${PSP_TOOLCHAIN.rustPsp.repository}?rev=${PSP_TOOLCHAIN.rustPsp.rev}#${PSP_TOOLCHAIN.rustPsp.rev})`]: {
          bins: PSP_TOOLCHAIN.cargoPsp.tools,
          target: cargoHostTriple(),
        },
      },
    }));
    expect(hasPinnedCargoPspTools({ HOME: cache, POCKET_NEXUS_CACHE_DIR: cache })).toBe(true);

    const resolved = resolvePspBuildToolchain({
      ...process.env,
      HOME: cache,
      POCKET_NEXUS_CACHE_DIR: cache,
      POCKETJS_LLVM_BIN: llvm,
      PSP_SDK: sdk,
      PSPDEV: join(cache, "ignored"),
    });
    expect(resolved.sdk).toEqual({ path: sdk, source: "PSP_SDK" });
    expect(resolved.environment.PSP_SDK).toBe(sdk);
    expect(resolved.environment.PSPDEV).toBe(sdk);
  });

  test("rejects an invalid explicit SDK instead of falling through", () => {
    const cache = tempRoot();
    expect(() => resolvePspBuildToolchain({
      ...process.env,
      HOME: cache,
      POCKET_NEXUS_CACHE_DIR: cache,
      PSP_SDK: join(cache, "missing-explicit-sdk"),
    })).toThrow("PSP_SDK points to");
  });

  test("rejects an invalid explicit LLVM override instead of auto-detecting another LLVM", () => {
    const cache = tempRoot();
    const sdk = join(cache, "sdk");
    mkdirSync(join(sdk, "psp/lib"), { recursive: true });
    writeFileSync(join(sdk, "psp/lib/libc.a"), "fixture");
    expect(() => resolvePspBuildToolchain({
      ...process.env,
      HOME: cache,
      POCKET_NEXUS_CACHE_DIR: cache,
      PSP_SDK: sdk,
      POCKETJS_LLVM_BIN: join(cache, "missing-llvm"),
    })).toThrow("POCKETJS_LLVM_BIN points to");
  });

  test("rejects cargo tools from the wrong revision or host", () => {
    const root = join(tempRoot(), "tools");
    mkdirSync(join(root, "bin"), { recursive: true });
    for (const tool of PSP_TOOLCHAIN.cargoPsp.tools) {
      writeFileSync(join(root, "bin", tool), "fixture");
    }
    const writeMetadata = (rev: string, target: string) => writeFileSync(
      join(root, ".crates2.json"),
      JSON.stringify({ installs: {
        [`cargo-psp 0.2.8 (git+${PSP_TOOLCHAIN.rustPsp.repository}?rev=${rev}#${rev})`]: {
          bins: PSP_TOOLCHAIN.cargoPsp.tools,
          target,
        },
      } }),
    );
    writeMetadata("0000000000000000000000000000000000000000", cargoHostTriple());
    expect(hasPinnedCargoPspRoot(root)).toBe(false);
    writeMetadata(PSP_TOOLCHAIN.rustPsp.rev, "wrong-host-triple");
    expect(hasPinnedCargoPspRoot(root)).toBe(false);
    writeMetadata(PSP_TOOLCHAIN.rustPsp.rev, cargoHostTriple());
    expect(hasPinnedCargoPspRoot(root)).toBe(true);
  });

  test("artifact locks time out, recover stale owners, and clean up", async () => {
    const base = tempRoot();
    const lock = join(base, "artifact.lock");
    let release!: () => void;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const held = withArtifactLock(lock, async () => {
      acquired();
      await new Promise<void>((resolve) => { release = resolve; });
    }, { timeoutMs: 200, staleMs: 1_000, pollMs: 5 });
    await acquiredPromise;
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    await expect(withArtifactLock(
      lock,
      async () => undefined,
      { timeoutMs: 20, staleMs: 5, pollMs: 5 },
    )).rejects.toThrow("timed out waiting for artifact lock");
    release();
    await held;

    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      token: "abandoned",
      pid: 2_147_483_647,
      hostname: hostname(),
    }));
    utimesSync(lock, old, old);
    expect(await withArtifactLock(
      lock,
      async () => "recovered",
      { timeoutMs: 100, staleMs: 10, pollMs: 2 },
    )).toBe("recovered");

    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      token: "fresh-but-dead",
      pid: 2_147_483_647,
      hostname: hostname(),
    }));
    expect(await withArtifactLock(
      lock,
      async () => "recovered immediately",
      { timeoutMs: 100, staleMs: 60_000, pollMs: 2 },
    )).toBe("recovered immediately");
  });

  test("publishes only complete staged directories", () => {
    const base = tempRoot();
    const live = join(base, "live");
    const staging = join(base, "staging");
    mkdirSync(live);
    mkdirSync(staging);
    writeFileSync(join(live, "receipt"), "old");
    writeFileSync(join(staging, "receipt"), "complete");
    publishStagedDirectory(staging, live);
    expect(readFileSync(join(live, "receipt"), "utf8")).toBe("complete");
    expect(() => publishStagedDirectory(join(base, "missing"), live)).toThrow("staged artifact");
    expect(readFileSync(join(live, "receipt"), "utf8")).toBe("complete");

    mkdirSync(join(live, "nested-stage"));
    writeFileSync(join(live, "nested-stage", "receipt"), "unpublished");
    expect(() => publishStagedDirectory(join(live, "nested-stage"), live)).toThrow();
    expect(readFileSync(join(live, "receipt"), "utf8")).toBe("complete");
  });

  test("doctor treats an invalid explicit LLVM override as a required failure", () => {
    const missing = join(tempRoot(), "missing-llvm");
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(root, "tools/cli/bin.mjs"), "doctor"],
      cwd: root,
      env: { ...process.env, POCKETJS_LLVM_BIN: `  ${missing}  ` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("LLVM override (POCKETJS_LLVM_BIN)");
    expect(result.stdout.toString()).toContain(missing);
    // Spawning the CLI cold takes >5 s on CI runners; the default timeout flakes.
  }, 30_000);

  test("production entrypoints have no personal, DreamCart, or sibling toolchain fallback", async () => {
    const productionFiles = [
      "tools/bootstrap.ts",
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
  });

  test("Cargo manifests use the exact revisions from the canonical manifest", async () => {
    const pspManifests = ["hosts/psp/Cargo.toml"];
    for (const file of pspManifests) {
      const source = await Bun.file(join(root, file)).text();
      expect(source, file).toContain(`git = "${PSP_TOOLCHAIN.rustPsp.repository}"`);
      expect(source, file).toContain(`rev = "${PSP_TOOLCHAIN.rustPsp.rev}"`);
    }
    for (const file of ["hosts/psp/Cargo.toml", "hosts/vita/Cargo.toml"]) {
      const source = await Bun.file(join(root, file)).text();
      expect(source, file).toContain(`git = "${PSP_TOOLCHAIN.quickJsRs.repository}"`);
      expect(source, file).toContain(`rev = "${PSP_TOOLCHAIN.quickJsRs.rev}"`);
    }
  });

  test("committed native lockfiles contain only the organization revisions", async () => {
    const locks = {
      "hosts/psp/Cargo.lock": [PSP_TOOLCHAIN.rustPsp.rev, PSP_TOOLCHAIN.quickJsRs.rev],
      "hosts/vita/Cargo.lock": [PSP_TOOLCHAIN.quickJsRs.rev],
    } as const;
    for (const [file, revisions] of Object.entries(locks)) {
      const source = await Bun.file(join(root, file)).text();
      expect(source, file).not.toContain("github.com/doodlewind/");
      for (const revision of revisions) expect(source, file).toContain(revision);
    }
  });
});
