#!/usr/bin/env bun

// The Anbernic RG DS Plus program (programs/rg-ds-plus):
//
//   bun tools/rg-ds-plus.ts libs <host>                      copy libmali.so.1 from the device for the linker
//   bun tools/rg-ds-plus.ts build                            the program for aarch64 Linux (glibc 2.36)
//   bun tools/rg-ds-plus.ts shot --package <app.pocket> --script "<tick>:<event> ..." [--out <dir>]
//
// libs   scp's /usr/lib/libmali.so.1.9.0 (stock firmware) or /usr/lib/mali/libmali.so.1.9.0
//        (Omarchy Pocket) into .pocket-build/rg-ds-plus/gl-libs as libmali.so.
// build  exports the profile and cross-compiles with cargo-zigbuild against those libraries.
// shot   the program built for this computer with the CPU raster renderer: each
//        `shot` event of the script becomes <out>/<tick>.png, the top panel over the bottom one.

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodePNG } from "./png.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, ".pocket-build", "rg-ds-plus");
const config = "programs/rg-ds-plus/pocket.runtime-config.ts";
const profileRs = join(out, "profile", "pocket_profile.rs");
const libs = join(out, "gl-libs");
const TARGET = "aarch64-unknown-linux-gnu";
const [W, H] = [1024, 768];

const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

async function profile(): Promise<void> {
  await $`bun tools/pocket.ts profile export --config ${config} --out ${join(out, "profile")}`.cwd(root);
}

async function pullLibs(host: string): Promise<void> {
  mkdirSync(libs, { recursive: true });
  const path = (await $`ssh ${host} 'ls /usr/lib/mali/libmali.so.1.9.0 /usr/lib/libmali.so.1.9.0 2>/dev/null | head -1'`.text()).trim();
  if (!path) throw new Error(`${host} has no libmali.so.1.9.0`);
  await $`scp -q ${host}:${path} ${join(libs, "libmali.so.1.9.0")}`;
  for (const name of ["libmali.so.1", "libmali.so"]) {
    const link = join(libs, name);
    if (existsSync(link)) unlinkSync(link);
    symlinkSync("libmali.so.1.9.0", link);
  }
  console.log(`rg-ds-plus: ${path} -> ${libs}`);
}

async function build(): Promise<void> {
  if (!existsSync(join(libs, "libmali.so"))) throw new Error(`no ${join(libs, "libmali.so")}; run: bun tools/rg-ds-plus.ts libs <host>`);
  await profile();
  await $`cargo zigbuild --release -p pocket-rg-ds-plus --target ${TARGET}.2.36 --target-dir ${join(out, "cargo")}`
    .cwd(root)
    .env({ ...process.env, POCKETJS_PROFILE_RS: profileRs, POCKETJS_RG_DS_PLUS_GL_LIBS: libs });
  console.log(`rg-ds-plus: ${join(out, "cargo", TARGET, "release", "pocket-rg-ds-plus")}`);
}

async function shot(): Promise<void> {
  const script = option("--script");
  const pocket = option("--package");
  if (!script || !pocket) throw new Error("shot needs --package and --script");
  const dir = resolve(option("--out") ?? join(out, "shots"));
  await profile();
  await $`cargo build -p pocket-rg-ds-plus --target-dir ${join(out, "host")}`.cwd(root).env({ ...process.env, POCKETJS_PROFILE_RS: profileRs });
  mkdirSync(dir, { recursive: true });
  await $`${join(out, "host", "debug", "pocket-rg-ds-plus")} --package ${resolve(pocket)} --shot ${dir} --script ${script}`;
  for (const name of readdirSync(dir).filter((n) => n.endsWith("-top.xrgb"))) {
    const tick = name.slice(0, -"-top.xrgb".length);
    const rgba = new Uint8Array(W * H * 2 * 4);
    [`${tick}-top.xrgb`, `${tick}-bottom.xrgb`].forEach((file, panel) => {
      const raw = readFileSync(join(dir, file));
      for (let i = 0; i < W * H; i++) {
        const o = (panel * W * H + i) * 4;
        rgba[o] = raw[i * 4 + 2]!;
        rgba[o + 1] = raw[i * 4 + 1]!;
        rgba[o + 2] = raw[i * 4]!;
        rgba[o + 3] = 255;
      }
    });
    writeFileSync(join(dir, `${tick}.png`), encodePNG(rgba, W, H * 2));
  }
  console.log(`rg-ds-plus: frames in ${dir}`);
}

switch (argv[0]) {
  case "libs":
    if (!argv[1]) throw new Error("libs needs an SSH host, e.g. root@23.23.23.28");
    await pullLibs(argv[1]);
    break;
  case "build":
    await build();
    break;
  case "shot":
    await shot();
    break;
  default:
    console.error("usage: bun tools/rg-ds-plus.ts libs <host> | build | shot --package <app.pocket> --script <events> [--out <dir>]");
    process.exit(2);
}
