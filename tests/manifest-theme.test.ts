import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeStyleTable } from "../contracts/spec/spec.ts";
import { KEY_STYLES, unpack } from "../framework/compiler/pak.ts";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import { validatePocketManifest } from "../framework/src/manifest/validate.ts";

const baseline = JSON.parse(readFileSync(resolve("tests/fixtures/manifests/portable-psp.json"), "utf8"));
const theme = {
  keyframes: { glide: { from: { translateX: 0 }, to: { translateX: 12 } } },
  animation: { glide: { value: "glide 2s linear both", loop: "3s" } },
};
const application = { ...baseline, app: { ...baseline.app, entry: "main.tsx", theme } };

test("manifest theme enters the resolved plan, its hash, and native build inputs", () => {
  const result = validateAndResolveBuildPlan(application, { target: "psp" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.plan.app.theme).toEqual(theme);
  expect(extractHostBuildInputs(result.plan).app.theme).toEqual(theme);
  expect(verifyPlanHash(result.plan)).toBe(true);
  expect(verifyPlanHash({ ...result.plan, app: { ...result.plan.app, theme: {} } })).toBe(false);
  for (const invalid of [
    { keyframes: { glide: { from: { opacity: true } } } },
    { animation: { glide: { loop: 2 } } },
    { animation: { glide: { value: "glide 2s", platform: "psp" } } },
  ]) {
    expect(validatePocketManifest({ ...application, app: { ...application.app, theme: invalid } }).ok).toBe(false);
  }
});

test("the compiler bakes the frozen plan theme after the source manifest changes", () => {
  const directory = resolve(".pocket-build/validation/manifest-theme", String(process.pid));
  mkdirSync(directory, { recursive: true });
  const result = validateAndResolveBuildPlan(application, { target: "psp" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  writeFileSync(resolve(directory, "plan.json"), JSON.stringify(result.plan));
  writeFileSync(resolve(directory, "pocket.json"), JSON.stringify({ ...application, app: { ...application.app, theme: {} } }));
  writeFileSync(resolve(directory, "main.tsx"), [
    'import { mount } from "@pocketjs/framework/solid";',
    'import { View } from "@pocketjs/framework/solid/components";',
    'mount(() => <View class="animate-glide" />);',
  ].join("\n"));
  const run = Bun.spawnSync([
    process.execPath, resolve("tools/build.ts"), `--plan=${directory}/plan.json`, `--project-root=${directory}`, `--outdir=${directory}/out`,
    "--strict-classes",
  ], { stdout: "pipe", stderr: "pipe" });
  expect(run.success, run.stderr.toString()).toBe(true);
  const styles = unpack(readFileSync(resolve(directory, "out", result.plan.app.output + ".pak")))
    .find(item => item.key === KEY_STYLES)!;
  const decoded = decodeStyleTable(styles.data);
  expect(decoded.anims).toHaveLength(1);
  expect(decoded.anims[0].periodFrames).toBe(120);
  expect(decoded.styles.some(record => record.animation?.loopFrames === 180)).toBe(true);
});
