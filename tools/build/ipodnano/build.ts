#!/usr/bin/env bun
/** Experimental MicroTS Hero Rockbox plugin for the iPod nano 2G; no JavaScript VM. */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { RUST_TOOLCHAINS, STABLE_RUST_TOOLCHAIN } from "../toolchains/rust.ts";
import type { RuntimeBuildContext } from "../../../framework/src/host-config.ts";
import { exportAotProfile } from "../aot-profile.ts";

const root = resolve(import.meta.dir, "../../..");
export const IPODNANO_TOOLCHAIN = RUST_TOOLCHAINS.ipodNano;
export const IPODNANO_TARGET = "armv4t-none-eabi";
const VIEWPORT: [number, number] = [176, 132];

const USAGE = `bun tools/build/ipodnano/build.ts --aot-dir=<sources> --rockbox=<rockbox-source> [--outdir=<directory>] [--compiler-prefix=<prefix>] [--install=<ipod-volume>]

The native program links both pockethero.rock and pockethero.ovl.
Requires rustup toolchain install ${IPODNANO_TOOLCHAIN} --component rust-src`;

async function run(command: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const child = Bun.spawn(command, { cwd: options.cwd ?? root, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...options.env } });
  if (await child.exited !== 0 || child.signalCode) throw new Error(`${command.join(" ")} failed`);
}

