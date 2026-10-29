#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path";
import { POCKET_PROFILES } from "../profiles/index.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { STABLE_RUST_TOOLCHAIN } from "./build/toolchains/rust.ts";
import { exportProfile } from "./profile-export.ts";
const profile = POCKET_PROFILES["vita"];
const root = resolve(import.meta.dir, "..");
const validation = join(root, ".pocket-build/validation/vita-runtime");
// The fixture embeds the profile module the Vita program embeds, plus
// ui.physics so a plan can enable the feature-gated physics namespace.
const fixtureProfile = { ...profile, capabilities: [...profile.capabilities, "ui.physics"] };
const exported = exportProfile({ profile: fixtureProfile, profileHash: hashPocketProfile(fixtureProfile), hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, join(validation, "profile"));
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
const result = Bun.spawnSync(["cargo", `+${STABLE_RUST_TOOLCHAIN}`, "test", "--locked", "--offline", "--manifest-path", join(root, fixture), "--", "--test-threads=1"], { cwd: root, env: { ...process.env, POCKETJS_PROFILE_RS: exported.module, POCKET_QJS_SOURCE: join(dirname(dependency.manifest_path), "embed/quickjs"), CARGO_TARGET_DIR: join(validation, "target") }, stdout: "inherit", stderr: "inherit" });
process.exit(result.success ? 0 : result.exitCode || 1);
