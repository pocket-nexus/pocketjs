#!/usr/bin/env bun

// Pocket Companion's screen on the M5Stack CardputerZero
// (programs/cardputer-zero, apps/companion-zero):
//
//   bun tools/cardputer-zero.ts build             -> .pocket-build/cardputer-zero/
//   bun tools/cardputer-zero.ts install <host>    build, then install over SSH (root@<address>)
//   bun tools/cardputer-zero.ts shot --control <control.json> --script "<tick>:<event> ..." [--out <dir>]
//
// build    the profile, the package, the program for aarch64 Linux against
//          glibc 2.36 (the Zero's Debian 13 has 2.41; needs cargo-zigbuild and
//          zig), and the launcher icon (tools/companion/icon.ts).
// install  /usr/bin/pocket-cardputer-zero, /usr/share/pocketjs/companion.pocket,
//          APPLaunch's entry and icon, and a sudoers rule that lets the gpio
//          group start the program as root: the companion's control.json is
//          root's. APPLaunch restarts to list the entry.
// shot     the program built for this computer, without the panel and the
//          keyboard: each `shot` event of the script becomes <out>/<tick>.png
//          (programs/cardputer-zero/src/shot.rs), 2x.

import { $ } from "bun";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { drawIcon } from "./companion/icon.ts";
import { encodePNG } from "./png.ts";

const root = resolve(import.meta.dir, "..");
const out = join(root, ".pocket-build", "cardputer-zero");
const config = "programs/cardputer-zero/pocket.runtime-config.ts";
const profileRs = join(out, "profile", "pocket_profile.rs");
const pocket = join(out, "companion.pocket");
const TARGET = "aarch64-unknown-linux-gnu";
const program = join(out, "cargo", TARGET, "release", "pocket-cardputer-zero");
const [WIDTH, HEIGHT] = [320, 170];

const DESKTOP = `[Desktop Entry]
Type=Application
Name=Companion
Comment=Consoles, applets and their services
Exec=/usr/bin/sudo -n -- /usr/bin/pocket-cardputer-zero
Icon=share/images/pocket-companion.png
Terminal=false
StartupNotify=false
`;
const SUDOERS = `%gpio ALL=(root) NOPASSWD: /usr/bin/pocket-cardputer-zero ""\n`;

const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

async function compile(): Promise<void> {
  await $`bun tools/pocket.ts profile export --config ${config} --out ${join(out, "profile")}`.cwd(root);
  await $`bun tools/pocket.ts compile --manifest apps/companion-zero/pocket.json --project-root . --runtime-config ${config} --plan-dir ${join(out, "plan")} --output ${pocket}`.cwd(root);
}

async function build(): Promise<void> {
  await compile();
  await $`cargo zigbuild --release -p pocket-cardputer-zero --target ${TARGET}.2.36 --target-dir ${join(out, "cargo")}`
    .cwd(root)
    .env({ ...process.env, POCKETJS_PROFILE_RS: profileRs });
  writeFileSync(join(out, "pocket-companion.png"), drawIcon(100, { tile: false }));
  writeFileSync(join(out, "pocket-companion.desktop"), DESKTOP);
  writeFileSync(join(out, "pocket-companion.sudoers"), SUDOERS);
  console.log(`cardputer-zero: ${program}\ncardputer-zero: ${pocket}`);
}

async function install(host: string): Promise<void> {
  await build();
  const images = "/usr/share/APPLaunch/share/images";
  const entries = "/usr/share/APPLaunch/applications";
  await $`ssh ${host} mkdir -p /usr/share/pocketjs`;
  await $`scp -q ${program} ${host}:/usr/bin/pocket-cardputer-zero.new`;
  await $`scp -q ${pocket} ${host}:/usr/share/pocketjs/companion.pocket`;
  await $`scp -q ${join(out, "pocket-companion.png")} ${host}:${images}/pocket-companion.png`;
  await $`scp -q ${join(out, "pocket-companion.desktop")} ${host}:${entries}/pocket-companion.desktop`;
  await $`scp -q ${join(out, "pocket-companion.sudoers")} ${host}:/tmp/pocket-companion.sudoers`;
  await $`ssh ${host} ${[
    "set -e",
    "mv /usr/bin/pocket-cardputer-zero.new /usr/bin/pocket-cardputer-zero",
    "chmod 755 /usr/bin/pocket-cardputer-zero",
    "visudo -cf /tmp/pocket-companion.sudoers",
    "install -m 440 /tmp/pocket-companion.sudoers /etc/sudoers.d/pocket-companion",
    "rm /tmp/pocket-companion.sudoers",
    "/usr/bin/pocket-cardputer-zero --check",
    "systemctl --user -M pi@ restart APPLaunch.service",
  ].join(" && ")}`;
}

async function shot(): Promise<void> {
  const control = option("--control");
  const script = option("--script");
  if (!control || !script) throw new Error("shot needs --control <control.json> and --script");
  const dir = resolve(option("--out") ?? join(out, "shots"));
  await compile();
  await $`cargo build -p pocket-cardputer-zero --target-dir ${join(out, "host")}`.cwd(root).env({ ...process.env, POCKETJS_PROFILE_RS: profileRs });
  mkdirSync(dir, { recursive: true });
  await $`${join(out, "host", "debug", "pocket-cardputer-zero")} --package ${pocket} --control ${resolve(control)} --shot ${dir} --script ${script}`;
  for (const name of readdirSync(dir).filter(name => name.endsWith(".rgb565"))) {
    const raw = readFileSync(join(dir, name));
    const rgba = new Uint8Array(WIDTH * 2 * HEIGHT * 2 * 4);
    for (let y = 0; y < HEIGHT * 2; y++) {
      for (let x = 0; x < WIDTH * 2; x++) {
        const at = ((y >> 1) * WIDTH + (x >> 1)) * 2;
        const v = raw[at]! | (raw[at + 1]! << 8);
        const o = (y * WIDTH * 2 + x) * 4;
        rgba[o] = (((v >> 11) & 31) * 255) / 31;
        rgba[o + 1] = (((v >> 5) & 63) * 255) / 63;
        rgba[o + 2] = ((v & 31) * 255) / 31;
        rgba[o + 3] = 255;
      }
    }
    writeFileSync(join(dir, name.replace(/\.rgb565$/, ".png")), encodePNG(rgba, WIDTH * 2, HEIGHT * 2));
  }
  console.log(`cardputer-zero: frames in ${dir}`);
}

switch (argv[0]) {
  case "build":
    await build();
    break;
  case "install":
    if (!argv[1]) throw new Error("install needs an SSH host, e.g. root@192.168.8.159");
    await install(argv[1]);
    break;
  case "shot":
    await shot();
    break;
  default:
    console.error("usage: bun tools/cardputer-zero.ts build | install <host> | shot --control <file> --script <events> [--out <dir>]");
    process.exit(2);
}
