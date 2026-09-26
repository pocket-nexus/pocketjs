// River Valley driver: cook the scene, render CPU reference stills, and build
// the PS Vita VPK.
//
//   bun run valley preview                  # stills into .pocket-build/validation
//   bun run valley preview --frames 0,30,60 --size 960x544
//   bun run valley build                    # dist/vita/valley-vita.vpk
//   bun run valley install --mount /Volumes/PSV
//
// The scene is cooked by `valley-vita`'s build script as well, so `build` is
// self-contained; `preview` exists to judge the look without a device, using
// the same culling, surfaces and blend model the Vita backend runs.

import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENGINE = `${ROOT}/engine`;
const APP = `${ENGINE}/pocket3d/examples/valley-vita`;
const TARGET = "armv7-sony-vita-newlibeabihf";

const argv = Bun.argv.slice(2);
const command = argv[0] ?? "preview";
function value(flag: string, fallback: string): string {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}
const release = !argv.includes("--debug");

function toolchain(): Record<string, string> {
  const home = process.env.HOME ?? "";
  const sdk = process.env.VITASDK || `${home}/vitasdk`;
  if (!existsSync(sdk)) {
    console.error(`valley: VitaSDK not found at ${sdk} (set VITASDK)`);
    process.exit(2);
  }
  return {
    ...process.env,
    VITASDK: sdk,
    PATH: `${sdk}/bin:${home}/.cargo/bin:${process.env.PATH ?? ""}`,
  } as Record<string, string>;
}

if (command === "preview") {
  const out = value("--out", `${ROOT}/.pocket-build/validation/valley/preview`);
  const frames = value("--frames", "0");
  const size = value("--size", "960x544");
  mkdirSync(out, { recursive: true });
  await $`cargo run --release -p pocket3d-valley --bin valley-cook -- \
      --out ${out}/valley.p3sn --preview ${out} --frames ${frames} --size ${size}`
    .cwd(ENGINE);
  console.log(`valley: stills in ${out}`);
} else if (command === "cook") {
  const out = value("--out", `${ROOT}/dist/valley/valley.p3sn`);
  mkdirSync(dirname(out), { recursive: true });
  await $`cargo run --release -p pocket3d-valley --bin valley-cook -- --out ${out}`.cwd(ENGINE);
} else if (command === "build") {
  const environment = toolchain();
  const rustup = Bun.which("rustup") ?? `${process.env.HOME}/.cargo/bin/rustup`;
  console.log("valley: cargo vita build vpk");
  await $`${rustup} run nightly-2026-05-28 cargo vita build vpk -- ${release ? "--release" : ""}`
    .cwd(APP)
    .env(environment);
  const profile = release ? "release" : "debug";
  const source = `${APP}/target/${TARGET}/${profile}/valley-vita.vpk`;
  const destination = `${ROOT}/dist/vita/valley-vita.vpk`;
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  const bytes = Bun.file(destination).size;
  console.log(`valley: ${destination} (${(bytes / (1024 * 1024)).toFixed(2)} MB)`);
} else if (command === "install") {
  const mount = value("--mount", "");
  if (!mount || !existsSync(`${mount}/VitaShell`)) {
    console.error("valley: --mount must identify the VitaShell USB volume");
    process.exit(2);
  }
  const source = `${ROOT}/dist/vita/valley-vita.vpk`;
  if (!existsSync(source)) {
    console.error("valley: run `bun run valley build` first");
    process.exit(2);
  }
  const destination = `${mount}/data/pocketjs-dev/valley-vita.vpk`;
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  console.log(
    `valley: staged ${destination}\nEject USB storage, install this VPK in VitaShell, then open its bubble.`,
  );
} else {
  console.log(
    "Usage: bun run valley [preview|cook|build|install]\n" +
      "  preview [--frames a,b,c] [--size WxH] [--out DIR]\n" +
      "  cook    [--out FILE]\n" +
      "  build   [--debug]\n" +
      "  install --mount /Volumes/PSV",
  );
}
