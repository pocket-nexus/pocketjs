import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { decodePocketPackage, encodePocketPackage, findSection, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { canonicalProfileJson } from "../framework/src/profile.ts";
import { exportProfile } from "../tools/profile-export.ts";
import { resolveProfile } from "../tools/profile-resolver.ts";
import { findProjectConfig, loadProject } from "../tools/targets/project.ts";

const root = realpathSync(new URL("..", import.meta.url).pathname);
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = realpathSync(mkdtempSync(join(tmpdir(), "pocketjs-project-"))); temporary.push(path); return path; }
const profile = (id = "board", cadences = [60]) => ({ format: "pocket-host/2", id, platform: "test", form: "takeover", cadences,
  display: { logicalViewports: [[4, 4]], presentations: ["native"], rasterDensity: 1, animation: "repaint" }, panel: { primary: [4, 4] }, capabilities: [] as string[] });
/** Write a host contract and return its file name. */
function writeProfile(directory: string, value: object, name = `${(value as { id: string }).id.replace(/[^\w-]/g, "_")}.json`) {
  writeFileSync(join(directory, name), JSON.stringify(value));
  return name;
}
const config = (body: string) => `import {defineHostConfig} from '@pocketjs/framework/host-config'; export default defineHostConfig(${body});`;
function command(cwd: string, args: string[]) {
  return Bun.spawnSync({ cmd: [process.execPath, join(root, "tools/pocket.ts"), ...args], cwd, env: { ...process.env, POCKET_TARGET: "" }, stdout: "pipe", stderr: "pipe" });
}

