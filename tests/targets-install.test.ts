import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { POCKET_PLATFORM_CONTRACTS } from "../contracts/spec/platforms.ts";
import { addTarget, escapingLinks, InstallError, prune, removeTarget, unsafeEntries } from "../tools/targets/install.ts";
import { publishStagedDirectory, withArtifactLock, withSharedLock } from "../tools/targets/lock.ts";
import {
  requireToolchain,
  storeLayout,
  storeTree,
  targetLock,
  targetState,
  ToolchainError,
} from "../tools/targets/store.ts";
import {
  componentDigest,
  toolchainDigest,
  validateToolchain,
  type Component,
  type ToolchainManifest,
} from "../tools/targets/toolchain.ts";
import { currentHost, type HostId, type TargetDescriptor } from "../tools/targets/types.ts";
import { fakeRustup as makeFakeRustup } from "./helpers/fake-rustup.ts";

const host: HostId = currentHost() ?? "linux-x64";
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const path = `/tmp/pocketjs-targets-${label}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(path, { recursive: true });
  temporary.push(path);
  return path;
}

// ---------------------------------------------------------------------------
// fixtures: a tar writer, an HTTP server that counts requests, a fake rustup
// ---------------------------------------------------------------------------

type TarEntry = { name: string; body?: string; link?: string };

/** A ustar archive; symbolic links when `link` is given. */
function tar(entries: TarEntry[]): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const body = encoder.encode(entry.body ?? "");
    const header = new Uint8Array(512);
    const field = (offset: number, length: number, value: string) => header.set(encoder.encode(value).slice(0, length), offset);
    const octal = (offset: number, length: number, value: number) => field(offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
    field(0, 100, entry.name);
    octal(100, 8, entry.link ? 0o777 : 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, entry.link ? 0 : body.length);
    octal(136, 12, 0);
    field(148, 8, "        ");
    field(156, 1, entry.link ? "2" : "0");
    if (entry.link) field(157, 100, entry.link);
    field(257, 6, "ustar\0");
    field(263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header);
    if (!entry.link && body.length > 0) {
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const files = new Map<string, Uint8Array<ArrayBuffer>>();
const requests = new Map<string, number>();
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    const body = files.get(path);
    return body ? new Response(body) : new Response("missing", { status: 404 });
  },
});
afterAll(() => server.stop(true));

/** Serves `bytes` and returns its source pin. */
function serve(path: string, bytes: Uint8Array | string): { url: string; sha256: string } {
  const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  files.set(path, body);
  requests.set(path, 0);
  return { url: `http://127.0.0.1:${server.port}${path}`, sha256: sha256(body) };
}

function descriptor(manifest: Omit<ToolchainManifest, "schema" | "target">, id = "fixture", hosts: HostId[] = [host]): TargetDescriptor {
  return {
    id,
    title: `Fixture ${id}`,
    contract: { kind: "registry", target: id, registry: () => POCKET_PLATFORM_CONTRACTS },
    hosts,
    toolchain: { schema: "pocket-toolchain/2", target: id, ...manifest },
  };
}

function environment(): NodeJS.ProcessEnv {
  return { ...process.env, POCKET_NEXUS_CACHE_DIR: tempDir("cache"), FAKE_CARGO_BINARIES: "tool-a tool-b" };
}

const quiet = { log: () => {} };
const fakeRustup = () => makeFakeRustup(tempDir("rustup"));

function sdkArchive(path = "/sdk.tar.gz") {
  return serve(path, Bun.gzipSync(tar([
    { name: "sdk/include/sdk.h", body: "#define SDK 1\n" },
    { name: "sdk/lib/libsdk.a", body: "archive" },
    { name: "sdk/lib/libsdk.so", link: "libsdk.a" },
  ])));
}

// ---------------------------------------------------------------------------

