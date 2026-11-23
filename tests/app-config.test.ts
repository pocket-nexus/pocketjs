// The app section of a host config as a build input: the theme module it
// imports, the plan it resolves to, and the package `pocket compile` writes.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateAppConfig } from "../contracts/spec/app-config.ts";
import { BUNDLE_SECTION, decodeBundle, decodeIdentity, findSection } from "../contracts/spec/bundle.ts";
import { decodeStyleTable } from "../contracts/spec/spec.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { extractHostBuildInputs } from "../framework/compiler/host-build-inputs.ts";
import { KEY_STYLES, unpack } from "../framework/compiler/pak.ts";
import { readAppIcon } from "../tools/compile-app.ts";
import { loadHostConfig } from "../tools/profile-resolver.ts";
import { encodePng } from "../tools/repack/shared/png.ts";
import { PORTABLE_APP, ROOT } from "./app-fixtures.ts";

const theme = {
  keyframes: { glide: { from: { translateX: 0 }, to: { translateX: 12 } } },
  animation: { glide: { value: "glide 2s linear both", loop: "3s" } },
};
const application = { ...PORTABLE_APP, entry: "main.tsx", theme };
const scratch = (name: string) => {
  const directory = resolve(ROOT, ".pocket-build/validation/app-config", `${name}-${process.pid}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return directory;
};
const config = (body: string, imports = "") =>
  `import { defineHostConfig } from "@pocketjs/framework/host-config";\n${imports}\nexport default defineHostConfig(${body});\n`;
const MAIN = [
  'import { mount } from "@pocketjs/framework/solid";',
  'import { View } from "@pocketjs/framework/solid/components";',
  'mount(() => <View class="animate-glide" />);',
].join("\n");

test("the app theme enters the resolved plan and native build inputs", () => {
  const result = resolveAppPlan(application, { target: "psp" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(result.plan.app.theme).toEqual(theme);
  expect(extractHostBuildInputs(result.plan).app.theme).toEqual(theme);
  for (const [invalid, path] of [
    [{ keyframes: { glide: { from: { opacity: true } } } }, "/app/theme/keyframes/glide/from/opacity"],
    [{ animation: { glide: { loop: 2 } } }, "/app/theme/animation/glide"],
    [{ animation: { glide: { value: "glide 2s", platform: "psp" } } }, "/app/theme/animation/glide"],
  ] as const) {
    expect(validateAppConfig({ ...application, theme: invalid }).map(item => item.path)).toEqual([path]);
  }
});

test("a config imports its theme module; the plan carries the content", async () => {
  const directory = scratch("module");
  mkdirSync(resolve(directory, "motion"), { recursive: true });
  writeFileSync(resolve(directory, "motion/ease.ts"), 'export const LINEAR = "linear";\nexport const LOOP = "3s";\n');
  writeFileSync(resolve(directory, "theme.ts"), [
    'import { LINEAR, LOOP } from "./motion/ease.ts";',
    "const stops = (property: string, values: number[]) => Object.fromEntries(values.map((value, index) => [index === 0 ? \"from\" : \"to\", { [property]: value }]));",
    "export default { keyframes: { glide: stops(\"translateX\", [0, 12]) }, animation: { glide: { value: `glide 2s ${LINEAR} both`, loop: LOOP } } };",
  ].join("\n"));
  const { theme: _theme, ...app } = application;
  writeFileSync(resolve(directory, "pocket.host.config.ts"), config(`{ host: "psp", app: { ...${JSON.stringify(app)}, theme } }`, 'import theme from "./theme.ts";'));
  const loaded = await loadHostConfig(resolve(directory, "pocket.host.config.ts"));
  expect(loaded.value.app?.theme).toEqual(theme);
  // The theme module and the modules it imports are inputs of the config.
  expect(loaded.dependencies).toEqual(expect.arrayContaining([resolve(directory, "theme.ts"), resolve(directory, "motion/ease.ts")]));
  const inline = resolveAppPlan(application, { target: "psp" });
  const fromModule = resolveAppPlan(loaded.value.app, { target: "psp" });
  if (!inline.ok || !fromModule.ok) throw new Error("plans did not resolve");
  expect(fromModule.plan.planHash).toBe(inline.plan.planHash);
  // A JSON theme imports the same way.
  writeFileSync(resolve(directory, "theme.json"), JSON.stringify(theme));
  writeFileSync(resolve(directory, "json.host.config.ts"), config(`{ host: "psp", app: { ...${JSON.stringify(app)}, theme } }`, 'import theme from "./theme.json" with { type: "json" };'));
  expect((await loadHostConfig(resolve(directory, "json.host.config.ts"))).value.app?.theme).toEqual(theme);
});

test("a theme module that exports the wrong shape is refused by path", async () => {
  const directory = scratch("invalid");
  writeFileSync(resolve(directory, "wrong.ts"), "export default { animation: { glide: { loop: 2 } } };\n");
  writeFileSync(resolve(directory, "pocket.host.config.ts"), config(`{ host: "psp", app: { ...${JSON.stringify(PORTABLE_APP)}, theme } }`, 'import theme from "./wrong.ts";'));
  await expect(loadHostConfig(resolve(directory, "pocket.host.config.ts"))).rejects.toThrow("/app/theme/animation/glide");
  writeFileSync(resolve(directory, "absent.host.config.ts"), config(`{ host: "psp", app: { ...${JSON.stringify(PORTABLE_APP)}, theme } }`, 'import theme from "./absent.ts";'));
  await expect(loadHostConfig(resolve(directory, "absent.host.config.ts"))).rejects.toThrow();
});

test("the compiler bakes the frozen plan's theme after the config changes", () => {
  const directory = scratch("frozen");
  const result = resolveAppPlan(application, { target: "psp" });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  writeFileSync(resolve(directory, "plan.json"), JSON.stringify(result.plan));
  writeFileSync(resolve(directory, "pocket.host.config.ts"), config(`{ host: "psp", app: ${JSON.stringify({ ...application, theme: {} })} }`));
  writeFileSync(resolve(directory, "main.tsx"), MAIN);
  const run = Bun.spawnSync([
    process.execPath, resolve(ROOT, "tools/build.ts"), `--plan=${directory}/plan.json`, `--project-root=${directory}`, `--outdir=${directory}/out`,
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

test("app.icon is a square PNG", async () => {
  const directory = scratch("icon");
  const square = await encodePng({ width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4) });
  writeFileSync(resolve(directory, "icon.png"), square);
  expect(readAppIcon(resolve(directory, "icon.png"))).toEqual(new Uint8Array(square));
  writeFileSync(resolve(directory, "wide.png"), await encodePng({ width: 4, height: 2, rgba: new Uint8Array(4 * 2 * 4) }));
  expect(() => readAppIcon(resolve(directory, "wide.png"))).toThrow("square PNG");
  expect(() => readAppIcon(resolve(directory, "absent.png"))).toThrow("not a file");
});

test("pocket compile writes one bundle with the config's identity and icon", async () => {
  const directory = scratch("compile");
  const square = await encodePng({ width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4) });
  writeFileSync(resolve(directory, "icon.png"), square);
  writeFileSync(resolve(directory, "main.tsx"), MAIN);
  writeFileSync(resolve(directory, "pocket.host.config.ts"), config(`{ host: "psp", app: ${JSON.stringify({ ...application, output: "glide", icon: "icon.png" })} }`));
  const run = Bun.spawnSync([process.execPath, resolve(ROOT, "tools/pocket.ts"), "compile", "--output", "dist/glide.pkb"],
    { cwd: directory, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, run.stderr.toString() + run.stdout.toString()).toBe(0);
  const bundle = decodeBundle(new Uint8Array(readFileSync(resolve(directory, "dist/glide.pkb"))));
  expect(decodeIdentity(findSection(bundle, BUNDLE_SECTION.identity)!)).toEqual({ output: "glide", id: PORTABLE_APP.id, title: PORTABLE_APP.title });
  expect(findSection(bundle, BUNDLE_SECTION.icon)).toEqual(new Uint8Array(square));
  const plan = JSON.parse(new TextDecoder().decode(findSection(bundle, BUNDLE_SECTION.plan)!));
  expect(plan.target.id).toBe("psp");
  expect(bundle.profileHash).toBe(plan.profileHash);
  expect(plan.app.entry).toBe("main.tsx");
  expect(plan.app.theme).toEqual(theme);
  // --manifest answers with the option that replaced it.
  const removed = Bun.spawnSync([process.execPath, resolve(ROOT, "tools/pocket.ts"), "compile", "--manifest", "pocket.app.json"],
    { cwd: directory, stdout: "pipe", stderr: "pipe" });
  expect(removed.exitCode).not.toBe(0);
  expect(removed.stderr.toString()).toContain("--config");
  // The container format of other products is not an output name.
  const pocket = Bun.spawnSync([process.execPath, resolve(ROOT, "tools/pocket.ts"), "compile", "--output", "dist/glide.pocket"],
    { cwd: directory, stdout: "pipe", stderr: "pipe" });
  expect(pocket.exitCode).not.toBe(0);
  expect(pocket.stderr.toString()).toContain("glide.pkb");
  // build and pack answer --pocket with the option that replaced it.
  for (const verb of ["build", "pack"]) {
    const retired = Bun.spawnSync([process.execPath, resolve(ROOT, "tools/pocket.ts"), verb, "--pocket", "dist/glide.pocket"],
      { cwd: directory, stdout: "pipe", stderr: "pipe" });
    expect(retired.exitCode).not.toBe(0);
    expect(retired.stderr.toString().trim().split("\n")).toHaveLength(1);
    expect(retired.stderr.toString()).toContain("--pocket was removed; pass the compiled application with --bundle FILE");
  }
}, 120_000);

test("app.fonts enters the plan relative to the project root", () => {
  const fonts = { regular: "fonts/Face-Regular.ttf", mono: "fonts/Face-Mono.otf" };
  const request = { target: "psp", configDirectory: resolve(ROOT, "apps/demo"), projectRoot: ROOT };
  const plain = resolveAppPlan(application, request);
  const selected = resolveAppPlan({ ...application, fonts }, request);
  if (!plain.ok || !selected.ok) throw new Error("plans did not resolve");
  expect(plain.plan.app.fonts).toBeUndefined();
  expect(selected.plan.app.fonts).toEqual({ regular: "apps/demo/fonts/Face-Regular.ttf", mono: "apps/demo/fonts/Face-Mono.otf" });
  // The declaration is part of the plan, so it changes the plan hash.
  expect(selected.plan.planHash).not.toBe(plain.plan.planHash);
  for (const [invalid, path] of [
    [{ regular: "../Face.ttf" }, "/app/fonts/regular"],
    [{ bold: "/fonts/Face.ttf" }, "/app/fonts/bold"],
    [{ mono: "fonts/Face.woff2" }, "/app/fonts/mono"],
    [{ italic: "fonts/Face.ttf" }, "/app/fonts/italic"],
  ] as const) {
    expect(validateAppConfig({ ...application, fonts: invalid }).map(item => item.path)).toEqual([path]);
  }
});

test("pocket compile bakes the faces app.fonts names and lists them in the depfile", () => {
  const directory = scratch("fonts");
  mkdirSync(resolve(directory, "fonts"));
  copyFileSync(resolve(ROOT, "assets/fonts/W95FA.otf"), resolve(directory, "fonts/W95FA.otf"));
  writeFileSync(resolve(directory, "main.tsx"), [
    'import { mount } from "@pocketjs/framework/solid";',
    'import { Text } from "@pocketjs/framework/solid/components";',
    'mount(() => <Text class="text-sm">Fonts</Text>);',
  ].join("\n"));
  const compile = (fonts: object | undefined) => {
    writeFileSync(resolve(directory, "pocket.host.config.ts"), config(`{ host: "psp", app: ${JSON.stringify({ ...application, output: "faces", ...(fonts ? { fonts } : {}) })} }`));
    return Bun.spawnSync([process.execPath, resolve(ROOT, "tools/pocket.ts"), "compile", "--output", "dist/faces.pkb", "--depfile", "dist/faces.d"],
      { cwd: directory, stdout: "pipe", stderr: "pipe" });
  };
  const atlases = () => {
    const bundle = decodeBundle(new Uint8Array(readFileSync(resolve(directory, "dist/faces.pkb"))));
    const plan = JSON.parse(new TextDecoder().decode(findSection(bundle, BUNDLE_SECTION.plan)!));
    const pak = unpack(findSection(bundle, BUNDLE_SECTION.pak)!).filter(item => item.key.startsWith("ui:font."));
    return { plan, pak, depfile: readFileSync(resolve(directory, "dist/faces.d"), "utf8") };
  };
  let run = compile(undefined);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const plain = atlases();
  run = compile({ regular: "fonts/W95FA.otf" });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const selected = atlases();
  expect(selected.plan.app.fonts).toEqual({ regular: "fonts/W95FA.otf" });
  expect(selected.plan.planHash).not.toBe(plain.plan.planHash);
  expect(selected.pak.map(item => item.key)).toEqual(plain.pak.map(item => item.key));
  expect(selected.pak.length).toBeGreaterThan(0);
  for (const [index, item] of selected.pak.entries()) expect(Buffer.compare(item.data, plain.pak[index]!.data)).not.toBe(0);
  expect(selected.depfile).toContain(resolve(directory, "fonts/W95FA.otf"));
  expect(plain.depfile).toContain(resolve(ROOT, "assets/fonts/Inter-Regular.ttf"));
  expect(selected.depfile).not.toContain(resolve(ROOT, "assets/fonts/Inter-Regular.ttf"));
  // A face the config names must be a readable file, used slot or not.
  run = compile({ bold: "fonts/Absent-Bold.ttf" });
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr.toString()).toContain(`app.fonts.bold names ${resolve(directory, "fonts/Absent-Bold.ttf")}, which is not a readable file`);
}, 120_000);
