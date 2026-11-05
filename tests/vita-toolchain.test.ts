import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installVitaSdkBundle, type VitaSdkArchive } from "../tools/build/toolchains/vita.ts";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(escape = false) {
  const root = mkdtempSync(join(tmpdir(), "vita-sdk-")); temporary.push(root);
  const base = join(root, "base"), port = join(root, "port");
  mkdirSync(join(base, "vitasdk/bin"), { recursive: true });
  mkdirSync(join(base, "vitasdk/arm-vita-eabi"), { recursive: true });
  mkdirSync(join(port, "lib"), { recursive: true });
  writeFileSync(join(base, "vitasdk/bin/compiler"), "#!/bin/sh\necho fixture compiler\n");
  chmodSync(join(base, "vitasdk/bin/compiler"), 0o755);
  writeFileSync(join(port, "lib/port.a"), "fixture static library");
  if (escape) symlinkSync("../../outside", join(port, "escape"));
  const bytes = new Map<string, Uint8Array>();
  for (const [name, directory, format] of [["sdk.tar.bz2", base, "-cjf"], ["port.tar.xz", port, "-cJf"]]) {
    const archive = join(root, name!);
    const result = Bun.spawnSync(["tar", format!, archive, "-C", directory!, "."]);
    expect(result.success, result.stderr.toString()).toBe(true);
    bytes.set(`/${name}`, new Uint8Array(readFileSync(archive)));
  }
  const requests = new Map<string, number>();
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    return new Response(bytes.get(path) as Uint8Array<ArrayBuffer> | undefined, { status: bytes.has(path) ? 200 : 404 });
  } });
  const pins: VitaSdkArchive[] = [
    { name: "sdk", file: "sdk.tar.bz2", url: `${server.url}sdk.tar.bz2`, sha256: sha(bytes.get("/sdk.tar.bz2")!), root: "vitasdk", destination: ".", markers: ["bin/compiler"] },
    { name: "port", file: "port.tar.xz", url: `${server.url}port.tar.xz`, sha256: sha(bytes.get("/port.tar.xz")!), destination: "arm-vita-eabi", markers: ["lib/port.a"] },
  ];
  const env = { ...process.env, POCKET_NEXUS_CACHE_DIR: join(root, "cache") };
  const install = (out = join(root, "out"), archives = pins) => installVitaSdkBundle(out, archives, { env, host: "darwin-arm64", log() {} });
  return { root, pins, server, requests, env, install };
}
test("bz2 SDK and xz ports compose atomically; concurrent and cached installs reuse verified archives", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.install(), f.install()]);
    expect(a).toBe(b);
    expect(readFileSync(join(a, "arm-vita-eabi/lib/port.a"), "utf8")).toBe("fixture static library");
    expect(Bun.spawnSync([join(a, "bin/compiler")]).success).toBe(true);
    expect(f.requests.get("/sdk.tar.bz2")).toBe(1);
    expect(f.requests.get("/port.tar.xz")).toBe(1);
    expect(await f.install()).toBe(a);
    writeFileSync(join(a, "bin/compiler"), "modified");
    await expect(f.install()).rejects.toThrow(/installed tree differs/);
  } finally { f.server.stop(true); }
});
test("escaping archive symlinks and unmanaged destination trees are refused", async () => {
  const f = fixture(true);
  try {
    await expect(f.install()).rejects.toThrow(/links escape/);
    expect(existsSync(join(f.root, "out/vitasdk"))).toBe(false);
    mkdirSync(join(f.root, "out/vitasdk"));
    writeFileSync(join(f.root, "out/vitasdk/user-data"), "keep");
    await expect(f.install()).rejects.toThrow(/unmanaged directory/);
    expect(readFileSync(join(f.root, "out/vitasdk/user-data"), "utf8")).toBe("keep");
  } finally { f.server.stop(true); }
});
