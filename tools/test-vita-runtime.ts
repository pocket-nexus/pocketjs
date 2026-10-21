#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path";
import profile from "../profiles/vita.ts";
import { canonicalProfileJson, hashPocketProfile } from "../framework/src/profile.ts";
const root = resolve(import.meta.dir, "..");
const metadata = Bun.spawnSync(["cargo", "+stable", "metadata", "--locked", "--format-version=1", "--manifest-path", join(root, "programs/vita/Cargo.toml")], { cwd: root, stdout: "pipe", stderr: "pipe" });
if (!metadata.success) throw new Error(metadata.stderr.toString());
const packages = JSON.parse(metadata.stdout.toString()).packages as {name:string;manifest_path:string;source:string|null;dependencies:{name:string;source:string|null}[]}[];
const source = packages.find(p => p.name === "pocketjs-vita")?.dependencies.find(p => p.name === "libquickjs-sys")?.source;
const dependency = source ? packages.find(p => p.name === "libquickjs-sys" && p.source?.startsWith(`${source}#`)) : undefined;
if (!dependency) throw new Error("Vita's pinned QuickJS dependency is absent");
const result = Bun.spawnSync(["cargo", "+stable", "test", "--locked", "--manifest-path", join(root, "tests/fixtures/vita-runtime/Cargo.toml"), "--", "--test-threads=1"], { cwd: root, env: { ...process.env, POCKETJS_PROFILE_JSON: canonicalProfileJson(profile), POCKETJS_PROFILE_HASH: hashPocketProfile(profile), POCKET_QJS_SOURCE: join(dirname(dependency.manifest_path), "embed/quickjs"), CARGO_TARGET_DIR: join(root, ".pocket-build/validation/vita-runtime/target") }, stdout: "inherit", stderr: "inherit" });
process.exit(result.success ? 0 : result.exitCode || 1);
