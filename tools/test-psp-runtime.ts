#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { exportProfile } from "./profile-export.ts";
const profile = POCKET_PROFILES["psp"];
const root = resolve(import.meta.dir, "..");
const validation = join(root, ".pocket-build/validation/psp-runtime");
// The fixture embeds the profile module the PSP program embeds, plus
// ui.physics so a plan can enable the feature-gated physics namespace.
const fixtureProfile = { ...profile, capabilities: [...profile.capabilities, "ui.physics"] };
const exported = exportProfile({ profile: fixtureProfile, profileHash: hashPocketProfile(fixtureProfile), hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, join(validation, "profile"));
const metadata = Bun.spawnSync(["cargo", "+stable", "metadata", "--locked", "--format-version=1", "--manifest-path", join(root, "programs/psp/Cargo.toml")], { cwd: root, stdout: "pipe", stderr: "pipe" });
if (!metadata.success) throw new Error(metadata.stderr.toString());
const packages = JSON.parse(metadata.stdout.toString()).packages as {name:string;manifest_path:string;source:string|null;dependencies:{name:string;source:string|null}[]}[];
const source = packages.find(p => p.name === "pocketjs-psp")?.dependencies.find(p => p.name === "libquickjs-sys")?.source;
const dependency = source ? packages.find(p => p.name === "libquickjs-sys" && p.source?.startsWith(`${source}#`)) : undefined;
if (!dependency) throw new Error("PSP's pinned QuickJS source is absent");
const result = Bun.spawnSync(["cargo", "+stable", "test", "--locked", "--manifest-path", join(root, "tests/fixtures/psp-runtime/Cargo.toml"), "--", "--test-threads=1"], { cwd: root, env: { ...process.env, POCKETJS_PROFILE_RS: exported.module, POCKET_QJS_SOURCE: join(dirname(dependency.manifest_path), "embed/quickjs"), CARGO_TARGET_DIR: join(validation, "host-target") }, stdout: "inherit", stderr: "inherit" });
process.exit(result.success ? 0 : result.exitCode || 1);