describe("toolchain manifests", () => {
  const rust: Component = { name: "rust", role: "toolchain", kind: "rustup", toolchain: "nightly-2026-05-28", components: ["rust-src"], targets: [] };
  const file: Component = { name: "blob", role: "toolchain", kind: "file", source: { url: "https://example.com/a", sha256: "a".repeat(64) }, file: "a.bin" };
  const player: Component = { name: "player", role: "run", kind: "file", source: { url: "https://example.com/p", sha256: "b".repeat(64) }, file: "p.bin" };

  test("validation rejects floating pins and malformed components", () => {
    const manifest = (components: Component[]): ToolchainManifest => ({ schema: "pocket-toolchain/2", target: "x", components });
    expect(validateToolchain(manifest([rust, file, player]), "x")).toEqual([]);
    expect(validateToolchain(manifest([{ ...rust, toolchain: "stable" } as Component]), "x")[0]).toContain("not a version or a dated channel");
    expect(validateToolchain(manifest([{ ...file, source: { url: "https://e/a", sha256: "abc" } } as Component]), "x")[0]).toContain("not a SHA-256");
    expect(validateToolchain(manifest([file, file]), "x")).toContain("components[1] blob: name repeats");
    expect(validateToolchain(manifest([{
      name: "tools", role: "toolchain", kind: "cargo-install", source: { git: "https://e/r.git", revision: "f".repeat(40) },
      package: "tools", binaries: ["t"], toolchain: "nightly-2026-05-28",
    }]), "x")[0]).toContain("not installed by an earlier rustup component");
    expect(validateToolchain(manifest([{ ...file, file: "../a" } as Component]), "x")[0]).toContain("not a file name");
  });

  test("the toolchain digest changes with a toolchain pin and not with a run component", () => {
    const base: ToolchainManifest = { schema: "pocket-toolchain/2", target: "x", components: [rust, file] };
    const digest = toolchainDigest(base, host);
    expect(toolchainDigest({ ...base, components: [rust, file, player] }, host)).toBe(digest);
    expect(toolchainDigest({ ...base, components: [rust, { ...file, source: { url: "https://example.com/a", sha256: "c".repeat(64) } } as Component] }, host)).not.toBe(digest);
    expect(toolchainDigest({ ...base, components: [{ ...rust, components: ["rust-src", "clippy"] } as Component, file] }, host)).not.toBe(digest);
  });

  test("a component digest covers the pin, not the name or the role", () => {
    expect(componentDigest({ ...file, name: "other", role: "run" } as Component, host)).toBe(componentDigest(file, host));
    const perHost: Component = { name: "p", role: "toolchain", kind: "file", file: "a.bin", source: { "linux-x64": file.source as never, "darwin-arm64": { url: "https://example.com/mac", sha256: "d".repeat(64) } } };
    expect(componentDigest(perHost, "linux-x64")).toBe(componentDigest(file, "linux-x64"));
    expect(componentDigest(perHost, "darwin-arm64")).not.toBe(componentDigest(file, "darwin-arm64"));
  });

  test("the catalog manifests validate", async () => {
    const { CATALOG } = await import("../tools/targets/index.ts");
    for (const entry of CATALOG.filter((item) => item.toolchain)) {
      expect(validateToolchain(entry.toolchain!, entry.id), entry.id).toEqual([]);
    }
  });
});

