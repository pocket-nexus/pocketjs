#!/usr/bin/env bun
/** Builds MicroTS apps as Rockbox plugins inside a Rockbox checkout. */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const usage = `bun hosts/rockbox/build.ts --rockbox=<checkout> [--target=ipodvideo] [--sim] [--app=<name>:<dir>] [--perf-hud] [--outdir=<directory>]
Adds apps/plugins/pocketjs to the Rockbox checkout and builds pocketjs_<name>.rock from apps/<dir> (default ipod:ipod-video-demo).
Firmware builds write <outdir>/rockbox.zip (default dist/rockbox); --sim installs into the checkout's simulator build.
Requires rustup toolchain install nightly-2026-07-01 --component rust-src and the Rockbox toolchain (tools/rockboxdev.sh).`;

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(usage);
  process.exit(0);
}
const unknown = args.find(arg => !/^--(rockbox|target|app|outdir)=|^--(sim|perf-hud)$/.test(arg));
if (unknown) throw new Error(`Unknown argument ${unknown}; use --help`);
const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const rockbox = resolve(option("rockbox") ?? "");
if (!option("rockbox") || !existsSync(resolve(rockbox, "tools/configure"))) throw new Error("--rockbox must name a Rockbox checkout; use --help");
const target = option("target") ?? "ipodvideo";
const sim = args.includes("--sim");
const out = resolve(option("outdir") ?? resolve(root, "dist/rockbox"));
const apps = args.filter(arg => arg.startsWith("--app=")).map(arg => arg.slice(6));
if (apps.length === 0) apps.push("ipod:ipod-video-demo");
for (const app of apps) {
  const [name, dir] = app.split(":");
  if (!name || !/^\w+$/.test(name) || !dir || !existsSync(resolve(root, "apps", dir, "app.tsx"))) throw new Error(`Invalid --app=${app}`);
}

function run(cmd: string[], cwd: string) {
  console.log(`$ ${cmd.join(" ")}`);
  if (Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exitCode !== 0) throw new Error(`${cmd[0]} failed`);
}

function ensureLine(file: string, line: string, block = line) {
  const text = readFileSync(file, "utf8");
  if (!text.split("\n").includes(line)) writeFileSync(file, `${text.replace(/\n*$/, "\n")}${block}\n`);
}

const plugins = resolve(rockbox, "apps/plugins");
mkdirSync(resolve(plugins, "pocketjs"), { recursive: true });
for (const file of readdirSync(resolve(import.meta.dir, "plugin"))) {
  copyFileSync(resolve(import.meta.dir, "plugin", file), resolve(plugins, "pocketjs", file));
}
ensureLine(resolve(plugins, "SUBDIRS"), "pocketjs", "\n#if defined(HAVE_LCD_COLOR) && (LCD_DEPTH == 16)\npocketjs\n#endif");
for (const app of apps) ensureLine(resolve(plugins, "CATEGORIES"), `pocketjs_${app.split(":")[0]},apps`);

const build = resolve(rockbox, `build-pocketjs-${target}${sim ? "-sim" : ""}`);
mkdirSync(build, { recursive: true });
if (!existsSync(resolve(build, "Makefile"))) run(["../tools/configure", `--target=${target}`, `--type=${sim ? "s" : "n"}`], build);
const makeVars = [`POCKETJS_DIR=${root}`, `PJS_APPS=${apps.join(" ")}`, ...(args.includes("--perf-hud") ? ["PJS_PERF_HUD=1"] : [])];
run(["make", `-j${availableParallelism()}`, ...makeVars], build);

const data = resolve(build, "apps/plugins/pocketjs/data");
if (sim) {
  run(["make", "install"], build);
  cpSync(data, resolve(build, "simdisk/.rockbox/rocks.data/pocketjs"), { recursive: true });
  console.log(`Run ${resolve(build, "rockboxui")}`);
} else {
  run(["make", "zip", ...makeVars], build);
  const staging = resolve(build, "pocketjs-data");
  rmSync(staging, { recursive: true, force: true });
  cpSync(data, resolve(staging, ".rockbox/rocks.data/pocketjs"), { recursive: true });
  run(["zip", "-qr", resolve(build, "rockbox.zip"), ".rockbox"], staging);
  mkdirSync(out, { recursive: true });
  copyFileSync(resolve(build, "rockbox.zip"), resolve(out, "rockbox.zip"));
  console.log(`Wrote ${resolve(out, "rockbox.zip")}`);
}
for (const app of apps) {
  const rock = `apps/plugins/pocketjs/pocketjs_${app.split(":")[0]}.rock`;
  console.log(`${rock}: ${statSync(resolve(build, rock)).size} bytes`);
}
