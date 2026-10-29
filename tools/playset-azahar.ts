// bun tools/playset-azahar.ts <app> [--frames 120,300] [--tape "0:0x0,60:0x2000"] [--out dir]
//
// Pictures of a playset game in Azahar: builds a capture .3dsx of
// apps/<app> with the input tape baked in, boots it against a throwaway
// emulator home, and writes each requested frame as one PNG with the top
// screen over the touch screen. For looking at a port, not for goldens:
// tests/e2e/azahar.ts owns byte-exact comparisons.
//
// The tape is "frame:mask" pairs (contracts/spec/spec.ts BTN), each held until
// the next; the circle pad stays centred, so steer with the d-pad bits.

import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { encodePNG } from "../tests/png.ts";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const app = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!app) {
  console.error("usage: bun tools/playset-azahar.ts <app under apps/> [--frames 120,300] [--tape 0:0x0] [--out dir]");
  process.exit(2);
}
const frames = (flag("--frames") ?? "240").split(",").map(Number).sort((a, b) => a - b);
const tape = flag("--tape") ?? "0:0x0";
const name = app.replaceAll("/", "-");
const out = resolve(flag("--out") ?? join(ROOT, ".pocket-build/validation/playset", name));
const work = join(ROOT, ".pocket-build/azahar-playset", name);
const home = join(work, "home");
const userDir = join(home, "Library/Application Support/Azahar");
const captures = join(userDir, "sdmc/pocketjs-captures");
const azahar = process.env.AZAHAR || "/Applications/Azahar.app";
const binary = `${azahar}/Contents/MacOS/azahar`;
const sourceConfig = `${homedir()}/Library/Application Support/Azahar/config/qt-config.ini`;

const manifest = JSON.parse(readFileSync(join(ROOT, "apps", app, "pocket.json"), "utf8"));
const start = frames[0];
const count = frames[frames.length - 1] - start + 1;
if (count > 120) {
  console.error("frames must fall within 120 consecutive frames (every frame in the window is dumped)");
  process.exit(2);
}
const build = await $`bun tools/3ds.ts ${app} --capture`
  .cwd(ROOT)
  .env({ ...process.env, POCKETJS_CAPTURE_INPUT: tape, POCKETJS_CAPTURE_TOUCH: "", POCKETJS_CAP_START: String(start), POCKETJS_CAP_N: String(count) })
  .quiet()
  .nothrow();
if (build.exitCode !== 0) {
  console.error(`${build.stdout}${build.stderr}`);
  process.exit(1);
}
const rom = join(ROOT, "dist/3ds", `${manifest.app.output}.3dsx`);

rmSync(work, { recursive: true, force: true });
mkdirSync(join(userDir, "config"), { recursive: true });
mkdirSync(captures, { recursive: true });
const sourceUser = sourceConfig.replace(/\/config\/[^/]+$/, "");
for (const d of ["nand", "sysdata"]) if (existsSync(join(sourceUser, d))) cpSync(join(sourceUser, d), join(userDir, d), { recursive: true });
let config = readFileSync(sourceConfig, "utf8");
const set = (key: string, value: string) => {
  config = config.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
  config = new RegExp(`^${key}\\\\default=.*$`, "m").test(config)
    ? config.replace(new RegExp(`^${key}\\\\default=.*$`, "m"), `${key}\\default=false`)
    : config.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}\n${key}\\default=false`);
};
set("graphics_api", process.env.E2E_AZAHAR_GRAPHICS_API ?? "0");
set("resolution_factor", "1");
set("use_vsync", "false");
set("frame_limit", "1000");
set("use_disk_shader_cache", "false");
set("check_for_update_on_start", "false");
writeFileSync(join(userDir, "config/qt-config.ini"), config);

// only this run's emulator: its command line names this checkout's .3dsx
const kill = () => Bun.spawnSync(["pkill", "-9", "-f", rom], { stdout: "ignore", stderr: "ignore" });
kill();
const log = join(work, "console.log");
Bun.spawnSync(["open", "-n", "-a", azahar, "--env", `HOME=${home}`, "--stdout", log, "--stderr", log, "--args", rom]);
const began = Date.now();
let ok = false;
while (Date.now() - began < Number(process.env.E2E_AZAHAR_TIMEOUT_MS ?? 240_000)) {
  if (existsSync(join(captures, "error.txt"))) {
    console.error(readFileSync(join(captures, "error.txt"), "utf8"));
    break;
  }
  if (existsSync(join(captures, "done"))) {
    ok = true;
    break;
  }
  await Bun.sleep(200);
}
if (!ok) {
  // a graceful quit flushes Azahar's own log (CPU faults, guest debug output)
  // a graceful quit of this run's instance (SIGTERM is ignored; SIGINT is not)
  Bun.spawnSync(["pkill", "-INT", "-f", rom], { stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(3000);
  kill();
  const emulatorLog = join(userDir, "log/azahar_log.txt");
  if (existsSync(emulatorLog)) {
    const lines = readFileSync(emulatorLog, "utf8").split("\n").filter((l) => /Error|Critical|Warning|Debug|abort|fault|Unmapped|svc/i.test(l));
    console.error(lines.slice(-40).join("\n"));
  }
  console.error(`no capture (see ${log} and ${emulatorLog})`);
  process.exit(1);
}
kill();

function decode(raw: Uint8Array, width: number, height: number, into: Uint8Array, rowOffset: number, stride: number) {
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const s = (x * height + (height - 1 - y)) * 4;
      const d = ((y + rowOffset) * stride + x) * 4;
      into[d] = raw[s + 3];
      into[d + 1] = raw[s + 2];
      into[d + 2] = raw[s + 1];
      into[d + 3] = 255;
    }
  }
}

mkdirSync(out, { recursive: true });
for (const f of frames) {
  const id = String(f).padStart(4, "0");
  const topPath = join(captures, `f${id}.raw`);
  const auxPath = join(captures, `aux-f${id}.raw`);
  if (!existsSync(topPath)) {
    console.error(`frame ${f}: no capture file`);
    continue;
  }
  const rgba = new Uint8Array(400 * 480 * 4);
  decode(readFileSync(topPath), 400, 240, rgba, 0, 400);
  if (existsSync(auxPath)) {
    const half = new Uint8Array(320 * 240 * 4);
    decode(readFileSync(auxPath), 320, 240, half, 0, 320);
    for (let y = 0; y < 240; y++) rgba.set(half.subarray(y * 320 * 4, (y + 1) * 320 * 4), ((y + 240) * 400 + 40) * 4);
  }
  const file = join(out, `${name}-f${f}.png`);
  writeFileSync(file, encodePNG(rgba, 400, 480));
  console.log(file);
}
