import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { compileAot } from "../tools/aot-compile.ts";
import { exportAotProfile } from "../tools/build/aot-profile.ts";
import { resolveAppPlan } from "../framework/compiler/app-plan.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";
import { POCKET_PROFILES } from "../hosts/index.ts";
import { analyzeAot } from "../microts/compiler/aot-build.ts";
const gba = POCKET_PROFILES["gba"];

const ROOT = resolve(import.meta.dir, "..");
const RUNS = resolve(ROOT, ".pocket-build/validation/aot-compile");
mkdirSync(RUNS, { recursive: true });
function temporary() { return mkdtempSync(join(RUNS, "test-")); }
const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(path, item.name)) : [join(path, item.name)]);

describe("AOT application artifact", () => {
  test("compile --aot resolves an AOT application and emits input dependencies without a package", async () => {
    const directory = temporary();
    try {
      const source = resolve(ROOT, "apps/ipodnano-hero/pocket.host.config.ts");
      const out = join(directory, "generated"), dependencyFile = join(directory, "generated.d");
      const child = Bun.spawn([process.execPath, resolve(ROOT, "tools/pocket.ts"), "compile", "--aot", "--target", "ipodnano", "--config", source, "--project-root", ROOT, "--plan-dir", join(directory, "plans"), "--out", out, "--depfile", dependencyFile], { cwd: ROOT, env: { ...process.env, PATH: "" }, stdout: "pipe", stderr: "pipe" });
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ status, signal: child.signalCode, stderr }, stdout).toEqual({ status: 0, signal: null, stderr: "" });
      expect(existsSync(join(out, "include.rs"))).toBe(true);
      expect(files(out).some(file => /\.(?:pocket|js)$/.test(file))).toBe(false);
      const dependencies = readFileSync(dependencyFile, "utf8");
      expect(dependencies).toContain(source);
      expect(dependencies).toContain(resolve(ROOT, "apps/ipodnano-hero/app.ts"));
      expect(dependencies).toContain(resolve(ROOT, "hosts/ipodnano/pocket.host.json"));
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
        // The program build exports the profile the compiler recorded for these sources.
        const exported = join(directory, `${target}-profile`);
        const hashBytes = dependencies.profileHash.slice(7).match(/../g).map((byte: string) => Number.parseInt(byte, 16)).join(", ");
        expect(readFileSync(exportAotProfile(dependencies, exported), "utf8")).toContain(`pub const PROFILE_HASH: [u8; 32] = [${hashBytes}];`);
        expect(() => exportAotProfile({ ...dependencies, profileHash: `sha256:${"0".repeat(64)}` }, exported)).toThrow("compiled for profile");
        const layers = JSON.parse(readFileSync(join(out, "layers.json"), "utf8"));
        // gba-hero states app.tickHz 30; ipodnano-hero runs at the default 60.
        expect(layers.tickRate).toBe(target === "gba" ? 30 : 60);
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
      const app = { id: "dev.test.vue-aot", title: "Vue AOT", version: "1.0.0", features: ["text.glyphs.baked"],
        entry: "main.ts", framework: "vue-vapor", aot: true, viewport: { fixed: { logical: [240,160], presentation: "native" } },
      } as const;
      const configPath = join(project, "pocket.host.config.ts");
      writeFileSync(configPath, `import { defineHostConfig } from "@pocketjs/framework/host-config";\nexport default defineHostConfig({ host: "gba", app: ${JSON.stringify(app)} });\n`);
      const resolved = resolveAppPlan(app, { target: "gba" }, profileRegistry(gba));
      if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
      const result = await compileAot({ plan: resolved.plan, projectRoot: project, configPath, outdir: join(project, "out") });
      expect(result.result.entry).toBe(join(project, "App.vue"));
      expect(result.dependencies).toContain(join(project, "App.d.ts"));
      expect(result.dependencies).toContain(join(project, "main.ts"));
      expect(result.dependencies).toContain(configPath);
      expect(result.files).toContain(join(project, "out/include.rs"));
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 120_000);

  test("custom app theme and application tick rate are isolated across compilations", async () => {
    const project = temporary();
    try {
      const entry = join(project, "app.tsx");
      writeFileSync(entry, `import {View} from '@pocketjs/framework/solid/components';\nexport default function App(){return <View class="w-[20] h-[20] animate-app-fade"/>}`);
      const app = { id: "dev.test.aot", title: "AOT", version: "1.0.0", features: ["text.glyphs.baked"],
        entry: "app.tsx", framework: "solid", aot: true, tickHz: 30, viewport: { fixed: { logical: [240,160], presentation: "native" } },
        theme: { keyframes: { fade: { from: {opacity: 0}, to: {opacity: 1} } }, animation: { "app-fade": "fade 1s linear" } },
      } as const;
      // Without a config path the plan's settings are registered for the entry's directory.
      const resolved = resolveAppPlan(app, { target: "gba" }, profileRegistry(gba));
      if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
      const first = await compileAot({ plan: resolved.plan, projectRoot: project, outdir: join(project, "out") });
      expect(first.result.program.styles.anims.length).toBeGreaterThan(0);
      expect(first.result.program.styles.anims[0]!.tracks[0]!.segments.at(-1)!.t1).toBe(30);
      expect(() => analyzeAot(entry, { strict: true })).toThrow("animate-app-fade");
      await expect(compileAot({ plan: resolved.plan, projectRoot: project, outdir: join(project, "missing-wasm"), wasmPath: join(project, "absent.wasm") })).rejects.toThrow("prebuilt layout oracle");
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 120_000);

  // Solid views report the class string, Vue templates the class attribute.
  test.each([
    { framework: "solid", entry: "main.tsx", view: "app.tsx", wobble: "app.tsx:7:17" },
    { framework: "vue-vapor", entry: "main.ts", view: "App.vue", wobble: "App.vue:9:11" },
  ] as const)("the $framework guest build and compile --aot admit the same class literals under the app theme", async ({ framework, entry, view, wobble }) => {
    const project = temporary();
    try {
      writeFileSync(join(project, "pocket.host.json"), JSON.stringify({
        format: "pocket-host/2", id: "test-aot-theme", platform: "esp-idf", form: "takeover", cadences: [30],
        display: { logicalViewports: [[240, 240]], presentations: ["native"], rasterDensity: 1, animation: "repaint" },
        panel: { primary: [240, 240] }, capabilities: ["input.buttons", "text.glyphs.baked"],
      }));
      const app = { id: "dev.test.aot-theme", title: "AOT theme", version: "1.0.0", entry, output: "theme", framework,
        viewport: { logical: [240, 240], presentation: "native" }, features: ["input.buttons", "text.glyphs.baked"], aot: true, model: "compiled",
        theme: { keyframes: { blink: { "0%,49.99%": { opacity: 1 }, "50%,100%": { opacity: 0 } } }, animation: { blink: "blink 1s linear infinite" } } };
      writeFileSync(join(project, "pocket.host.config.ts"), `import { defineHostConfig } from "@pocketjs/framework/host-config";\nexport default defineHostConfig({ host: "./pocket.host.json", app: ${JSON.stringify(app)} });\n`);
      const source = (extra: string) => framework === "solid" ? `import { Text, View } from "@pocketjs/framework/solid/components";
import { count } from "./app";
export default function App() {
  return <View class="w-full h-full">
    <View class="w-8 h-8 animate-spin" />
    <View class="w-8 h-8 animate-blink" />${extra}
    <Text class="text-lg">{count()}</Text>
  </View>;
}
` : `<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { count } from "./App";
</script>
<template>
  <View class="w-full h-full">
    <View class="w-8 h-8 animate-spin" />
    <View class="w-8 h-8 animate-blink" />${extra}
    <Text class="text-lg">{{ count }}</Text>
  </View>
</template>
`;
      if (framework === "solid") {
        writeFileSync(join(project, "main.tsx"), `import { mount } from "@pocketjs/framework/solid";\nimport App from "./app.tsx";\nmount(() => <App />);\n`);
        writeFileSync(join(project, "app.ts"), `import { createSignal } from "solid-js";\nimport type { i32 } from "@pocketjs/framework/solid/std";\nexport const [count, setCount] = createSignal<i32>(0);\n`);
      } else {
        writeFileSync(join(project, "main.ts"), `import App from "./App.vue";\nexport default App;\n`);
        writeFileSync(join(project, "App.ts"), `import { ref } from "vue";\nimport type { i32 } from "@pocketjs/framework/vue-vapor/std";\nexport const count = ref<i32>(0);\n`);
      }
      const compile = async (...args: string[]) => {
        const child = Bun.spawn([process.execPath, resolve(ROOT, "tools/pocket.ts"), "compile", "--config", "pocket.host.config.ts", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
        const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return { status, output: (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, "") };
      };
      const guest = ["--output", "out/app.pkb"], aot = ["--aot", "--out", "gen"];
      writeFileSync(join(project, view), source(""));
      const built = await compile(...guest);
      expect(built.status, built.output).toBe(0);
      expect(built.output).toContain("2 baked timeline(s)");
      const generated = await compile(...aot);
      expect(generated.status, generated.output).toBe(0);
      // An animation no theme defines is unsupported in both builds, reported at its literal.
      writeFileSync(join(project, view), source(`\n    <View class="w-8 h-8 animate-wobble" />`));
      for (const args of [guest, aot]) {
        const rejected = await compile(...args);
        expect(rejected.status).not.toBe(0);
        expect(rejected.output).toContain(`${wobble}: error: Unsupported class literal "w-8 h-8 animate-wobble"`);
      }
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 120_000);
});
