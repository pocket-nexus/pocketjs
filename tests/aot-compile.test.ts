import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { compileAot } from "../tools/aot-compile.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/index.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";
import gba from "../profiles/gba.ts";
import { analyzeAot } from "../microts/compiler/aot-build.ts";

const ROOT = resolve(import.meta.dir, "..");
const RUNS = resolve(ROOT, ".pocket-build/validation/aot-compile");
mkdirSync(RUNS, { recursive: true });
function temporary() { return mkdtempSync(join(RUNS, "test-")); }
const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(path, item.name)) : [join(path, item.name)]);

describe("AOT application artifact", () => {
  test("compile --aot admits an AOT-only manifest and emits input dependencies without a package", async () => {
    const directory = temporary();
    try {
      const manifest = JSON.parse(readFileSync(resolve(ROOT, "apps/ipodnano-hero/pocket.json"), "utf8"));
      manifest.execution = { classes: ["aot"] };
      const source = join(directory, "pocket.json");
      writeFileSync(source, JSON.stringify(manifest));
      const out = join(directory, "generated"), dependencyFile = join(directory, "generated.d");
      const child = Bun.spawn([process.execPath, resolve(ROOT, "tools/pocket.ts"), "compile", "--aot", "--target", "ipodnano", "--manifest", source, "--project-root", ROOT, "--plan-dir", join(directory, "plans"), "--out", out, "--depfile", dependencyFile], { cwd: ROOT, env: { ...process.env, PATH: "" }, stdout: "pipe", stderr: "pipe" });
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ status, signal: child.signalCode, stderr }, stdout).toEqual({ status: 0, signal: null, stderr: "" });
      expect(existsSync(join(out, "include.rs"))).toBe(true);
      expect(files(out).some(file => /\.(?:pocket|js)$/.test(file))).toBe(false);
      const dependencies = readFileSync(dependencyFile, "utf8");
      expect(dependencies).toContain(source);
      expect(dependencies).toContain(resolve(ROOT, "apps/ipodnano-hero/app.ts"));
      expect(dependencies).toContain(resolve(ROOT, "profiles/ipodnano.ts"));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120_000);

  test("GBA and iPod nano generate source and assets with no native build process", async () => {
    const directory = temporary();
    try {
      // The application compiler has no executable native tools available.
      // A regression to the former wasm/Cargo subprocess fails this command.
      const script = `import {compileBuiltinAot} from ${JSON.stringify(resolve(ROOT, "tools/aot-compile.ts"))};\nfor(const target of ['gba','ipodnano']) await compileBuiltinAot(target,${JSON.stringify(directory)}+'/'+target);`;
      const child = Bun.spawn([process.execPath, "-e", script], { cwd: ROOT, env: { ...process.env, PATH: "" }, stdout: "pipe", stderr: "pipe" });
      const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ status, signal: child.signalCode, stderr }).toEqual({ status: 0, signal: null, stderr: "" });
      for (const target of ["gba", "ipodnano"]) {
        const out = join(directory, target), generated = files(out).map(path => relative(out, path));
        expect(generated).toContain("include.rs");
        expect(generated).toContain("mod.rs");
        expect(generated).toContain("app_model.rs");
        expect(generated.some(file => /font-\d+\.bin$/.test(file))).toBe(true);
        expect(generated.filter(file => file.endsWith(".rgba"))).toHaveLength(9);
        expect(generated.some(file => /\.(?:js|pocket|wasm|elf|gba|a|rock)$/.test(file))).toBe(false);
        expect(readFileSync(join(out, "include.rs"), "utf8")).not.toContain(directory);
        const dependencies = JSON.parse(readFileSync(join(out, "dependencies.json"), "utf8"));
        expect(dependencies.kind).toBe("aot");
        expect(dependencies.inputs.some((input: { path: string }) => input.path === resolve(ROOT, `apps/${target}-hero/main.tsx`))).toBe(true);
        expect(dependencies.inputs.some((input: { path: string }) => input.path === resolve(ROOT, `apps/${target}-hero/app.ts`))).toBe(true);
        expect(dependencies.inputs.some((input: { path: string }) => input.path.endsWith("Inter-Regular.ttf"))).toBe(true);
        expect(dependencies.outputs.some((output: { sources: string[] }) => output.sources.some(path => path.endsWith("assets/images/logo.png")))).toBe(true);
        expect(readFileSync(join(out, "dependencies.d"), "utf8")).toContain("dependencies.json:");
        const layers = JSON.parse(readFileSync(join(out, "layers.json"), "utf8"));
        expect(layers.tickRate).toBe(30);
        expect(layers.layers.length > 0).toBe(target === "gba");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120_000);

  test("a Vue mount module generates its root and tracks imported model contracts", async () => {
    const project = temporary();
    try {
      writeFileSync(join(project, "main.ts"), "import App from './App.vue'; export default App;");
      writeFileSync(join(project, "App.vue"), `<script setup lang="ts">
import {View, Text} from '@pocketjs/framework/vue-vapor/components';
import {label} from './App';
</script><template><View class="w-[20] h-[20]"><Text>{{label}}</Text></View></template>`);
      writeFileSync(join(project, "App.d.ts"), "export declare const label: string;");
      const manifest = { $schema: "https://pocketjs.dev/schema/pocket-2.json", name: "vue-aot-test", pocket: 2, id: "dev.test.vue-aot", title: "Vue AOT", version: "1.0.0", engine: { capabilities: { requires: ["text.glyphs.baked"] } }, app: {
        entry: "main.ts", framework: "vue-vapor", aot: true, viewport: { fixed: { logical: [240,160], presentation: "native" } },
      } };
      const manifestPath = join(project, "pocket.json");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const resolved = validateAndResolveBuildPlan(manifest, { target: "gba" }, profileRegistry(gba));
      if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
      const result = await compileAot({ plan: resolved.plan, projectRoot: project, manifestPath, outdir: join(project, "out") });
      expect(result.result.entry).toBe(join(project, "App.vue"));
      expect(result.dependencies).toContain(join(project, "App.d.ts"));
      expect(result.dependencies).toContain(join(project, "main.ts"));
      expect(result.files).toContain(join(project, "out/include.rs"));
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 120_000);

  test("custom app theme and profile tick rate are isolated across compilations", async () => {
    const project = temporary();
    try {
      const entry = join(project, "app.tsx"), manifestPath = join(project, "pocket.json");
      writeFileSync(entry, `import {View} from '@pocketjs/framework/solid/components';\nexport default function App(){return <View class="w-[20] h-[20] animate-app-fade"/>}`);
      const manifest = { $schema: "https://pocketjs.dev/schema/pocket-2.json", name: "aot-test", pocket: 2, id: "dev.test.aot", title: "AOT", version: "1.0.0", engine: { capabilities: { requires: ["text.glyphs.baked"] } }, app: {
        entry: "app.tsx", framework: "solid", aot: true, viewport: { fixed: { logical: [240,160], presentation: "native" } },
        theme: { keyframes: { fade: { from: {opacity: 0}, to: {opacity: 1} } }, animation: { "app-fade": "fade 1s linear" } },
      } };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const resolved = validateAndResolveBuildPlan(manifest, { target: "gba" }, profileRegistry(gba));
      if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
      const first = await compileAot({ plan: resolved.plan, projectRoot: project, manifestPath, outdir: join(project, "out") });
      expect(first.result.program.styles.anims.length).toBeGreaterThan(0);
      expect(first.result.program.styles.anims[0]!.tracks[0]!.segments.at(-1)!.t1).toBe(30);
      expect(() => analyzeAot(entry, { strict: true })).toThrow("animate-app-fade");
      const badPlan = { ...resolved.plan, profileHash: "sha256:" + "00".repeat(32) };
      await expect(compileAot({ plan: badPlan, projectRoot: project, manifestPath, outdir: join(project, "invalid") })).rejects.toThrow("plan/profile hash");
      expect(existsSync(join(project, "invalid"))).toBe(false);
      await expect(compileAot({ plan: resolved.plan, projectRoot: project, manifestPath, outdir: join(project, "missing-wasm"), wasmPath: join(project, "absent.wasm") })).rejects.toThrow("prebuilt layout oracle");
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 120_000);
});
