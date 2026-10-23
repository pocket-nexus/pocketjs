import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import type { PocketProfile } from "../contracts/spec/profile.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import profile from "../programs/linux-kms/profile.ts";
import { exportProfile } from "./profile-export.ts";
import { profileRegistry } from "./profile-resolver.ts";
import { makeVariant } from "./pocket-pack.ts";
const root = resolve(import.meta.dir, "..");
/** Export the program's profile and write packages compiled against it, plus
 * one compiled for another profile under the same id. Returns the exported
 * Rust module the program build names in POCKETJS_PROFILE_RS. */
export function linuxFixture(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const { module } = exportProfile({ profile, profileHash: hashPocketProfile(profile), hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, directory);
  const manifest = { $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id: "test.linux.runtime", name: "linux-check", title: "Linux Runtime Check", version: "1.0.0",
    engine: { capabilities: { requires: ["input.buttons"] } }, app: { entry: "test.ts", output: "linux-check", framework: "solid", viewport: { fixed: { logical: [800, 600], presentation: "native" } } } };
  const plan = (selected: PocketProfile) => {
    const result = validateAndResolveBuildPlan(manifest, { target: selected.id }, profileRegistry(selected));
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    return result.plan;
  };
  const make = (js: string, selected: PocketProfile = profile) => encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [makeVariant({ target: profile.id, hostAbi: POCKET_BINDING_GENERATION,
    planJson: JSON.stringify(plan(selected)), identity: { id: manifest.id, title: manifest.title, output: manifest.app.output }, js: new TextEncoder().encode(js), pak: new Uint8Array() })] });
  const app = `const node=ui.createNode(0);ui.insertBefore(0,node,0);ui.setProp(node,1,120);ui.setProp(node,2,80);globalThis.frame=()=>{ui.setProp(node,64,0xff204060);};`;
  writeFileSync(resolve(directory, "app.pocket"), make(app));
  writeFileSync(resolve(directory, "guest-error.pocket"), make("globalThis.frame=()=>{throw new Error('intentional guest failure')};"));
  writeFileSync(resolve(directory, "wrong-profile.pocket"), make(app, { ...profile, tickHz: profile.tickHz / 2 }));
  return module;
}
export function runLinuxPlatformsTests(directory: string) {
  directory = resolve(directory);
  const profileModule = linuxFixture(directory);
  const commands: { command: string[]; success: boolean; signal: unknown }[] = [];
  const run = (command: string[], expected = true) => {
    const result = Bun.spawnSync(command, { cwd: root, env: { ...process.env, CARGO_TARGET_DIR: resolve(directory, "target"), POCKETJS_PROFILE_RS: profileModule }, stdout: "pipe", stderr: "pipe" });
    const output = result.stdout.toString() + result.stderr.toString();
    writeFileSync(resolve(directory, `command-${commands.length}.log`), output);
    commands.push({ command, success: result.success, signal: result.signalCode });
    if (result.signalCode || result.success !== expected) throw new Error(`unexpected subprocess result: ${command.join(" ")}\n${output}`);
    return output;
  };
  const cargo = ["cargo", ...(process.env.POCKET_LINUX_CARGO_TOOLCHAIN ? ["+" + process.env.POCKET_LINUX_CARGO_TOOLCHAIN] : [])];
  const binary = process.env.POCKET_LINUX_TEST_BINARY ?? resolve(directory, "target/debug/pocket-linux-kms");
  if (!process.env.POCKET_LINUX_TEST_BINARY) {
    run([...cargo, "test", "--locked", ...["hooks", "drm", "fbdev", "evdev", "alsa", "kms"].flatMap(name => ["-p", "pocket-linux-" + name])]);
    run([...cargo, "build", "--locked", "-p", "pocket-linux-kms", ...(process.platform === "linux" ? ["--features", "alsa"] : [])]);
  }
  const shared = [binary, "--package", resolve(directory, "app.pocket")];
  if (!run([...shared, "--check"]).includes("package admitted")) throw new Error("admission did not run");
  if (!run([...shared, "--headless", "--frames", "3"]).includes("completed 3 logical ticks")) throw new Error("guest did not tick");
  run([binary, "--headless", "--frames", "1", "--package", resolve(directory, "guest-error.pocket")], false);
  run([binary, "--check", "--package", resolve(directory, "wrong-profile.pocket")], false);
  if (process.platform === "linux") {
    run([binary, "--pcm-test", "null"]);
    const layout = resolve(directory, "kernel-layout");
    run(["cc", "-Wall", "-Werror", resolve(root, "tests/fixtures/linux-platforms/kernel-layout.c"), "-o", layout]);
    run([layout]);
  }
  const receipt = { revision: run(["git", "rev-parse", "HEAD"]).trim(), platform: process.platform, architecture: process.arch, commands, limits: ["No physical DRM, framebuffer, evdev or audio hardware tested", "ALSA null plugin validates API calls without audible output"] };
  writeFileSync(resolve(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}
if (import.meta.main) runLinuxPlatformsTests(Bun.argv[2] ?? resolve(root, ".pocket-build/validation/linux-build/test"));
