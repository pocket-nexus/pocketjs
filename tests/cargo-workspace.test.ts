import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILD_STD_NIGHTLY, STABLE_RUST_TOOLCHAIN } from "../tools/build/toolchains/rust.ts";

const root = resolve(import.meta.dir, "..");
const toml = (path: string) => Bun.TOML.parse(readFileSync(join(root, path), "utf8")) as any;
const workspace = toml("Cargo.toml").workspace;

describe("Cargo program and library graph", () => {
  test("all members share versioned internal dependencies and one lock", () => {
    expect(workspace.resolver).toBe("2");
    expect(existsSync(join(root, "Cargo.lock"))).toBe(true);
    const paths = new Set<string>(workspace.members);
    for (const path of paths) {
      const manifest = toml(`${path}/Cargo.toml`);
      expect(manifest.workspace, path).toBeUndefined();
      expect(manifest.package.version, path).toEqual({ workspace: true });
      expect(manifest.package.repository, path).toEqual({ workspace: true });
      expect(manifest.package.description?.length, path).toBeGreaterThan(0);
      expect(existsSync(join(root, path, "Cargo.lock")), path).toBe(false);
      const dependency = workspace.dependencies[manifest.package.name];
      expect(dependency.path, path).toBe(path);
      expect(dependency.version, path).toBe(workspace.package.version);
      // no_std consumers must be able to opt out of a dependency's defaults.
      expect(dependency["default-features"], path).toBe(false);
    }
    expect(workspace["default-members"].every((path: string) => paths.has(path))).toBe(true);
    for (const path of ["programs/psp", "programs/vita", "products/3ds/core", "programs/gba", "programs/esp-idf/archive", "programs/linux-kms"]) {
      expect(paths.has(path), path).toBe(true);
      expect(workspace["default-members"], path).not.toContain(path);
      expect(toml(`${path}/Cargo.toml`).package.publish, path).toBe(false);
    }
  });

  test("stable is fixed and build-std uses only the explicit shared nightly", () => {
    expect(toml("rust-toolchain.toml").toolchain.channel).toBe(STABLE_RUST_TOOLCHAIN);
    expect(STABLE_RUST_TOOLCHAIN).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUILD_STD_NIGHTLY).toMatch(/^nightly-\d{4}-\d{2}-\d{2}$/);
    for (const path of workspace.members) expect(existsSync(join(root, path, "rust-toolchain.toml")), path).toBe(false);
  });

  test("platform drivers do not depend on a program or the UI core", () => {
    for (const path of workspace.members.filter((path: string) => path.startsWith("platforms/"))) {
      const manifest = toml(`${path}/Cargo.toml`);
      const groups = [manifest.dependencies, manifest["build-dependencies"],
        ...Object.values(manifest.target ?? {}).flatMap((target: any) => [target.dependencies, target["build-dependencies"]])];
      for (const dependencies of groups) {
        for (const [name, value] of Object.entries(dependencies ?? {})) {
          const dependency = value as any;
          const effective = dependency.workspace ? workspace.dependencies[name] : dependency;
          const packageName = dependency.package ?? name;
          expect(packageName, `${path} -> ${name}`).not.toBe("pocketjs-core");
          if (effective?.path) {
            const source = resolve(root, dependency.workspace ? "." : path, effective.path);
            expect(source.startsWith(join(root, "programs") + "/"), `${path} -> ${source}`).toBe(false);
          }
        }
      }
    }
  });

  test("published crate fixtures match their cross-language canonical inputs", () => {
    const pairs = [
      ["tests/fixtures/packages/synthetic.pocket", "engine/package/tests/fixtures/synthetic.pocket"],
      ["tests/fixtures/packages/synthetic.pocket", "engine/runtime-cabi/tests/fixtures/synthetic.pocket"],
      ["tests/fixtures/repack-ipod/landscape-physics.pocket", "engine/runtime-cabi/tests/fixtures/landscape-physics.pocket"],
      ["tests/fixtures/youtube-golden.pkst", "engine/core/tests/fixtures/youtube-golden.pkst"],
      ["tests/fixtures/youtube-golden.pkst", "engine/modules/media/tests/fixtures/youtube-golden.pkst"],
      ["tests/fixtures/packages/corpus/bad-v1.pocket", "engine/runtime/tests/fixtures/bad-v1.pocket"],
      ["assets/fonts/Inter-Regular.ttf", "engine/crates/pocket-text/tests/fixtures/Inter-Regular.ttf"],
      ["assets/fonts/LICENSE.txt", "engine/crates/pocket-text/tests/fixtures/LICENSE-Inter.txt"],
    ];
    const source = "tests/fixtures/packages/corpus", copy = "engine/package/tests/fixtures/corpus";
    expect(readdirSync(join(root, copy)).sort()).toEqual(readdirSync(join(root, source)).sort());
    for (const name of readdirSync(join(root, source))) pairs.push([`${source}/${name}`, `${copy}/${name}`]);
    for (const [source, copy] of pairs) expect(readFileSync(join(root, copy!)).equals(readFileSync(join(root, source!))), copy).toBe(true);
  });
});
