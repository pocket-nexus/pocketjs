import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import { buildGuestBundleFromPlan, renderTemplate } from "../tools/native-host-build.ts";
import { resolveMotoGPlayBuildPlan } from "../tools/moto-g-play-profile.ts";
import { REDMI_1S_TARGET, resolveRedmi1sBuildPlan } from "../tools/redmi-1s-profile.ts";

const clear = () => JSON.parse(readFileSync("apps/clear/pocket.redmi-1s.json", "utf8"));

test("Clear resolves the Redmi 1S panel: 360x640 logical at density 2", () => {
  const plan = resolveRedmi1sBuildPlan(clear());
  const inputs = extractHostBuildInputs(plan, { expectedTarget: REDMI_1S_TARGET });
  expect(inputs.viewport).toEqual({ logical: [360, 640], physical: [720, 1280], rasterDensity: 2, presentation: "native" });
  expect(inputs.hostAbi).toBe(9);
  const taller = clear();
  taller.app.viewport.fixed.logical = [360, 800];
  expect(() => resolveRedmi1sBuildPlan(taller)).toThrow();
});

test("the Redmi 1S has no game keys: an app that requires input.buttons does not resolve", () => {
  const manifest = clear();
  manifest.engine.capabilities.requires = ["input.touch", "input.buttons"];
  expect(() => resolveRedmi1sBuildPlan(manifest)).toThrow(/input\.buttons/);
});

test("a plan resolved for another target is refused before the compiler runs", () => {
  const moto = resolveMotoGPlayBuildPlan(JSON.parse(readFileSync("apps/clear/pocket.android.json", "utf8")));
  const directory = `${process.env.TMPDIR ?? "/tmp"}/pocketjs-redmi-1s-test-${process.pid}`;
  const planPath = `${directory}/plan.json`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(planPath, JSON.stringify(moto));
  expect(() => buildGuestBundleFromPlan({
    label: "test", repository: process.cwd(), target: REDMI_1S_TARGET,
    planPath, projectRoot: process.cwd(), outputDirectory: `${directory}/guest`,
  })).toThrow(/expected target redmi-1s-dev, got moto-g-play-dev/);
  rmSync(directory, { recursive: true, force: true });
});

test("each Android profile's toolchain file names its SDK levels and its ABIs", () => {
  const read = (profile: string) => JSON.parse(readFileSync(`tools/cli/${profile}-toolchain.json`, "utf8")).android;
  const redmi = read("redmi-1s");
  expect(redmi.minSdkVersion).toBe(18);
  expect(redmi.abis.map((abi: { abi: string; clangTarget: string }) => [abi.abi, abi.clangTarget])).toEqual([
    ["armeabi-v7a", "armv7a-linux-androideabi18"],
    ["arm64-v8a", "aarch64-linux-android21"],
  ]);
  const moto = read("moto-g-play");
  expect(moto.minSdkVersion).toBe(23);
  expect(moto.abis.map((abi: { abi: string; clangTarget: string }) => [abi.abi, abi.clangTarget])).toEqual([
    ["arm64-v8a", "aarch64-linux-android23"],
  ]);
  for (const android of [redmi, moto]) expect(android.targetSdkVersion).toBeGreaterThanOrEqual(24);
});

test("the Android manifest takes its SDK levels and its debuggable flag from the build", () => {
  const rendered = renderTemplate(readFileSync("hosts/android/app/AndroidManifest.xml", "utf8"), {
    PACKAGE: "dev.pocket_nexus.clear", VERSION_CODE: 1000, VERSION_NAME: "0.1.0",
    MIN_SDK: 18, TARGET_SDK: 34, DEBUGGABLE: "false",
  });
  expect(rendered).toContain('android:minSdkVersion="18" android:targetSdkVersion="34"');
  expect(rendered).toContain('android:debuggable="false"');
  expect(rendered).not.toContain("@POCKET_");
});

test("the Android CLI refuses a plan outside build-app and an output that is not an .apk", () => {
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "tools/android.ts", "--profile=redmi-1s", ...args], { stdout: "pipe", stderr: "pipe" });
  const plan = run("doctor", "--plan=plan.json");
  expect(plan.exitCode).not.toBe(0);
  expect(plan.stderr.toString()).toContain("--plan goes with build-app");
  const out = run("build-app", "--plan=plan.json", "--out=clear.zip");
  expect(out.exitCode).not.toBe(0);
  expect(out.stderr.toString()).toContain("--out names an .apk file");
});
