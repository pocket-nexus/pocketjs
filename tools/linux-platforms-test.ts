import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { hashPocketProfile } from "../framework/src/profile.ts";
import profile from "../programs/linux-kms/profile.ts";
import { exportProfile } from "./profile-export.ts";
import { profileRegistry } from "./profile-resolver.ts";
import { makeVariant } from "./pocket-pack.ts";
const root = resolve(import.meta.dir, "..");
export function linuxFixture(directory: string) {
  mkdirSync(directory, { recursive: true });
  exportProfile({ profile, profileHash: hashPocketProfile(profile), hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, directory);
  const manifest = { $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id: "test.linux.runtime", name: "linux-check", title: "Linux Runtime Check", version: "1.0.0",
    engine: { capabilities: { requires: ["input.buttons"] } }, app: { entry: "test.ts", output: "linux-check", framework: "solid", viewport: { fixed: { logical: [800, 600], presentation: "native" } } } };
  const result = validateAndResolveBuildPlan(manifest, { target: profile.id }, profileRegistry(profile));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const make = (js: string) => encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [makeVariant({ target: profile.id, hostAbi: POCKET_BINDING_GENERATION,
    planJson: JSON.stringify(result.plan), identity: { id: manifest.id, title: manifest.title, output: manifest.app.output }, js: new TextEncoder().encode(js), pak: new Uint8Array() })] });
  writeFileSync(resolve(directory, "app.pocket"), make(`const node=ui.createNode(0);ui.insertBefore(0,node,0);ui.setProp(node,1,120);ui.setProp(node,2,80);globalThis.frame=()=>{ui.setProp(node,64,0xff204060);};`));
  writeFileSync(resolve(directory, "guest-error.pocket"), make("globalThis.frame=()=>{throw new Error('intentional guest failure')};"));
  const sidecar = JSON.parse(readFileSync(resolve(directory, "pocket-profile.json"), "utf8"));
  const unsupported = JSON.parse(JSON.stringify(sidecar));
  unsupported.profile.capabilities.push("io.offload");
  const projection = JSON.parse(unsupported.canonicalProfileJson); projection.capabilities.push("io.offload");
  unsupported.canonicalProfileJson = JSON.stringify(projection);
  unsupported.profileHash = "sha256:" + createHash("sha256").update(unsupported.canonicalProfileJson).digest("hex");
  writeFileSync(resolve(directory, "unsupported-profile.json"), JSON.stringify(unsupported));
  sidecar.profileHash = "sha256:" + "00".repeat(32);
  writeFileSync(resolve(directory, "wrong-profile.json"), JSON.stringify(sidecar));
}
export function runLinuxPlatformsTests(directory: string) {
  directory = resolve(directory); linuxFixture(directory);
  const commands: { command: string[]; success: boolean; signal: unknown }[] = [];
  const run = (command: string[], expected = true) => {
    const result = Bun.spawnSync(command, { cwd: root, env: { ...process.env, CARGO_TARGET_DIR: resolve(directory, "target") }, stdout: "pipe", stderr: "pipe" });
    const output = result.stdout.toString() + result.stderr.toString();
    writeFileSync(resolve(directory, `command-${commands.length}.log`), output);
    commands.push({ command, success: result.success, signal: result.signalCode });
    if (result.signalCode || result.success !== expected) throw new Error(`unexpected subprocess result: ${command.join(" ")}\n${output}`);
    return output;
  };
  const cargo = ["cargo", ...(process.env.POCKET_LINUX_CARGO_TOOLCHAIN ? ["+" + process.env.POCKET_LINUX_CARGO_TOOLCHAIN] : [])];
  const binary = process.env.POCKET_LINUX_TEST_BINARY ?? resolve(directory, "target/debug/pocket-linux-kms");
  if (!process.env.POCKET_LINUX_TEST_BINARY) {
    run([...cargo, "test", "--locked", ...["hooks", "drm", "fbdev", "evdev", "alsa"].flatMap(name => ["-p", "pocket-linux-" + name])]);
    run([...cargo, "build", "--locked", "-p", "pocket-linux-kms", ...(process.platform === "linux" ? ["--features", "alsa"] : [])]);
  }
  const shared = [binary, "--package", resolve(directory, "app.pocket"), "--profile", resolve(directory, "pocket-profile.json")];
  if (!run([...shared, "--check"]).includes("package admitted")) throw new Error("admission did not run");
  if (!run([...shared, "--headless", "--frames", "3"]).includes("completed 3 logical ticks")) throw new Error("guest did not tick");
  run([binary, "--headless", "--frames", "1", "--package", resolve(directory, "guest-error.pocket"), "--profile", resolve(directory, "pocket-profile.json")], false);
  run([binary, "--check", "--package", resolve(directory, "app.pocket"), "--profile", resolve(directory, "wrong-profile.json")], false);
  const unsupported = run([binary, "--check", "--package", resolve(directory, "app.pocket"), "--profile", resolve(directory, "unsupported-profile.json")], false);
  if (!unsupported.includes("capabilities absent")) throw new Error("unsupported product services were not rejected before package admission");
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