function option(name: string, args: readonly string[]): string | undefined {
  const prefix = `--${name}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

function compilerPrefix(args: readonly string[]): string {
  const chosen = option("compiler-prefix", args);
  if (chosen) return chosen;
  // Rockbox recommends arm-elf-eabi-gcc 9.5.0; arm-none-eabi-gcc builds plugins too.
  return Bun.which("arm-elf-eabi-gcc") ? "arm-elf-eabi-" : "arm-none-eabi-";
}

export async function buildIpodNano(args: readonly string[], context?: RuntimeBuildContext) {
  if (args.includes("--help")) {
    console.log(USAGE);
    return;
  }
  if (context && args.some(arg => arg.startsWith("--install="))) throw new Error("program builds do not install devices; copy the completed .rock/.ovl after building");
  const execute = context ? (command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) => context.run(command, options) : run;
  const known = ["--aot-dir=", "--outdir=", "--rockbox=", "--compiler-prefix=", "--install="];
  if (args.some(arg => !known.some(prefix => arg.startsWith(prefix)))) throw new Error(`Unknown argument\n${USAGE}`);
  const out = context?.outdir ?? resolve(option("outdir", args) ?? resolve(root, "dist/ipodnano"));
  const gen = resolve(out, "generated");
  mkdirSync(gen, { recursive: true });
  const input = context?.aot?.directory ?? option("aot-dir", args);
  if (!input) throw new Error("iPod nano native build requires --aot-dir from pocket compile --aot");
  const dependency = JSON.parse(readFileSync(resolve(input, "dependencies.json"), "utf8"));
  cpSync(resolve(input), gen, { recursive: true });
  const rockboxSource = option("rockbox", args);
  if (!rockboxSource) throw new Error("iPod nano program build requires --rockbox=<source> to link .rock/.ovl");
  // The preview and the plugin link the same crate and boot the same profile.
  const env = { IPODNANO_GENERATED: gen, POCKETJS_PROFILE_RS: exportAotProfile(dependency, gen, context) };

  // The preview runs the same crate on the host with the layout oracle and
  // writes the frames a scripted session produces.
  const previewDir = resolve(out, "preview");
  mkdirSync(previewDir, { recursive: true });
  const previewCommand = ["cargo", `+${STABLE_RUST_TOOLCHAIN}`, "run", "--locked", "--release", "--manifest-path", resolve(root, "programs/ipodnano/preview/Cargo.toml"), "--target-dir", resolve(out, "preview-target"), "--", previewDir];
  await execute(previewCommand, { env });

  const libCommand = ["cargo", `+${IPODNANO_TOOLCHAIN}`, "build", "--locked", "--release", "--lib", "--target", IPODNANO_TARGET, "-Z", "build-std=core,alloc", "-Z", "build-std-features=compiler-builtins-mem", "--manifest-path", resolve(root, "programs/ipodnano/Cargo.toml"), "--target-dir", resolve(out, "target")];
  await execute(libCommand, { env: { ...env, CARGO_PROFILE_RELEASE_LTO: "true", CARGO_PROFILE_RELEASE_PANIC: "abort" } });
  const lib = resolve(out, `target/${IPODNANO_TARGET}/release/libpocketjs_ipodnano.a`);

  const source = resolve(rockboxSource);
  if (!existsSync(resolve(source, "tools/configure"))) throw new Error(`${source} is not a Rockbox source tree`);
  // The plugin directory is copied into the source tree, where configure's
  // --plugins selection looks for it.
  cpSync(resolve(root, "programs/ipodnano/rockbox/pockethero"), resolve(source, "apps/plugins/pockethero"), { recursive: true });
  copyFileSync(resolve(root, "platforms/rockbox/display/pocket_rockbox_display.h"), resolve(source, "apps/plugins/pockethero/pocket_rockbox_display.h"));
  const rockboxBuild = resolve(out, "rockbox-build");
  mkdirSync(rockboxBuild, { recursive: true });
  const prefix = compilerPrefix(args);
  const configure = [resolve(source, "tools/configure"), "--target=ipodnano2g", "--type=N", "--plugins=pockethero", `--compiler-prefix=${prefix}`];
  if (!existsSync(resolve(rockboxBuild, "Makefile"))) {
    await execute(configure, { cwd: rockboxBuild });
  }
  await execute(["make", "rocks"], { cwd: rockboxBuild, env: { POCKETHERO_LIB: lib } });
  const pluginDir = resolve(rockboxBuild, "apps/plugins/pockethero");
  // pockethero.rock is the launcher; pockethero.ovl holds the app and loads
  // at the top of the audio buffer.
  const files = { rock: "pockethero.rock", overlay: "pockethero.ovl" } as const;
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const outputs = Object.fromEntries(Object.entries(files).map(([kind, name]) => {
    const bytes = readFileSync(resolve(pluginDir, name));
    writeFileSync(resolve(out, name), bytes);
    return [kind, { file: name, bytes: bytes.length, sha256: sha(bytes) }];
  }));
  const sections = Bun.spawnSync([`${prefix}size`, "-A", resolve(pluginDir, "pockethero.elf")], { stdout: "pipe" }).stdout.toString();
  const rockboxVersion = Bun.spawnSync(["git", "-C", source, "rev-parse", "--short=10", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
  writeFileSync(resolve(out, "build.json"), JSON.stringify({
    target: IPODNANO_TARGET, toolchain: IPODNANO_TOOLCHAIN, rockbox: rockboxVersion, compilerPrefix: prefix,
    previewCommand, libCommand, configure, app: dependency.plan.app.id, nominalTickHz: dependency.plan.profile.tickHz,
    viewport: VIEWPORT, planHash: dependency.planHash, profileHash: dependency.profileHash, outputs,
  }, null, 2) + "\n");
  for (const line of sections.split("\n").filter(line => /^\.(text|rodata|data|bss)\b/.test(line))) console.log(`pockethero.ovl ${line.trim().split(/\s+/).slice(0, 2).join(" ")} bytes`);
  for (const output of Object.values(outputs)) console.log(`${output.file}: ${output.bytes} bytes (Rockbox ${rockboxVersion})`);
  const install = option("install", args);
  if (install) {
    const info = resolve(install, ".rockbox/rockbox-info.txt");
    if (!existsSync(info)) throw new Error(`${install} has no .rockbox/rockbox-info.txt`);
    // Rockbox rejects plugins built for another plugin API version.
    if (!readFileSync(info, "utf8").includes(`Version: ${rockboxVersion}`)) throw new Error(`${install} runs a different Rockbox build than ${rockboxVersion}; plugins must match the firmware`);
    for (const name of Object.values(files)) copyFileSync(resolve(out, name), resolve(install, ".rockbox/rocks/apps", name));
    console.log(`installed ${Object.values(files).join(", ")} in ${resolve(install, ".rockbox/rocks/apps")}`);
  }
}
if (import.meta.main) await buildIpodNano(Bun.argv.slice(2));
