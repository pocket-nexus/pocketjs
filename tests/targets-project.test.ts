import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectConfig, loadProject } from "../tools/targets/project.ts";
import { resolveProfile } from "../tools/profile-resolver.ts";
import { exportProfile } from "../tools/profile-export.ts";
import { canonicalProfileJson } from "../framework/src/profile.ts";
import { decodePocketPackage, encodePocketPackage, findSection, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";

const root = realpathSync(new URL("..", import.meta.url).pathname);
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = realpathSync(mkdtempSync(join(tmpdir(), "pocketjs-project-"))); temporary.push(path); return path; }
const profile = (id = "board", hz = 60) => ({ id, platform: "test", form: "takeover", tickHz: hz, display: { physicalViewport: [4, 4], logicalViewports: [[4, 4]], presentations: ["native"], rasterDensity: 1 }, capabilities: [] });
const config = (body: string) => `import {defineRuntimeConfig} from '@pocketjs/framework/runtime-config'; export default defineRuntimeConfig(${body});`;
function command(cwd: string, args: string[]) {
  return Bun.spawnSync({ cmd: [process.execPath, join(root, "tools/pocket.ts"), ...args], cwd, env: { ...process.env, POCKET_TARGET: "" }, stdout: "pipe", stderr: "pipe" });
}