describe("host configuration", () => {
  test("nearest config is found from the manifest directory and does not merge ancestors", async () => {
    const directory = scratch(); const app = join(directory, "app"); mkdirSync(app);
    writeFileSync(join(directory, "pocket.host.config.ts"), config(`{host:${JSON.stringify("./" + writeProfile(directory, profile()))}}`));
    expect(findProjectConfig(app)).toBe(join(directory, "pocket.host.config.ts"));
    writeFileSync(join(app, "pocket.host.config.ts"), config(`{host:${JSON.stringify("./" + writeProfile(app, profile("nested")))}}`));
    const result = await loadProject(app);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostics.join("\n"));
    expect(result.project.config).toBe(join(app, "pocket.host.config.ts"));
    expect(result.project.profiles.map(p => p.id)).toEqual(["nested"]);
    expect(result.project.build).toBe(false);
  });

  test("multiple hosts require selection and duplicate ids fail", async () => {
    const directory = scratch(); const file = join(directory, "pocket.host.config.ts");
    const first = writeProfile(directory, profile("first")), second = writeProfile(directory, profile("second"));
    writeFileSync(file, config(`{hosts:${JSON.stringify([first, second])}}`));
    await expect(resolveProfile({ from: directory })).rejects.toThrow("multiple hosts");
    expect((await resolveProfile({ from: directory, hostConfig: file, target: "second" })).profile.id).toBe("second");
    await expect(resolveProfile({ from: directory, hostConfig: file, target: "psp" })).rejects.toThrow("does not implement");
    writeFileSync(file, config(`{hosts:${JSON.stringify([first, writeProfile(directory, profile("first"), "copy.json")])}}`));
    expect((await loadProject(directory)).ok).toBe(false);
    writeFileSync(file, config(`{host:"./first.ts"}`));
    expect((await loadProject(directory)).ok).toBe(false);
  });

  test("CLI and environment override discovery; --target takes a built-in id or a JSON document", async () => {
    const directory = scratch();
    writeFileSync(join(directory, "pocket.host.config.ts"), "throw new Error('not selected')");
    expect((await resolveProfile({ from: directory, target: "psp", env: { POCKET_TARGET: "vita" } })).profile.id).toBe("psp");
    expect((await resolveProfile({ from: directory, env: { POCKET_TARGET: "vita" } })).profile.id).toBe("vita");
    const document = join(directory, writeProfile(directory, profile("board-from-json")));
    const selected = await resolveProfile({ from: directory, target: document });
    expect(selected.profile.id).toBe("board-from-json");
    expect(selected.path).toBe(document);
    expect(selected.dependencies).toEqual([document]);
    await expect(resolveProfile({ from: directory })).rejects.toThrow("not selected");
    await expect(resolveProfile({ from: directory, target: "missing-module" })).rejects.toThrow("unknown host");
    await expect(resolveProfile({ from: directory, target: "@pocketjs/framework/hosts/psp" })).rejects.toThrow("not found");
    writeFileSync(join(directory, "module.ts"), `export default ${JSON.stringify(profile("module"))}`);
    await expect(resolveProfile({ from: directory, target: join(directory, "module.ts") })).rejects.toThrow();
  });

  test("a stamped document is refused under another binding generation", async () => {
    const directory = scratch();
    const stamped = join(directory, writeProfile(directory, { ...profile("stamped"), hostAbi: POCKET_BINDING_GENERATION }));
    expect((await resolveProfile({ from: directory, target: stamped })).profile.hostAbi).toBe(POCKET_BINDING_GENERATION);
    const stale = join(directory, writeProfile(directory, { ...profile("stale"), hostAbi: POCKET_BINDING_GENERATION - 1 }));
    await expect(resolveProfile({ from: directory, target: stale })).rejects.toThrow("binding generation");
  });

  test("host config keeps native npm loading and captures the installed native dependency", async () => {
    const directory = scratch();
    mkdirSync(join(directory, "node_modules/@napi-rs"), { recursive: true });
    symlinkSync(join(root, "node_modules/@napi-rs/canvas"), join(directory, "node_modules/@napi-rs/canvas"), "dir");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { "@napi-rs/canvas": "1.0.2" } }));
    writeFileSync(join(directory, "bun.lock"), "native-dependency-lock-fixture\n");
    const file = writeProfile(directory, profile());
    writeFileSync(join(directory, "pocket.host.config.ts"), `import {createCanvas} from '@napi-rs/canvas';
      const canvas=createCanvas(1,1); const ctx=canvas.getContext('2d');ctx.fillStyle='#172b3f';ctx.fillRect(0,0,1,1);
      if(ctx.getImageData(0,0,1,1).data[0]!==23)throw new Error('canvas');
      export default {host:${JSON.stringify("./" + file)}};`);
    const selected = await resolveProfile({ from: directory });
    expect(selected.profile.id).toBe("board");
    expect(selected.dependencies).toContain(join(directory, file));
    expect(selected.dependencies).toContain(join(directory, "package.json"));
    expect(selected.dependencies).toContain(join(directory, "bun.lock"));
    expect(selected.dependencies).toContain(realpathSync(join(root, "node_modules/@napi-rs/canvas/js-binding.js")));
    expect(selected.dependencies.some(path => /canvas[^/]*\/[^/]+\.node$/.test(path))).toBe(true);
    expect(selected.dependencies.some(path => /canvas-[^/]+\/package\.json$/.test(path))).toBe(true);
  });

  test("a document cannot replace a built-in profile under the same identity", async () => {
    const directory = scratch();
    const file = join(directory, writeProfile(directory, profile("psp")));
    await expect(resolveProfile({ from: directory, target: file })).rejects.toThrow("belongs to a built-in");
  });

  test("external UTF-8 ids are not interpreted as object prototype properties", async () => {
    const directory = scratch();
    for (const id of ["constructor", "__proto__", "toString"]) {
      const file = join(directory, writeProfile(directory, profile(id), "pocket.host.json"));
      const selected = await resolveProfile({ from: directory, target: file });
      expect(selected.profile.id).toBe(id); expect(selected.hostAbi).toBe(POCKET_BINDING_GENERATION);
    }
  });

  test("host export supplies canonical UTF-8 and typed records to a C11 consumer", async () => {
    const directory = scratch(); const file = join(directory, "pocket.host.config.ts");
    writeProfile(directory, {
      ...profile("板子??/"), form: "window", capabilities: ["input.buttons", "text.glyphs.baked", "display.viewport.live", "display.auxiliary"],
      roleCapabilities: { systemUI: ["ui.compositor-surfaces"] },
      display: {
        logicalViewports: [[4, 2], [2, 1]], presentations: ["native", "fit"], rasterDensity: 2, animation: "repaint",
        dynamicViewport: { min: [1, 1], max: [16, 8], acceptsFixed: true },
        auxiliary: { logicalViewports: [[2, 1]], presentations: ["native"], rasterDensity: 2 },
      },
      panel: { primary: [8, 4], auxiliary: [4, 2] },
    }, "pocket.host.json");
    writeFileSync(file, "export default {host:'./pocket.host.json'};");
    const selected = await resolveProfile({ from: directory });
    const out = join(directory, "export"); const dependencyFile = join(directory, "profile.d");
    exportProfile(selected, out, dependencyFile);
    expect(() => exportProfile({ ...selected, hostAbi: POCKET_BINDING_GENERATION - 1 }, out)).toThrow("binding generation");
    const sidecar = JSON.parse(readFileSync(join(out, "pocket.host.json"), "utf8"));
    expect(sidecar).toEqual({ ...selected.profile, hostAbi: POCKET_BINDING_GENERATION });
    expect(canonicalProfileJson(sidecar)).toBe(canonicalProfileJson(selected.profile));
    expect(readFileSync(dependencyFile, "utf8")).toContain(file);
    expect(readFileSync(dependencyFile, "utf8")).toContain(join(directory, "pocket.host.json"));
    const idBytes = [...new TextEncoder().encode(selected.profile.id)];
    const idLiteral = `"${idBytes.map(byte => `\\x${byte.toString(16).padStart(2, "0")}`).join("")}"`;
    writeFileSync(join(out, "consumer.c"), `#include "pocket_profile.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
_Static_assert(POCKET_PROFILE_WIDTH == 8 && POCKET_PROFILE_HEIGHT == 4, "physical size");
static const char capabilities[] = "display.auxiliary\\0display.viewport.live\\0input.buttons\\0text.glyphs.baked";
int main(void) {
    assert(pocket_profile.struct_size == sizeof(pocket_profile));
    assert(pocket_profile.tick_hz == 60 && pocket_profile.host_abi == ${POCKET_BINDING_GENERATION});
    assert(strcmp(pocket_profile.id, ${idLiteral}) == 0 && strcmp(pocket_profile.platform, "test") == 0 && strcmp(pocket_profile.form, "window") == 0);
    assert(pocket_profile.presentation_count == 2 && strcmp(pocket_profile.presentations[0], "native") == 0 && strcmp(pocket_profile.presentations[1], "fit") == 0);
    assert(pocket_profile.cadence_count == 1 && pocket_profile.cadences[0] == 60 && strcmp(pocket_profile.animation, "repaint") == 0);
    const pocket_profile_facts *facts = pocket_profile.facts;
    assert(facts->struct_size == sizeof(*facts));
    assert(facts->id_length == ${idBytes.length} && memcmp(facts->id, ${idLiteral}, ${idBytes.length}) == 0);
    assert(facts->tick_hz == 60 && facts->input_classes == POCKET_INPUT_CLASS_BUTTONS);
    assert(facts->cadence_count == 1 && facts->cadences[0] == 60);
    assert(facts->capabilities_length == sizeof capabilities && memcmp(facts->capabilities, capabilities, sizeof capabilities) == 0);
    assert(facts->presentations_length == 11 && memcmp(facts->presentations, "native\\0fit", 11) == 0);
    assert(facts->animation_length == 7 && memcmp(facts->animation, "repaint", 7) == 0);
    const pocket_profile_display *display = facts->display;
    assert(display->struct_size == sizeof(*display));
    assert(display->physical[0] == 8 && display->physical[1] == 4);
    assert(display->logical_count == 2 && display->logical[0] == 4 && display->logical[1] == 2 && display->logical[3] == 1);
    assert(display->raster_density == 2);
    assert(facts->auxiliary->struct_size == sizeof(*display));
    assert(facts->auxiliary->physical[0] == 4 && facts->auxiliary->logical_count == 1 && facts->auxiliary->logical[1] == 1);
    assert(facts->dynamic_viewport->struct_size == sizeof(*facts->dynamic_viewport));
    assert(facts->dynamic_viewport->min[0] == 1 && facts->dynamic_viewport->max[1] == 8);
    assert(pocket_profile.capability_count == 4 && strcmp(pocket_profile.capabilities[0], "display.auxiliary") == 0 && strcmp(pocket_profile.capabilities[3], "text.glyphs.baked") == 0);
    assert(pocket_profile.system_ui_capability_count == 1 && strcmp(pocket_profile.system_ui_capabilities[0], "ui.compositor-surfaces") == 0);
    fwrite(facts->id, 1, facts->id_length, stdout);
    putchar(10);
    return 0;
}
`);
    const compile = Bun.spawnSync({ cmd: ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", join(root, "contracts/generated"), join(out, "consumer.c"), "-o", join(out, "consumer")], stderr: "pipe" });
    expect(compile.success, compile.stderr.toString()).toBe(true);
    const run = Bun.spawnSync({ cmd: [join(out, "consumer")], stdout: "pipe" });
    expect(run.success).toBe(true);
    expect(run.stdout.toString()).toBe(selected.profile.id + "\n");
    const module = readFileSync(join(out, "pocket_profile.rs"), "utf8");
    expect(module).toContain("pub const ID: &str = \"");
    expect(module).toContain("pub const EXPORTED: bool = true;");
    expect(module).toContain("dynamic_viewport: Some([[1, 1], [16, 8]])");
    expect(module).toContain("auxiliary: Some([4, 2])");
    expect(module).toContain(`PROFILE_HASH: [u8; 32] = [${selected.profileHash.slice(7).match(/../g)!.map(byte => Number.parseInt(byte, 16)).join(", ")}]`);
  });

  test("no-build programs export profiles without an app or node_modules", () => {
    const directory = scratch();
    writeFileSync(join(directory, "pocket.host.config.ts"), config(`{host:${JSON.stringify("./" + writeProfile(directory, profile()))}}`));
    const result = command(directory, ["build", "--out", "export"]);
    expect(result.success, result.stderr.toString()).toBe(true);
    expect(result.stdout.toString()).toContain("external build system");
    const exported = JSON.parse(readFileSync(join(directory, "export/pocket.host.json"), "utf8"));
    expect(exported.id).toBe("board");
    expect(exported.hostAbi).toBe(POCKET_BINDING_GENERATION);
  });

  test("compile emits a package for each selected external profile and tracks imported profile sources", () => {
    const directory = scratch(); const app = join(directory, "app"); mkdirSync(app);
    mkdirSync(join(directory, "node_modules/@pocketjs"), { recursive: true });
    symlinkSync(root, join(directory, "node_modules/@pocketjs/framework"), "dir");
    const documents = [profile("external-a"), profile("external-b", [30])].map(p => writeProfile(directory, { ...p, capabilities: ["input.buttons"] }));
    const runtime = join(directory, "pocket.host.config.ts");
    writeFileSync(runtime, `export default {hosts:${JSON.stringify(documents)}};`);
    writeFileSync(join(app, "main.tsx"), 'import {mount} from "@pocketjs/framework";import {View} from "@pocketjs/framework/components";mount(()=><View class="w-full h-full bg-red-500"/>);');
    writeFileSync(join(app, "pocket.app.json"), JSON.stringify({ $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id: "example.compile", title: "Compile", version: "1.0.0", engine: { capabilities: { requires: ["input.buttons"] } }, app: { entry: "main.tsx", output: "app", framework: "solid", viewport: { logical: [4, 4], presentation: "native" } } }));
    for (const target of ["external-a", "external-b"]) {
      const output = join(directory, target, "app.pocket");
      const dependency = join(directory, target, "app.d");
      const result = command(directory, ["compile", "--manifest", "app/pocket.app.json", "--host-config", runtime, "--target", target, "--outdir", join(directory, target), "--output", output, "--depfile", dependency]);
      expect(result.success, result.stderr.toString() + result.stdout.toString()).toBe(true);
      const pkg = decodePocketPackage(new Uint8Array(readFileSync(output)));
      expect(pkg.variants).toHaveLength(1);
      const variant = pkg.variants[0]!;
      expect(variant.target).toBe(target);
      expect(variant.hostAbi).toBe(POCKET_BINDING_GENERATION);
      const plan = JSON.parse(new TextDecoder().decode(findSection(variant, POCKET_SECTION.plan)!));
      // The rate is the application's (default 60); the cadences are the target's.
      expect(plan.profile.tickHz).toBe(60);
      expect(plan.profile.cadences).toEqual(target === "external-a" ? [60] : [30]);
      expect(readFileSync(dependency, "utf8")).toContain(join(directory, `${target}.json`));
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
    writeFileSync(join(directory, "pocket.host.config.ts"), `import {defineHostConfig,compilerOnly} from '@pocketjs/framework/host-config';export default defineHostConfig({host:${JSON.stringify("./" + writeProfile(directory, profile()))},build:{hosts:[${JSON.stringify(host)}],steps:compilerOnly(),async run(ctx){await Bun.write(ctx.outdir+'/observed.json',JSON.stringify({dir:import.meta.dir,cwd:ctx.configDirectory}));}}});`);
    const result = command(directory, ["build", "--out", "export"]);
    expect(result.success, result.stderr.toString()).toBe(true);
    const observed = JSON.parse(readFileSync(join(directory, "export/observed.json"), "utf8"));
    expect(observed.dir).toBe(directory); expect(observed.cwd).toBe(directory);
  });

  test("toolchain status and implicit installation follow the program recipe rather than profile ids", () => {
    const directory = scratch();
    writeFileSync(join(directory, "pocket.host.config.ts"), config(`{host:${JSON.stringify("./" + writeProfile(directory, profile()))},build:{hosts:[${JSON.stringify(`${process.platform}-${process.arch}`)}],toolchain:{schema:'pocket-toolchain/2',target:'custom-toolchain',components:[]},steps:{kind:'compilerOnly'}}}`));
    const listing = command(directory, ["target", "list", "--json", "--check"]);
    expect(listing.success, listing.stderr.toString()).toBe(true);
    expect(JSON.parse(listing.stdout.toString()).find((row: { id: string }) => row.id === "custom-toolchain").state).toBe("nothing to install");
    const installed = command(directory, ["target", "add"]);
    expect(installed.success, installed.stderr.toString()).toBe(true);
    expect(installed.stdout.toString()).toContain("custom-toolchain");
    expect(installed.stdout.toString()).not.toContain("board");
    const shown = Bun.spawnSync({ cmd: [process.execPath, join(root, "tools/cli/bin.mjs"), "show", "--json", "--host-config", join(directory, "pocket.host.config.ts")], cwd: root, env: { ...process.env, POCKET_TARGET: "" }, stdout: "pipe", stderr: "pipe" });
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