describe("pocket target add", () => {
  test("installs archives, files, rustup toolchains and cargo installs, then records them", async () => {
    const env = environment();
    const { rustup } = fakeRustup();
    const sdk = sdkArchive();
    const blob = serve("/blob.a", "prebuilt");
    const target = descriptor({
      components: [
        { name: "rust", role: "toolchain", kind: "rustup", toolchain: "nightly-2026-05-28", components: ["rust-src"], targets: ["wasm32-unknown-unknown"] },
        { name: "tools", role: "toolchain", kind: "cargo-install", source: { git: "https://example.com/tools.git", revision: "f".repeat(40) }, package: "tools", binaries: ["tool-a", "tool-b"], toolchain: "nightly-2026-05-28" },
        { name: "sdk", role: "toolchain", kind: "archive", source: sdk, format: "tar.gz", root: "sdk", markers: ["include/sdk.h", "lib/libsdk.a"] },
        { name: "blob", role: "toolchain", kind: "file", source: blob, file: "libblob.a" },
      ],
    });
    expect(targetState(target, { env, rustup }).state).toBe("not installed");
    expect(() => requireToolchain(target, { env, rustup })).toThrow("run: pocket target add fixture");

    const record = await addTarget(target, { env, rustup, ...quiet });
    expect(record.digest).toBe(toolchainDigest(target.toolchain!, host));
    expect(Object.keys(record.components)).toEqual(["rust", "tools", "sdk", "blob"]);

    const toolchain = requireToolchain(target, { env, rustup })!;
    expect(toolchain.toolchain("rust")).toBe("nightly-2026-05-28");
    expect(readFileSync(join(toolchain.path("sdk"), "include/sdk.h"), "utf8")).toBe("#define SDK 1\n");
    expect(readFileSync(join(toolchain.path("sdk"), "lib/libsdk.so"), "utf8")).toBe("archive");
    expect(readFileSync(join(toolchain.path("blob"), "libblob.a"), "utf8")).toBe("prebuilt");
    expect(existsSync(join(toolchain.path("tools"), "bin/tool-b"))).toBe(true);
    const layout = storeLayout(env);
    expect(readdirSync(layout.tmp)).toEqual([]);
  });

  test("a second add fetches nothing, and two concurrent adds fetch once", async () => {
    const env = environment();
    const sdk = sdkArchive("/once.tar.gz");
    const target = descriptor({
      components: [{ name: "sdk", role: "toolchain", kind: "archive", source: sdk, format: "tar.gz", root: "sdk", markers: ["lib/libsdk.a"] }],
    });
    const other = descriptor({
      components: [{ name: "same-sdk", role: "toolchain", kind: "archive", source: sdk, format: "tar.gz", root: "sdk", markers: ["lib/libsdk.a"] }],
    }, "other");
    await Promise.all([addTarget(target, { env, ...quiet }), addTarget(target, { env, ...quiet }), addTarget(other, { env, ...quiet })]);
    expect(requests.get("/once.tar.gz")).toBe(1);
    await addTarget(target, { env, ...quiet });
    expect(requests.get("/once.tar.gz")).toBe(1);
    expect(requireToolchain(target, { env })!.path("sdk")).toBe(requireToolchain(other, { env })!.path("same-sdk"));
  });

  test("a SHA-256 mismatch leaves no store entry and no record", async () => {
    const env = environment();
    const good = serve("/tampered.a", "original");
    files.set("/tampered.a", new TextEncoder().encode("tampered"));
    const target = descriptor({ components: [{ name: "blob", role: "toolchain", kind: "file", source: good, file: "blob.a" }] });
    await expect(addTarget(target, { env, ...quiet })).rejects.toThrow("SHA-256 mismatch");
    const layout = storeLayout(env);
    expect(existsSync(layout.store) ? readdirSync(layout.store) : []).toEqual([]);
    expect(existsSync(layout.targets) ? readdirSync(layout.targets) : []).toEqual([]);
    expect(targetState(target, { env }).state).toBe("not installed");
  });

  test("archive entries and links that leave the directory are rejected", async () => {
    expect(unsafeEntries(["sdk/a", "/etc/passwd", "sdk/../../x", "sdk/..hidden"])).toEqual(["/etc/passwd", "sdk/../../x"]);
    const env = environment();
    for (const [path, entries] of [
      ["/dotdot.tar.gz", [{ name: "sdk/ok", body: "x" }, { name: "sdk/../../evil", body: "x" }]],
      ["/link.tar.gz", [{ name: "sdk/ok", body: "x" }, { name: "sdk/escape", link: "../../../../etc" }]],
    ] as const) {
      const target = descriptor({
        components: [{ name: "sdk", role: "toolchain", kind: "archive", source: serve(path, Bun.gzipSync(tar([...entries]))), format: "tar.gz", root: "sdk", markers: ["ok"] }],
      });
      await expect(addTarget(target, { env, ...quiet })).rejects.toThrow("leave the directory");
    }
    const inside = tempDir("links");
    mkdirSync(join(inside, "lib"));
    Bun.spawnSync(["ln", "-s", "../lib", join(inside, "lib/self")]);
    expect(escapingLinks(inside)).toEqual([]);
  });

  test("a zip archive extracts through unzip", async () => {
    if (!Bun.which("zip") || !Bun.which("unzip")) return;
    const source = tempDir("zip");
    mkdirSync(join(source, "root/psp/lib"), { recursive: true });
    writeFileSync(join(source, "root/psp/lib/libc.a"), "libc");
    Bun.spawnSync(["zip", "-qr", "archive.zip", "root"], { cwd: source });
    const env = environment();
    const target = descriptor({
      components: [{ name: "sdk", role: "toolchain", kind: "archive", source: serve("/sdk.zip", readFileSync(join(source, "archive.zip"))), format: "zip", root: "root", markers: ["psp/lib/libc.a"] }],
    });
    await addTarget(target, { env, ...quiet });
    expect(readFileSync(join(requireToolchain(target, { env })!.path("sdk"), "psp/lib/libc.a"), "utf8")).toBe("libc");
  });

  test("a host outside the descriptor's hosts and a component without a source are errors", async () => {
    const env = environment();
    const elsewhere: HostId = host === "linux-x64" ? "darwin-arm64" : "linux-x64";
    const unsupported = descriptor({ components: [] }, "elsewhere", [elsewhere]);
    await expect(addTarget(unsupported, { env, ...quiet })).rejects.toThrow(`does not install on ${host}`);
    expect(targetState(unsupported, { env }).state).toBe("unsupported");

    const target = descriptor({
      components: [{ name: "blob", role: "toolchain", kind: "file", source: { [elsewhere]: serve("/only.a", "x") }, file: "only.a" }],
    });
    await expect(addTarget(target, { env, ...quiet })).rejects.toThrow(`blob has no source for ${host}`);
  });

  test("a missing rustup is an error naming rustup.rs", async () => {
    const env = environment();
    const target = descriptor({ components: [{ name: "rust", role: "toolchain", kind: "rustup", toolchain: "1.93.0", components: [], targets: [] }] });
    const error = await addTarget(target, { env, rustup: null, ...quiet }).catch((caught) => caught);
    expect(error).toBeInstanceOf(InstallError);
    expect(error.message).toContain("https://rustup.rs");
  });
});

