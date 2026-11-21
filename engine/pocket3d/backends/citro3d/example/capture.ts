// Optional local Azahar verification. Build with CAPTURE=1 first.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { encodePNG } from "../../../../../tests/png.ts";
const root = resolve(import.meta.dir, "../../../../..");
const out = `${root}/dist/pocket3d-citro3d`;
const fixture = mkdtempSync(`${out}/azahar-`);
const source = `${homedir()}/Library/Application Support/Azahar`;
const user = `${fixture}/Library/Application Support/Azahar`;
mkdirSync(`${user}/config`, { recursive: true });
for (const dir of ["nand", "sysdata"]) if (existsSync(`${source}/${dir}`)) cpSync(`${source}/${dir}`, `${user}/${dir}`, { recursive: true });
let config = readFileSync(`${source}/config/qt-config.ini`, "utf8");
for (const [key, value] of Object.entries({ graphics_api: "0", resolution_factor: "1", frame_limit: "1000", use_vsync: "false", check_for_update_on_start: "false" })) {
  config = config.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
    .replace(new RegExp(`^${key}\\\\default=.*$`, "m"), `${key}\\default=false`);
}
writeFileSync(`${user}/config/qt-config.ini`, config);
const rom = `${fixture}/rigid-skin.3dsx`;
cpSync(`${out}/rigid-skin.3dsx`, rom);
const app = process.env.AZAHAR ?? "/Applications/Azahar.app";
const launch = Bun.spawnSync(["open", "-n", "-a", app, "--env", `HOME=${fixture}`, "--stdout", `${fixture}/console.log`, "--stderr", `${fixture}/console.log`, "--args", rom]);
if (launch.exitCode) throw new Error(launch.stderr.toString());
const owned = () => Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n")
  .filter(line => line.includes(`${app}/Contents/MacOS/azahar`) && line.includes(rom)).map(line => Number(line.trim().split(/\s+/)[0]));
try {
  const capture = `${user}/sdmc/p3d-rigid`;
  const start = Date.now();
  while (!existsSync(`${capture}/done`)) {
    if (Date.now() - start > 120000 || (Date.now() - start > 10000 && !owned().length)) throw new Error(`Capture incomplete: ${fixture}`);
    await Bun.sleep(500);
  }
  const frames = [];
  for (const frame of [1, 31, 61]) {
    const bytes = readFileSync(`${capture}/frame-${frame}.bgr`);
    if (bytes.length !== 400 * 240 * 3) throw new Error("Truncated GPU readback");
    const rgba = new Uint8Array(400 * 240 * 4);
    let pixels = 0, red = 0;
    for (let y = 0; y < 240; y++) for (let x = 0; x < 400; x++) {
      const src = (x * 240 + 239 - y) * 3, dst = (y * 400 + x) * 4;
      rgba.set([bytes[src + 2], bytes[src + 1], bytes[src], 255], dst);
      if (x < 145 && (bytes[src] !== bytes[0] || bytes[src + 1] !== bytes[1] || bytes[src + 2] !== bytes[2])) {
        pixels++; red = Math.max(red, bytes[src + 2]);
      }
    }
    if (pixels < 300) throw new Error(`Prop missing in frame ${frame}`);
    writeFileSync(`${fixture}/frame-${frame}.png`, encodePNG(rgba, 400, 240));
    frames.push({ frame, leftPropPixels: pixels, red });
  }
  if (!(frames[0].red > 200 && frames[0].red < 240 && frames[1].red === 255 && frames[2].red === 0)) throw new Error(`Light uniforms or zero-light transfer failed: ${JSON.stringify(frames)}`);
  writeFileSync(`${fixture}/receipt.json`, JSON.stringify({ environment: "Azahar software PICA", hardwareTiming: false, assertions: readFileSync(`${capture}/done`, "utf8").trim(), frames }, null, 2));
  console.log(`PASS: independent rigs, resident sharing, visibility, directional/unlit/black lighting: ${fixture}`);
} finally {
  for (const pid of owned()) { try { process.kill(pid, "SIGKILL"); } catch {} }
}
