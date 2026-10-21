import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const tool = join(root, "platforms/esp-idf/pocket_runtime/tools/embed_package.py");
const pkg = join(root, "tests/esp-idf/examples/prebuilt/idf-smoke.pocket");
const runtimeConfig = join(root, "tests/esp-idf/examples/smoke/pocket.runtime-config.ts");
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() {
  const path = join(root, `.pocket-build/validation/idf-embed/${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path, { recursive: true }); temporary.push(path); return path;
}
function run(profile: string, output: string) {
  return Bun.spawnSync(["python3", tool, "--package", pkg, "--profile", profile, "--name", "smoke", "--output-dir", output], { stdout: "pipe", stderr: "pipe" });
}
function exportProfile(path: string) {
  const result = Bun.spawnSync([process.execPath, join(root, "tools/pocket.ts"), "profile", "export", "--config", runtimeConfig, "--out", path], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.success, result.stdout.toString() + result.stderr.toString()).toBe(true);
  return join(path, "pocket-profile.json");
}

describe("ESP-IDF package embedding", () => {
  test("requires the independent exported identity, ABI and exact canonical JSON", () => {
    const path = directory();
    const profilePath = exportProfile(join(path, "profile"));
    const accepted = run(profilePath, join(path, "accepted"));
    expect(accepted.success, accepted.stderr.toString()).toBe(true);
    const sidecar = JSON.parse(readFileSync(profilePath, "utf8"));
    expect(sidecar.profileHash).toBe("sha256:" + createHash("sha256").update(sidecar.canonicalProfileJson).digest("hex"));
    const generated = readFileSync(join(path,"accepted/pocketjs_package_smoke.c"),"utf8");
    expect(generated).not.toContain("_profile_json");
    const reject = (value: unknown, expected: string) => {
      const file = join(path, "rejected.json"); writeFileSync(file, JSON.stringify(value));
      const result = run(file, join(path, "rejected"));
      expect(result.success).toBe(false); expect(result.stderr.toString()).toContain(expected);
    };
    reject({ ...sidecar, hostAbi: sidecar.hostAbi + 1 }, "host ABI does not match");
    reject({ ...sidecar, profileHash: "sha256:" + "00".repeat(32) }, "export hash does not match");
    reject({ ...sidecar, profile: { ...sidecar.profile, tickHz: 61 } }, "differs from canonicalProfileJson");
    const canonicalProfileJson = sidecar.canonicalProfileJson + "\n";
    reject({ ...sidecar, canonicalProfileJson, profileHash: "sha256:" + createHash("sha256").update(canonicalProfileJson).digest("hex") }, "package profile hash does not match");
    reject({ ...sidecar, format: "pocket-profile/999" }, "unsupported");
  });

  test("CMake embeds a prebuilt package without invoking Pocket or Bun", () => {
    const path = directory();
    const exported = join(path, "exported"); exportProfile(exported);
    const bin = join(path, "bin"); mkdirSync(bin);
    const invoked = join(path, "unexpected-cli");
    for (const name of ["pocket", "bun"]) {
      const file = join(bin, name); writeFileSync(file, `#!/bin/sh\ntouch '${invoked}'\nexit 99\n`); chmodSync(file, 0o755);
    }
    writeFileSync(join(path, "dummy.c"), "int offline_fixture(void) { return 0; }\n");
    writeFileSync(join(path, "CMakeLists.txt"), `cmake_minimum_required(VERSION 3.20)
project(offline C)
add_library(app STATIC dummy.c)
target_include_directories(app PRIVATE "${join(root, "platforms/esp-idf/pocket_runtime/include")}" "${join(root, "contracts/generated")}")
include("${join(root, "platforms/esp-idf/pocket_runtime/project_include.cmake")}")
pocketjs_embed_package(TARGET app NAME offline PACKAGE "${pkg}" PROFILE_EXPORT_DIR "${exported}")
`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    for (const args of [["cmake", "-S", path, "-B", join(path, "build"), "-G", "Ninja"], ["cmake", "--build", join(path, "build")]]) {
      const result = Bun.spawnSync(args, { env, stdout: "pipe", stderr: "pipe" });
      expect(result.success, result.stdout.toString() + result.stderr.toString()).toBe(true);
    }
    expect(existsSync(invoked)).toBe(false);
    expect(readFileSync(join(path, "build/pocketjs/offline/pocketjs_package_offline.c"), "utf8")).toContain("pocketjs_package_offline_contract");
  }, 60_000);
});
