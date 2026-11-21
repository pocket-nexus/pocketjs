import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { encodeBundle } from "../contracts/spec/bundle.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { hashPocketProfile, type PocketProfile } from "../framework/src/profile.ts";
import type { RuntimeBuildContext } from "../framework/src/host-config.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { prepareApplication } from "../tools/build/inputs.ts";
import { gbaBuild, ipodNanoBuild } from "../tools/build/programs/aot.ts";
import { deployPsp, deployVita } from "../tools/build/programs/deploy.ts";
import { nativeArguments } from "../tools/build/programs/handheld-common.ts";
import { build as threeDsBuild } from "../tools/build/programs/3ds.ts";
import { build as pspBuild } from "../tools/build/programs/psp.ts";
import { build as vitaBuild } from "../tools/build/programs/vita.ts";
import { build as webBuild } from "../tools/build/programs/web.ts";
import { makeBundle } from "../tools/bundle.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";
const threeDs = POCKET_PROFILES["3ds-runtime"];
const gba = POCKET_PROFILES["gba"];
const nano = POCKET_PROFILES["ipodnano"];
const psp = POCKET_PROFILES["psp"];
const vita = POCKET_PROFILES["vita"];
const web = POCKET_PROFILES["web-app"];

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
  for (const [build, profile] of [[pspBuild, psp], [vitaBuild, vita]] as const)
    await expect(build.run!(context(profile))).rejects.toThrow("requires --bundle");
  // The 3DS recipe builds the file-loaded runtime: it takes no package and no native overrides.
  await expect(threeDsBuild.run!({ ...context(threeDs), args: ["--capture"] })).rejects.toThrow("3DS generic runtime accepts no native overrides");
  await expect(threeDsBuild.run!(context(psp))).rejects.toThrow("requires its declared program profile");
  await expect(gbaBuild.run!(context(gba))).rejects.toThrow("requires --aot-dir");
  await expect(ipodNanoBuild.run!(context(nano))).rejects.toThrow("requires --aot-dir");
});

test("native arguments pass through while recipe-owned compilation inputs cannot be replaced", () => {
  const ctx = context(psp);
  const args = ["--capture", "--bench"];
  expect(nativeArguments({ ...ctx, args })).toEqual(args);
  expect(() => nativeArguments({ ...ctx, args: ["--plan=/tmp/replacement"] })).toThrow("recipe owns");
  expect(() => nativeArguments({ ...ctx, args: ["--runtime"] })).toThrow("recipe owns");
  expect(() => nativeArguments({ ...ctx, args: ["--features=runtime"] })).toThrow("recipe owns");
  expect(() => nativeArguments({ ...ctx, args: ["--help"] })).toThrow("recipe owns");
});

test("web assembly stages admitted bytes and the complete runtime/text provider modules", async () => {
  const ctx = context(web);
  const app = { id: "dev.pocket.program", title: "Example", version: "1.0.0", features: ["text.glyphs.baked"],
    entry: "missing-source.tsx", framework: "solid", output: "example", viewport: { fixed: { logical: [800, 600], presentation: "native" } } } as const;
  const resolved = resolveAppPlan(app, { target: web.id }, profileRegistry(web));
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  const bundle = resolve(ctx.outdir, "source.pkb");
  writeFileSync(bundle, encodeBundle(makeBundle({ plan: resolved.plan, js: new TextEncoder().encode("globalThis.frame=()=>{};"), pak: new Uint8Array([1, 2, 3]) })));
  const application = prepareApplication({ profile: web, profileHash: ctx.profileHash, hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, bundle, ctx.outdir);
  for (const [directory, file] of [["cargo-target", "pocketjs_wasm.wasm"], ["cargo-text-target", "pocket_text.wasm"]]) {
    const path = resolve(ctx.outdir, directory!, "wasm32-unknown-unknown/release"); mkdirSync(path, { recursive: true }); writeFileSync(resolve(path, file!), new Uint8Array([0, 97, 115, 109]));
  }
  await webBuild.run!({ ...ctx, application });
  const out = resolve(ctx.outdir, "runtime"), read = (name: string) => readFileSync(resolve(out, name), "utf8");
  expect(read("dist/example.js")).toBe("globalThis.frame=()=>{};");
  expect(readFileSync(resolve(out, "app.pkb"))).toEqual(readFileSync(bundle));
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
