#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path";
import profile from "../profiles/vita.ts";
import { canonicalProfileJson, hashPocketProfile } from "../framework/src/profile.ts";
import { STABLE_RUST_TOOLCHAIN } from "./build/toolchains/rust.ts";
const root = resolve(import.meta.dir, "..");
type Package = {name:string;manifest_path:string;source:string|null;dependencies:{name:string;source:string|null}[]};
function metadata(manifest: string, noDeps = false): Package[] {
  const result = Bun.spawnSync(["cargo", `+${STABLE_RUST_TOOLCHAIN}`, "metadata", "--locked", "--format-version=1", "--manifest-path", join(root, manifest), ...(noDeps ? ["--no-deps"] : [])], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString()).packages;
}
// Read the production pin without fetching every platform in the workspace;
// resolve only the independent fixture's dependencies before compiling it.
const production = metadata("programs/vita/Cargo.toml", true);
const source = production.find(p => p.name === "pocketjs-vita")?.dependencies.find(p => p.name === "libquickjs-sys")?.source;
if (!source) throw new Error("Vita's pinned QuickJS dependency is absent");
const fixture = "tests/fixtures/vita-runtime/Cargo.toml";
const packages = metadata(fixture);
const dependency = packages.find(p => p.name === "libquickjs-sys" && p.source?.startsWith(`${source}#`));
if (!dependency) throw new Error("Vita's pinned QuickJS dependency is absent");
const result = Bun.spawnSync(["cargo", `+${STABLE_RUST_TOOLCHAIN}`, "test", "--locked", "--offline", "--manifest-path", join(root, fixture), "--", "--test-threads=1"], { cwd: root, env: { ...process.env, POCKETJS_PROFILE_JSON: canonicalProfileJson(profile), POCKETJS_PROFILE_HASH: hashPocketProfile(profile), POCKET_QJS_SOURCE: join(dirname(dependency.manifest_path), "embed/quickjs"), CARGO_TARGET_DIR: join(root, ".pocket-build/validation/vita-runtime/target") }, stdout: "inherit", stderr: "inherit" });
process.exit(result.success ? 0 : result.exitCode || 1);