describe("readiness", () => {
  test("outdated: a record for another toolchain digest names the framework that wrote it", async () => {
    const env = environment();
    const first = descriptor({ components: [{ name: "blob", role: "toolchain", kind: "file", source: serve("/v1.a", "v1"), file: "blob.a" }] });
    await addTarget(first, { env, ...quiet });
    const second = descriptor({ components: [{ name: "blob", role: "toolchain", kind: "file", source: serve("/v2.a", "v2"), file: "blob.a" }] });
    const state = targetState(second, { env });
    expect(state.state).toBe("outdated");
    expect(() => requireToolchain(second, { env })).toThrow(/installed for toolchain [0-9a-f]{8} \(@pocketjs\/framework/);
  });

  test("broken: a deleted store entry or an uninstalled rustup toolchain is named", async () => {
    const env = environment();
    const { rustup, state } = fakeRustup();
    const target = descriptor({
      components: [
        { name: "rust", role: "toolchain", kind: "rustup", toolchain: "nightly-2026-05-28", components: ["rust-src"], targets: [] },
        { name: "blob", role: "toolchain", kind: "file", source: serve("/broken.a", "x"), file: "blob.a" },
      ],
    });
    const record = await addTarget(target, { env, rustup, ...quiet });
    const blobDigest = (record.components.blob!.location as { store: string }).store;
    rmSync(storeTree(storeLayout(env), blobDigest), { recursive: true });
    rmSync(join(state, "nightly-2026-05-28"), { recursive: true });
    const result = targetState(target, { env, rustup });
    expect(result.state).toBe("broken");
    if (result.state !== "broken") throw new Error("unreachable");
    expect(result.missing).toEqual(["rustup toolchain nightly-2026-05-28", expect.stringContaining("blob: ")]);
    expect(() => requireToolchain(target, { env, rustup })).toThrow(ToolchainError);
    await addTarget(target, { env, rustup, ...quiet });
    expect(targetState(target, { env, rustup }).state).toBe("installed");
  });

  test("a target without a manifest resolves to nothing and one with an empty manifest is ready", () => {
    const env = environment();
    const { toolchain: _toolchain, ...unmanaged } = descriptor({ components: [] });
    expect(targetState(unmanaged, { env }).state).toBe("no manifest");
    expect(requireToolchain(unmanaged, { env })).toBeNull();
    expect(targetState(descriptor({ components: [] }), { env }).state).toBe("nothing to install");
  });
});

describe("pocket target remove", () => {
  test("removes the records, prunes what no record names, and keeps shared components", async () => {
    const env = environment();
    const shared = serve("/shared.a", "shared");
    const own = serve("/own.a", "own");
    const a = descriptor({
      components: [
        { name: "shared", role: "toolchain", kind: "file", source: shared, file: "shared.a" },
        { name: "own", role: "toolchain", kind: "file", source: own, file: "own.a" },
      ],
    }, "a");
    const b = descriptor({ components: [{ name: "shared", role: "toolchain", kind: "file", source: shared, file: "shared.a" }] }, "b");
    await addTarget(a, { env, ...quiet });
    await addTarget(b, { env, ...quiet });
    const { records, pruned } = await removeTarget("a", { env });
    expect(records).toBe(1);
    expect(pruned).toEqual([componentDigest(a.toolchain!.components[1]!, host)]);
    expect(targetState(a, { env }).state).toBe("not installed");
    expect(targetState(b, { env }).state).toBe("installed");
  });

  test("remove waits for a build that holds the record", async () => {
    const env = environment();
    const target = descriptor({ components: [{ name: "blob", role: "toolchain", kind: "file", source: serve("/held.a", "x"), file: "blob.a" }] });
    await addTarget(target, { env, ...quiet });
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const build = withSharedLock(targetLock(storeLayout(env), "fixture"), async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await inside;
    let removed = false;
    const removal = removeTarget("fixture", { env }).then(() => { removed = true; });
    await Bun.sleep(300);
    expect(removed).toBe(false);
    expect(targetState(target, { env }).state).toBe("installed");
    release();
    await build;
    await removal;
    expect(targetState(target, { env }).state).toBe("not installed");
  });

  test("prune keeps the components an unfinished add holds", async () => {
    const env = environment();
    const layout = storeLayout(env);
    const held = join(layout.store, "f".repeat(64));
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const add = withSharedLock(join(layout.locks, "store.lock"), async () => {
      mkdirSync(held, { recursive: true });
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await inside;
    let pruned: string[] | undefined;
    const pruning = prune(layout).then((result) => { pruned = result; });
    await Bun.sleep(300);
    expect(pruned).toBeUndefined();
    expect(existsSync(held)).toBe(true);
    release();
    await add;
    await pruning;
    expect(pruned).toEqual(["f".repeat(64)]);
  });
});

describe("locks", () => {
  test("artifact locks time out, recover stale owners, and clean up", async () => {
    const base = tempDir("lock");
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
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ token: "abandoned", pid: 2_147_483_647, hostname: hostname() }));
    utimesSync(lock, old, old);
    expect(await withArtifactLock(lock, async () => "recovered", { timeoutMs: 100, staleMs: 10, pollMs: 2 })).toBe("recovered");

    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ token: "fresh-but-dead", pid: 2_147_483_647, hostname: hostname() }));
    expect(await withArtifactLock(lock, async () => "recovered immediately", { timeoutMs: 100, staleMs: 60_000, pollMs: 2 })).toBe("recovered immediately");
  });

  test("publishes only complete staged directories", () => {
    const base = tempDir("publish");
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
});
