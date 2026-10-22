import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { hashPocketProfile, type PocketProfile } from "../framework/src/profile.ts";
import type { RuntimeBuildContext } from "../framework/src/runtime-config.ts";
import { build as threeDsBuild } from "../products/3ds/recipe.ts";
import threeDs from "../profiles/3ds-dev.ts";
import gba from "../profiles/gba.ts";
import nano from "../profiles/ipodnano.ts";
import psp from "../profiles/psp.ts";
import vita from "../profiles/vita.ts";
import web from "../profiles/web-app.ts";
import { prepareApplication } from "../tools/build/inputs.ts";
import { gbaBuild, ipodNanoBuild } from "../tools/build/programs/aot.ts";
import { deployPsp, deployVita } from "../tools/build/programs/deploy.ts";
import { nativeArguments } from "../tools/build/programs/handheld-common.ts";
import { build as pspBuild } from "../tools/build/programs/psp.ts";
import { build as vitaBuild } from "../tools/build/programs/vita.ts";
import { build as webBuild } from "../tools/build/programs/web.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";

const root = resolve(import.meta.dir, "..");
const base = resolve(root, ".pocket-build/validation/runtime-build/program-tests");
mkdirSync(base, { recursive: true });
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function scratch() { const directory = mkdtempSync(resolve(base, "run-")); temporary.push(directory); return directory; }
function context(profile: PocketProfile, outdir = scratch()): RuntimeBuildContext {
  return { profile, profileHash: hashPocketProfile(profile), configDirectory: root, outdir, output: "example", args: [], env: {}, toolchainPaths: {},
    async run() { throw new Error("unexpected native command"); } };
}

test("handheld recipes fail missing package inputs before invoking an SDK or selecting a demo", async () => {
  for (const [build, profile] of [[pspBuild, psp], [vitaBuild, vita], [threeDsBuild, threeDs]] as const)
    await expect(build.run!(context(profile))).rejects.toThrow("requires --pocket");
  await expect(gbaBuild.run!(context(gba))).rejects.toThrow("requires --aot-dir");
  await expect(ipodNanoBuild.run!(context(nano))).rejects.toThrow("requires --aot-dir");
});

test("native launcher inputs are explicit existing paths while recipe-owned compilation inputs cannot be replaced", () => {
  const ctx = context(psp), registry = resolve(ctx.outdir, "registry.tsv"), packages = resolve(ctx.outdir, "packages");
  writeFileSync(registry, ""); mkdirSync(packages);
  const args = [`--launcher-registry=${registry}`, `--launcher-packages=${packages}`, "--capture"];
  expect(nativeArguments({ ...ctx, args })).toEqual(args);
  expect(() => nativeArguments({ ...ctx, args: ["--plan=/tmp/replacement"] })).toThrow("recipe owns");
  expect(() => nativeArguments({ ...ctx, args: ["--runtime"] })).toThrow("recipe owns");
  expect(() => nativeArguments({ ...ctx, args: ["--features=runtime"] })).toThrow("recipe owns");
  expect(() => nativeArguments({ ...ctx, args: ["--help"] })).toThrow("recipe owns");
  expect(() => nativeArguments({ ...ctx, args: ["--launcher-registry=/missing"] })).toThrow("missing native launcher input");
});

test("web assembly stages admitted bytes and the complete runtime/text provider modules", async () => {
  const ctx = context(web);
  const manifest = { $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id: "dev.pocket.program", name: "example", title: "Example", version: "1.0.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"] } },
    app: { entry: "missing-source.tsx", framework: "solid", output: "example", viewport: { fixed: { logical: [800, 600], presentation: "native" } } } };
  const resolved = validateAndResolveBuildPlan(manifest, { target: web.id }, profileRegistry(web));
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  const variant = makeVariant({ target: web.id, hostAbi: POCKET_BINDING_GENERATION, planJson: JSON.stringify(resolved.plan),
    identity: { id: manifest.id, title: manifest.title, output: "example" }, js: new TextEncoder().encode("globalThis.frame=()=>{};"), pak: new Uint8Array([1, 2, 3]) });
  const pocket = resolve(ctx.outdir, "source.pocket");
  writeFileSync(pocket, encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [variant] }));
  const application = prepareApplication({ profile: web, profileHash: ctx.profileHash, hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, pocket, ctx.outdir);
  for (const [directory, file] of [["cargo-target", "pocketjs_wasm.wasm"], ["cargo-text-target", "pocket_text.wasm"]]) {
    const path = resolve(ctx.outdir, directory!, "wasm32-unknown-unknown/release"); mkdirSync(path, { recursive: true }); writeFileSync(resolve(path, file!), new Uint8Array([0, 97, 115, 109]));
  }
  await webBuild.run!({ ...ctx, application });
  const out = resolve(ctx.outdir, "runtime"), read = (name: string) => readFileSync(resolve(out, name), "utf8");
  expect(read("dist/example.js")).toBe("globalThis.frame=()=>{};");
  expect(readFileSync(resolve(out, "app.pocket"))).toEqual(readFileSync(pocket));
  expect(JSON.parse(read("program.json"))).toMatchObject({ host: web.id, hostAbi: POCKET_BINDING_GENERATION, viewport: [800, 600] });
  // Resolve the staged ES module graph, including the worker entry, from the artifact alone.
  for (const entry of ["programs/web/main.js", "platforms/web/text-worker.js"]) {
    const bundled = await Bun.build({ entrypoints: [resolve(out, entry)], target: "browser" });
    expect(bundled.success).toBe(true);
  }
});

