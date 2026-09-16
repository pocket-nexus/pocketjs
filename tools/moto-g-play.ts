/** Exact-device operations for the arm64 Clear development host. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dir, "..");
const args = Bun.argv.slice(2), command = args.find(a => !a.startsWith("--")) ?? "doctor";
const id = args.find(a => a.startsWith("--id="))?.slice(5) ?? process.env.POCKETJS_MOTO_G_PLAY_SERIAL;
const packageId = "dev.pocket_stack.clear", activity = `${packageId}/dev.pocketstack.android.PocketActivity`;
const output = resolve(root, "dist/moto-g-play");
function adb(args: string[]) {
  const result = Bun.spawnSync(["adb", "-s", id!, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout;
}
if (["setup", "doctor", "build", "build-demo", "build-app"].includes(command)) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "android.ts"), "--profile=moto-g-play", command],
    { cwd: root, stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
}
if (!id || !/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Use --id=<adb serial> to select the Moto G Play");
if (adb(["shell", "getprop", "ro.product.device"]).toString().trim() !== "fogona") throw new Error("Expected Moto G Play 2024 (fogona)");
mkdirSync(output, { recursive: true });
switch (command) {
  case "deploy": {
    const apk = resolve(output, "pocket-clear.apk");
    const hash = createHash("sha256").update(readFileSync(apk)).digest("hex");
    console.log(adb(["install", "-r", apk]).toString().trim());
    const installed = adb(["shell", "pm", "path", packageId]).toString().trim().replace(/^package:/, "");
    if (!/^\/data\/app\/[A-Za-z0-9_./=+~-]+\.apk$/.test(installed)) throw new Error("Unexpected installed APK path");
    const readback = adb(["shell", "sha256sum", installed]).toString().split(/\s/)[0];
    if (readback !== hash) throw new Error("Installed APK hash differs from build");
    writeFileSync(resolve(output, "device-install.json"), JSON.stringify({ device: id, packageId, apkSha256: hash, readback: true }, null, 2));
    console.log(`Installed APK SHA-256 verified: ${hash}`);
    break;
  }
  case "launch":
    console.log(adb(["shell", "am", "start", "-n", activity]).toString().trim());
    break;
  case "status":
    console.log(adb(["shell", "run-as", packageId, "cat", "files/runtime.txt"]).toString().trim());
    break;
  case "capture":
    writeFileSync(resolve(output, "device-frame.png"), adb(["exec-out", "screencap", "-p"]));
    console.log(resolve(output, "device-frame.png"));
    break;
  default: throw new Error("Usage: bun moto-g-play <setup|doctor|build|deploy|launch|status|capture> [--id=<adb serial>]");
}