describe("runtime configuration", () => {
  test("nearest config is found from the manifest directory and does not merge ancestors", async () => {
    const directory = scratch(); const app = join(directory, "app"); mkdirSync(app);
    writeFileSync(join(directory, "pocket.runtime-config.ts"), config(`{profile:${JSON.stringify(profile())}}`));
    expect(findProjectConfig(app)).toBe(join(directory, "pocket.runtime-config.ts"));
    writeFileSync(join(app, "pocket.runtime-config.ts"), config(`{profile:${JSON.stringify(profile("nested"))}}`));
    const result = await loadProject(app);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostics.join("\n"));
    expect(result.project.config).toBe(join(app, "pocket.runtime-config.ts"));
    expect(result.project.profiles.map(p => p.id)).toEqual(["nested"]);
    expect(result.project.build).toBe(false);
  });

  test("multiple profiles require selection and duplicate ids fail", async () => {
    const directory = scratch(); const file = join(directory, "pocket.runtime-config.ts");
    writeFileSync(file, config(`{profiles:[${JSON.stringify(profile("first"))},${JSON.stringify(profile("second"))}]}`));
    await expect(resolveProfile({ from: directory })).rejects.toThrow("multiple profiles");
    expect((await resolveProfile({ from: directory, runtimeConfig: file, target: "second" })).profile.id).toBe("second");
    await expect(resolveProfile({ from: directory, runtimeConfig: file, target: "psp" })).rejects.toThrow("does not implement");
    writeFileSync(file, config(`{profiles:[${JSON.stringify(profile())},${JSON.stringify(profile())}]}`));
    expect((await loadProject(directory)).ok).toBe(false);
  });

  test("CLI and environment override discovery; an explicit program config constrains selection", async () => {
    const directory = scratch();
    writeFileSync(join(directory, "pocket.runtime-config.ts"), "throw new Error('not selected')");
    expect((await resolveProfile({ from: directory, target: "psp", env: { POCKET_TARGET: "vita" } })).profile.id).toBe("psp");
    expect((await resolveProfile({ from: directory, env: { POCKET_TARGET: "vita" } })).profile.id).toBe("vita");
    expect((await resolveProfile({ from: directory, target: "@pocketjs/framework/profiles/psp" })).profile.id).toBe("psp");
    await expect(resolveProfile({ from: directory })).rejects.toThrow("not selected");
    await expect(resolveProfile({ from: directory, target: "missing-module" })).rejects.toThrow("unknown profile");
  });

  test("npm profile modules, imports and import.meta retain their source locations", async () => {
    const directory = scratch(); const pkg = join(directory, "node_modules/custom-profile"); mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "custom-profile", type: "module", exports: "./index.ts" }));
    writeFileSync(join(pkg, "value.ts"), `export const value=${JSON.stringify(profile("external/npm"))};`);
    writeFileSync(join(pkg, "index.ts"), "import {value} from './value.ts'; export default {...value,hostExtension:{directory:import.meta.dir}};");
    const selected = await resolveProfile({ from: directory, target: "custom-profile" });
    expect(selected.profile.id).toBe("external/npm");
    expect(selected.profile.hostExtension?.directory).toBe(pkg);
    expect(selected.hostAbi).toBe(1);
    expect(selected.dependencies).toContain(join(pkg, "index.ts"));
    expect(selected.dependencies).toContain(join(pkg, "value.ts"));
    expect(selected.dependencies).toContain(join(pkg, "package.json"));
    expect(selected.dependencies).not.toContain("/");
  });

  test("a module cannot replace a built-in profile under the same identity", async () => {
    const directory = scratch(); const file = join(directory, "profile.ts");
    writeFileSync(file, `export default ${JSON.stringify(profile("psp"))}`);
    await expect(resolveProfile({ from: directory, target: file })).rejects.toThrow("belongs to a built-in");
  });

  test("external UTF-8 ids are not interpreted as object prototype properties", async () => {
    const directory = scratch(); const file = join(directory, "profile.ts");
    for (const id of ["constructor", "__proto__", "toString"]) {
      writeFileSync(file, `export default ${JSON.stringify(profile(id))}`);
      const selected = await resolveProfile({ from: directory, target: file });
      expect(selected.profile.id).toBe(id); expect(selected.hostAbi).toBe(1);
    }
  });

  test("profile export preserves canonical UTF-8 and hash in a C11 consumer and dependencies", async () => {
    const directory = scratch(); const file = join(directory, "pocket.runtime-config.ts");
    writeFileSync(join(directory, "profile.ts"), `export default ${JSON.stringify({
      ...profile("板子??/"), form: "window", capabilities: ["input.buttons", "text.glyphs.baked", "display.viewport.live", "display.auxiliary"],
      roleCapabilities: { systemUI: ["ui.compositor-surfaces"] },
      display: {
        physicalViewport: [8, 4], logicalViewports: [[4, 2], [2, 1]], presentations: ["native", "fit"], rasterDensity: 2,
        dynamicViewport: { min: [1, 1], max: [16, 8], acceptsFixed: true },
        auxiliary: { physicalViewport: [4, 2], logicalViewports: [[2, 1]], presentations: ["native"], rasterDensity: 2 },
      },
    })}`);
    writeFileSync(file, "import profile from './profile.ts'; export default {profile};");
    const selected = await resolveProfile({ from: directory });
    const out = join(directory, "export"); const dependencyFile = join(directory, "profile.d");
    exportProfile(selected, out, dependencyFile);
    const sidecar = JSON.parse(readFileSync(join(out, "pocket-profile.json"), "utf8"));
    expect(sidecar).toMatchObject({ format: "pocket-profile/1", canonicalProfileJson: canonicalProfileJson(selected.profile), profileHash: selected.profileHash, hostAbi: 1 });
    expect(readFileSync(dependencyFile, "utf8")).toContain(file);
    expect(readFileSync(dependencyFile, "utf8")).toContain(join(directory, "profile.ts"));
    writeFileSync(join(out, "consumer.c"), `#include "pocket_profile.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
_Static_assert(POCKET_PROFILE_WIDTH == 8 && POCKET_PROFILE_HEIGHT == 4, "physical size");
_Static_assert(POCKET_PROFILE_TICK_HZ == 60, "tick rate");
int main(void) {
    assert(pocket_profile.struct_size == sizeof(pocket_profile));
    assert(pocket_profile.tick_hz == 60 && pocket_profile.host_abi == 1);
    assert(strcmp(pocket_profile.platform, "test") == 0 && strcmp(pocket_profile.form, "window") == 0);
    const pocket_profile_display *display = &pocket_profile.display;
    assert(display->struct_size == sizeof(*display));
    assert(display->physical_viewport.width == 8 && display->physical_viewport.height == 4);
    assert(display->logical_viewport_count == 2 && display->logical_viewports[0].width == 4 && display->logical_viewports[1].height == 1);
    assert(display->raster_density == 2);
    assert(display->presentations == (POCKET_PROFILE_PRESENTATION_NATIVE | POCKET_PROFILE_PRESENTATION_FIT));
    assert(pocket_profile.auxiliary_display->struct_size == sizeof(*display));
    assert(pocket_profile.auxiliary_display->physical_viewport.width == 4 && pocket_profile.auxiliary_display->logical_viewports[0].height == 1);
    assert(pocket_profile.dynamic_viewport->struct_size == sizeof(*pocket_profile.dynamic_viewport));
    assert(pocket_profile.dynamic_viewport->min.width == 1 && pocket_profile.dynamic_viewport->max.height == 8 && pocket_profile.dynamic_viewport->accepts_fixed == 1);
    assert(pocket_profile.capabilities == (POCKET_PROFILE_CAP_INPUT_BUTTONS | POCKET_PROFILE_CAP_TEXT_GLYPHS_BAKED | POCKET_PROFILE_CAP_DISPLAY_VIEWPORT_LIVE | POCKET_PROFILE_CAP_DISPLAY_AUXILIARY));
    assert(pocket_profile.system_ui_capabilities == POCKET_PROFILE_CAP_UI_COMPOSITOR_SURFACES);
    fwrite(pocket_profile.profile_json, 1, pocket_profile.profile_json_length, stdout);
    putchar(10);
    for (unsigned i = 0; i < 32; i++) printf("%02x", pocket_profile.profile_hash[i]);
    return 0;
}
`);
    const compile = Bun.spawnSync({ cmd: ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", join(out, "consumer.c"), "-o", join(out, "consumer")], stderr: "pipe" });
    expect(compile.success, compile.stderr.toString()).toBe(true);
    const run = Bun.spawnSync({ cmd: [join(out, "consumer")], stdout: "pipe" });
    expect(run.success).toBe(true);
    expect(run.stdout.toString()).toBe(canonicalProfileJson(selected.profile) + "\n" + selected.profileHash.slice(7));
  });

  test("no-build programs export profiles without an app or node_modules", () => {
    const directory = scratch();
    writeFileSync(join(directory, "pocket.runtime-config.ts"), config(`{profile:${JSON.stringify(profile())}}`));
    const result = command(directory, ["build", "--out", "export"]);
    expect(result.success, result.stderr.toString()).toBe(true);
    expect(result.stdout.toString()).toContain("external build system");
    expect(JSON.parse(readFileSync(join(directory, "export/pocket-profile.json"), "utf8")).profile.id).toBe("board");
  });

  test("compile emits a package for each selected external profile and tracks imported profile sources", () => {
    const directory = scratch(); const app = join(directory, "app"); mkdirSync(app);
    mkdirSync(join(directory, "node_modules/@pocketjs"), { recursive: true });
    symlinkSync(root, join(directory, "node_modules/@pocketjs/framework"), "dir");
    writeFileSync(join(directory, "profiles.ts"), `export const profiles=${JSON.stringify([profile("external-a"), profile("external-b", 30)].map(p => ({...p,capabilities:["input.buttons"]})))};`);
    const runtime = join(directory, "pocket.runtime-config.ts");
    writeFileSync(runtime, "import {profiles} from './profiles.ts';export default {profiles};");
    writeFileSync(join(app, "main.tsx"), 'import {mount} from "@pocketjs/framework";import {View} from "@pocketjs/framework/components";mount(()=><View class="w-full h-full bg-red-500"/>);');
    writeFileSync(join(app, "pocket.json"), JSON.stringify({ $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id: "example.compile", name: "compile", title: "Compile", version: "1.0.0", engine: { capabilities: { requires: ["input.buttons"] } }, app: { entry: "main.tsx", output: "app", framework: "solid", viewport: { logical: [4, 4], presentation: "native" } } }));
    for (const target of ["external-a", "external-b"]) {
      const output = join(directory, target, "app.pocket");
      const dependency = join(directory, target, "app.d");
      const result = command(directory, ["compile", "--manifest", "app/pocket.json", "--runtime-config", runtime, "--target", target, "--outdir", join(directory, target), "--output", output, "--depfile", dependency]);
      expect(result.success, result.stderr.toString() + result.stdout.toString()).toBe(true);
      const pkg = decodePocketPackage(new Uint8Array(readFileSync(output)));
      expect(pkg.variants).toHaveLength(1);
      const variant = pkg.variants[0]!;
      expect(variant.target).toBe(target);
      expect(variant.hostAbi).toBe(1);
      const plan = JSON.parse(new TextDecoder().decode(findSection(variant, POCKET_SECTION.plan)!));
      expect(plan.profileHash).toBe(variant.profileHash);
      expect(plan.profile.tickHz).toBe(target === "external-a" ? 60 : 30);
      expect(readFileSync(dependency, "utf8")).toContain(join(directory, "profiles.ts"));
      expect(readFileSync(dependency, "utf8")).toContain(runtime);
      expect(existsSync(join(directory, target, "app.js"))).toBe(true);
      const verified = Bun.spawnSync({ cmd: [process.execPath, join(root, "tools/pocket-pack.ts"), "verify", output], stdout: "pipe", stderr: "pipe" });
      expect(verified.success, verified.stderr.toString()).toBe(true);
      const invalid = join(directory, target, "invalid.pocket");
      const manifest = JSON.parse(new TextDecoder().decode(pkg.manifest));
      manifest.engine.capabilities.requires.push("input.touch");
      writeFileSync(invalid, encodePocketPackage({ ...pkg, manifest: new TextEncoder().encode(JSON.stringify(manifest)) }));
      const rejected = Bun.spawnSync({ cmd: [process.execPath, join(root, "tools/pocket-pack.ts"), "verify", invalid], stdout: "pipe", stderr: "pipe" });
      expect(rejected.success).toBe(false);
      expect(rejected.stderr.toString()).toContain("no longer admitted");
    }
  }, 120_000);

  test("runtime hooks receive the selected trusted profile and source-relative context", () => {
    const directory = scratch();
    const host = `${process.platform}-${process.arch}`;
    writeFileSync(join(directory, "pocket.runtime-config.ts"), `import {defineRuntimeConfig,compilerOnly} from '@pocketjs/framework/runtime-config';export default defineRuntimeConfig({profile:${JSON.stringify(profile())},build:{hosts:[${JSON.stringify(host)}],steps:compilerOnly(),async run(ctx){await Bun.write(ctx.outdir+'/observed.json',JSON.stringify({hash:ctx.env.POCKETJS_PROFILE_HASH,dir:import.meta.dir,cwd:ctx.configDirectory}));}}});`);
    const result = command(directory, ["build", "--out", "export"]);
    expect(result.success, result.stderr.toString()).toBe(true);
    const observed = JSON.parse(readFileSync(join(directory, "export/observed.json"), "utf8"));
    expect(observed.dir).toBe(directory); expect(observed.cwd).toBe(directory);
    expect(observed.hash).toBe(JSON.parse(readFileSync(join(directory, "export/pocket-profile.json"), "utf8")).profileHash);
  });

  test("toolchain status and implicit installation follow the program recipe rather than profile ids", () => {
    const directory = scratch();
    writeFileSync(join(directory, "pocket.runtime-config.ts"), config(`{profile:${JSON.stringify(profile())},build:{hosts:[${JSON.stringify(`${process.platform}-${process.arch}`)}],toolchain:{schema:'pocket-toolchain/2',target:'custom-toolchain',components:[]},steps:{kind:'compilerOnly'}}}`));
    const listing = command(directory, ["target", "list", "--json", "--check"]);
    expect(listing.success, listing.stderr.toString()).toBe(true);
    expect(JSON.parse(listing.stdout.toString()).find((row: { id: string }) => row.id === "custom-toolchain").state).toBe("nothing to install");
    const installed = command(directory, ["target", "add"]);
    expect(installed.success, installed.stderr.toString()).toBe(true);
    expect(installed.stdout.toString()).toContain("custom-toolchain");
    expect(installed.stdout.toString()).not.toContain("board");
    const shown = Bun.spawnSync({ cmd: [process.execPath, join(root, "tools/cli/bin.mjs"), "show", "--json", "--runtime-config", join(directory, "pocket.runtime-config.ts")], cwd: root, env: { ...process.env, POCKET_TARGET: "" }, stdout: "pipe", stderr: "pipe" });
    expect(shown.success, shown.stderr.toString()).toBe(true);
    const report = JSON.parse(shown.stdout.toString());
    expect(report.selection.id).toBe("board");
    expect(report.targets.find((row: { id: string }) => row.id === "custom-toolchain").state).toBe("nothing to install");
  });

  test("tools/pocket.ts stops when the CLI speaks another protocol", () => {
    const result = command(root, ["check", "--target", "psp", "--cli-protocol", "2"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("the CLI speaks protocol 2 and the framework");
  });
});