test("explicit deploy stages only this completed artifact and verifies bytes on mounted volumes", () => {
  const ctx = context(psp), pspVolume = resolve(ctx.outdir, "psp-volume"), vitaVolume = resolve(ctx.outdir, "vita-volume");
  mkdirSync(resolve(pspVolume, "PSP/GAME"), { recursive: true }); mkdirSync(resolve(vitaVolume, "VitaShell"), { recursive: true });
  writeFileSync(resolve(ctx.outdir, "example.pbp"), "this-pbp"); writeFileSync(resolve(ctx.outdir, "example.vpk"), "this-vpk");
  expect(() => deployPsp(ctx)).toThrow("POCKET_PSP_VOLUME"); expect(() => deployVita(ctx)).toThrow("POCKET_VITA_VOLUME");
  deployPsp({ ...ctx, env: { POCKET_PSP_VOLUME: pspVolume } }); deployVita({ ...ctx, env: { POCKET_VITA_VOLUME: vitaVolume } });
  expect(readFileSync(resolve(pspVolume, "PSP/GAME/example/EBOOT.PBP"), "utf8")).toBe("this-pbp");
  expect(readFileSync(resolve(vitaVolume, "data/pocketjs-dev/example.vpk"), "utf8")).toBe("this-vpk");
});

test("web program executes one turn per wake and keeps full-size pointer cancellation facts until consumed", async () => {
  const source = readFileSync(resolve(root, "programs/web/main.js"), "utf8").replace('import { create } from "./app-instance.js";', "");
  const canvasEvents = new Map<string, (event: any) => void>(), windowEvents = new Map<string, (event: any) => void>();
  const turns: { facts: any; ticks: number }[] = [], timers: (() => void)[] = [];
  let disposed = 0;
  const canvas = { width: 0, height: 0, getContext: () => ({ putImageData() {} }), focus() {}, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 2000, height: 1200 }),
    addEventListener(name: string, handler: (event: any) => void) { canvasEvents.set(name, handler); } };
  const instance = { stepInput(facts: any, ticks: number) { turns.push({ facts: structuredClone(facts), ticks }); }, render: () => new Uint8Array(4), dispose() { disposed++; } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("create", "document", "window", "fetch", "ImageData", "setTimeout", "clearTimeout", source)(
    async () => instance, { getElementById: () => canvas, title: "" }, { addEventListener(name: string, handler: (event: any) => void) { windowEvents.set(name, handler); } },
    async () => ({ json: async () => ({ title: "Input", viewport: [2000, 1200], simHz: 30 }) }), class {},
    (callback: () => void, delay: number) => { expect(delay).toBe(1000 / 30); timers.push(callback); return timers.length; }, () => {},
  );
  expect(turns).toHaveLength(1); expect(turns[0]!.ticks).toBe(2);
  const pointer = { pointerId: 99, button: 0, clientX: 1500, clientY: 1100, preventDefault() {} };
  canvasEvents.get("pointerdown")!(pointer); timers.shift()!();
  expect(turns).toHaveLength(2); expect(turns[1]!.facts.contacts).toEqual([{ surface: 0, id: 0, x: 1500, y: 1100, cancelled: false }]);
  canvasEvents.get("pointercancel")!(pointer);
  canvasEvents.get("pointerdown")!({ ...pointer, pointerId: 100 }); timers.shift()!();
  expect(turns[2]!.facts.contacts.map((contact: any) => [contact.id, contact.cancelled])).toEqual([[1, false], [0, true]]);
  timers.shift()!(); expect(turns[3]!.facts.contacts).toHaveLength(1);
  windowEvents.get("pagehide")!({}); timers.shift()!(); expect(turns).toHaveLength(4); expect(disposed).toBe(1);
});
