import { describe, expect, test } from "bun:test";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STABLE_RUST_TOOLCHAIN } from "../tools/build/toolchains/rust.ts";
import { FEATURE_CONTRACTS, checkFeatureTree } from "./fixtures/cargo-features/contracts.ts";

const root = resolve(import.meta.dir, "..");
const toml = (path: string) => Bun.TOML.parse(readFileSync(join(root, path), "utf8")) as any;
const workspace = toml("Cargo.toml").workspace;

describe("Cargo program and library graph", () => {

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

  test("published features resolve consistently for an independent consumer", () => {
    const output = join(root, ".pocket-build/validation/cargo-features", `${Date.now()}-${process.pid}`);
    mkdirSync(output, { recursive: true });
    let index = 0;
    const command = (args: string[], cwd = root) => {
      const child = Bun.spawnSync(["cargo", `+${STABLE_RUST_TOOLCHAIN}`, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const stdout = child.stdout.toString(), stderr = child.stderr.toString();
      writeFileSync(join(output, `${++index}.log`), "$ cargo " + args.join(" ") + "\n" + stdout + stderr);
      expect(child.success, `cargo ${args.join(" ")} (exit=${child.exitCode}, signal=${child.signalCode})\n${stderr}`).toBe(true);
      return stdout;
    };
    const metadata = JSON.parse(command(["metadata", "--locked", "--offline", "--no-deps", "--format-version=1"])) as {
      packages: { name: string; publish: string[] | null; manifest_path: string; features: Record<string, string[]> }[];
    };
    const packages = metadata.packages.filter(pkg => pkg.publish?.length !== 0).sort((a, b) => a.name.localeCompare(b.name));
    const treeOptions = ["tree", "--locked", "--offline", "-e", "features,no-dev", "--prefix", "none", "--format", "{p}|{f}"];
    const selectors = packages.flatMap(pkg => ["-p", pkg.name]);
    const active = (tree: string) => [...new Set(tree.split("\n").flatMap(line => {
      const match = /^(\S+) v[^|]+\|([^ ]*)/.exec(line);
      return match && match[1]! in FEATURE_CONTRACTS
        ? match[2]!.split(",").filter(Boolean).map(feature => `${match[1]}/${feature}`) : [];
    }))].sort();
    const consumer = mkdtempSync(join(tmpdir(), "pocket-feature-consumer-"));
    try {
      mkdirSync(join(consumer, "src"));
      writeFileSync(join(consumer, "src/lib.rs"), "// Dependency-graph consumer; device SDK compilation is a separate gate.\n");
      for (const mode of ["minimal", "default", "all"] as const) {
        const options = mode === "minimal" ? ["--no-default-features"] : mode === "all" ? ["--all-features"] : [];
        // Fetch locked dependencies on a cold CI host; subsequent independent
        // resolution can stay offline after Cargo has populated its cache.
        const source = command([...treeOptions.filter(arg => arg !== "--offline"), ...selectors, ...options]);
        expect(() => checkFeatureTree(source), mode).not.toThrow();
        const dependencies = packages.map(pkg => {
          const features = mode === "all" ? Object.keys(FEATURE_CONTRACTS[pkg.name]!) : [];
          return `${pkg.name} = { path = ${JSON.stringify(resolve(pkg.manifest_path, ".."))}, default-features = ${mode === "default"}, features = ${JSON.stringify(features)} }`;
        }).join("\n");
        writeFileSync(join(consumer, "Cargo.toml"), `[package]\nname="feature-consumer"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\n${dependencies}\n`);
        command(["generate-lockfile", "--offline"], consumer);
        const independent = command(treeOptions, consumer);
        expect(() => checkFeatureTree(independent), mode).not.toThrow();
        expect(active(independent), mode).toEqual(active(source));
      }
      // SDK defaults disable legacy. Even passing old adapter parameters alone
      // must not add a graphics backend to the canonical C interface.
      for (const parameters of [[], ["--features", "gles1,software-only"]]) {
        const sdk = command([...treeOptions, "-p", "pocket-runtime-cabi", "--no-default-features", ...parameters]);
        expect(sdk).not.toMatch(/^pocket-gles[12]? (?:v|feature)/m);
        expect(() => checkFeatureTree(sdk)).not.toThrow();
      }
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  }, 180_000);

  test("the feature gate rejects selectors and undocumented resolved activation", () => {
    expect(() => checkFeatureTree('pocketjs-core feature "psp"')).toThrow("undocumented public feature");
    expect(() => checkFeatureTree('pocket-runtime v0.1.0 (/external/runtime)|profile-handheld')).toThrow("undocumented public feature");
    expect(() => checkFeatureTree('pocket-runtime-cabi feature "gles1"')).not.toThrow();
  });
});
