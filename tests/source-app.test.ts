import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FRAMEWORKS, parseFramework } from "../framework/compiler/jsx-plugin.ts";
import { modelConfiguration, registerApplication, unregisterApplication } from "../microts/compiler/aot-model-config.ts";
import { mountedSourceApp, registerSourceApplication, resolveSourceEntry, sourceApplication, sourceOutputName } from "../tools/source-app.ts";

const root = resolve(import.meta.dir, "..");
const validation = join(root, ".pocket-build/validation/source-app");
mkdirSync(validation, { recursive: true });
const run = mkdtempSync(join(validation, "run-"));
const VIEWPORT = { logical: [480, 272], presentation: "integer-fit" };

/** A host config whose app section is `app`. */
const config = (app: Record<string, unknown>) =>
  `import { defineHostConfig } from "@pocketjs/framework/host-config";\nexport default defineHostConfig({ host: "psp", app: ${JSON.stringify({ viewport: VIEWPORT, ...app })} });\n`;

function project(name: string, files: Record<string, string>): string {
  const directory = join(run, name);
  for (const [relative, value] of Object.entries(files)) {
    const file = join(directory, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  }
  return directory;
}

async function selected(arg: string, projectRoot = root, frameworkFlag?: string) {
  const mounted = mountedSourceApp(arg, root);
  const entry = resolveSourceEntry(mounted, root, projectRoot);
  const app = (await sourceApplication(entry))?.app;
  const framework = parseFramework(frameworkFlag ?? app?.framework, frameworkFlag ? "--framework" : "app.framework");
  return { mounted, entry, app, framework, output: sourceOutputName(entry, root) + FRAMEWORKS[framework].outputSuffix };
}

test("the Vue stock demo selects its .ts mount and its config's framework", async () => {
  const selection = await selected("vue-sfc-lab");
  expect(selection.mounted).toBe("vue-sfc-lab-main");
  expect(selection.entry).toBe(join(root, "apps/vue-sfc-lab/main.ts"));
  expect(selection.framework).toBe("vue-vapor");
  expect(selection.output).toBe("vue-sfc-lab-main.vue-vapor");
  expect(await selected("hero")).toMatchObject({ framework: "solid", output: "hero-main" });
});

test("external source paths preserve the project framework and compiler artifact basename", async () => {
  const directory = project("custom", {
    "pocket.host.config.ts": config({ entry: "src/main.ts", framework: "octane" }),
    "src/main.ts": "export const answer = 42;\n",
  });
  const selection = await selected("src/main.ts", directory);
  expect(selection.mounted).toBe("src/main.ts");
  expect(selection.entry).toBe(join(directory, "src/main.ts"));
  expect(selection.framework).toBe("octane");
  expect(selection.output).toBe("main.octane");
  expect((await selected("src/main.ts", directory, "vue-vapor")).framework).toBe("vue-vapor");
  // The wrapper passes this absolute path to a compiler started from the
  // framework checkout, so its working directory cannot select another file.
  expect(resolveSourceEntry(selection.entry, root, root)).toBe(selection.entry);
});

test("the nearest host config above a source owns it, with the files it imports", async () => {
  const theme = { animation: { pulse: "pulse 1s infinite" } };
  const directory = project("nested", {
    "pocket.host.config.ts": config({ entry: "main.ts", framework: "solid" }),
    "theme.json": JSON.stringify(theme),
    // A second build of the same sources in a subdirectory, as apps/nexus-touch/e7.
    "handheld/pocket.host.config.ts": `import { defineHostConfig } from "@pocketjs/framework/host-config";\nimport theme from "../theme.json" with { type: "json" };\n` +
      `export default defineHostConfig({ host: "psp", app: { entry: "main.ts", framework: "vue-vapor", viewport: ${JSON.stringify(VIEWPORT)}, theme } });\n`,
    "main.ts": "export {};\n",
    "handheld/main.ts": "export {};\n",
  });
  const handheld = await sourceApplication(join(directory, "handheld/main.ts"));
  expect(handheld?.configPath).toBe(join(directory, "handheld/pocket.host.config.ts"));
  expect(handheld?.app).toMatchObject({ framework: "vue-vapor", theme });
  expect(handheld?.dependencies).toEqual(expect.arrayContaining([join(directory, "handheld/pocket.host.config.ts"), join(directory, "theme.json")]));
  expect((await sourceApplication(join(directory, "main.ts")))?.app.framework).toBe("solid");
  // A program config without an app section owns no application.
  const program = project("program", {
    "pocket.host.config.ts": `import { defineHostConfig } from "@pocketjs/framework/host-config";\nexport default defineHostConfig({ host: "psp" });\n`,
    "main.ts": "export {};\n",
  });
  expect(await sourceApplication(join(program, "main.ts"))).toBeUndefined();
});

test("a source's application registers its model settings once", async () => {
  const directory = project("registered", {
    "pocket.host.config.ts": config({ entry: "App.tsx", framework: "solid", aot: true, model: "compiled", recursionLimit: 32 }),
    "App.tsx": "export default function App() { return null; }\n",
    "model.ts": "export {};\n",
  });
  unregisterApplication(directory);
  expect(modelConfiguration(join(directory, "model.ts")).directory).toBeUndefined();
  await registerSourceApplication(join(directory, "model.ts"));
  expect(modelConfiguration(join(directory, "model.ts"))).toEqual({
    mode: "compiled", recursionLimit: 32, tickHz: 60, aot: true, directory, framework: "solid", entry: join(directory, "App.tsx"),
  });
  // A registration the build driver made (from a plan) is not replaced.
  registerApplication({ directory, framework: "solid", aot: true, model: "rust" });
  await registerSourceApplication(join(directory, "model.ts"));
  expect(modelConfiguration(join(directory, "model.ts")).mode).toBe("rust");
  unregisterApplication(directory);
});

test("a source without a config keeps the explicit Solid default", async () => {
  const entry = resolve("/pocketjs-source-app-no-config/main.ts");
  expect(existsSync(dirname(entry))).toBe(false);
  expect(await sourceApplication(entry)).toBeUndefined();
  expect(parseFramework(undefined, "app.framework")).toBe("solid");
});

test("low-level worker builds resolve the worker entry against the config", () => {
  const directory = project("worker-relative", {
    "pocket.host.config.ts": config({ entry: "src/main.ts", framework: "solid", worker: { entry: "worker.ts", nodes: [] } }),
    "src/main.ts": "globalThis.sourceAppWorker = true;\n",
    "worker.ts": "export function turn() {}\n",
  });
  const out = join(directory, "compiled");
  const built = Bun.spawnSync([process.execPath, join(root, "tools/build.ts"), join(directory, "src/main.ts"), `--outdir=${out}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(built.success, built.stdout.toString() + built.stderr.toString()).toBe(true);
  expect(existsSync(join(out, "main.worker.js"))).toBe(true);
  // The UI bundle refuses a worker-domain subpath instead of bundling worker code.
  writeFileSync(join(directory, "src/main.ts"), 'import { io } from "@pocketjs/framework/io";\nvoid io;\n');
  const refused = Bun.spawnSync([process.execPath, join(root, "tools/build.ts"), join(directory, "src/main.ts"), `--outdir=${join(directory, "refused")}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(refused.success).toBe(false);
  expect(refused.stdout.toString() + refused.stderr.toString()).toContain("UI domain cannot import @pocketjs/framework/io");
}, 120_000);

test("compiler outputs match the wrapper selection for Vue and custom projects", async () => {
  const directory = project("compile-custom", {
    "pocket.host.config.ts": config({ entry: "src/main.ts", framework: "octane" }),
    "src/main.ts": "globalThis.customSourceApp = 42;\n",
  });
  for (const [argument, projectRoot] of [["vue-sfc-lab", root], ["src/main.ts", directory]] as const) {
    const selection = await selected(argument, projectRoot);
    const output = join(run, "compiled", selection.output);
    const inputs = join(output, "inputs.json");
    const result = Bun.spawnSync([
      process.execPath, join(root, "tools/build.ts"), selection.entry,
      `--project-root=${projectRoot}`, `--outdir=${output}`, `--inputs-file=${inputs}`,
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.success, result.stdout.toString() + result.stderr.toString()).toBe(true);
    expect(result.stdout.toString()).toContain(`framework=${selection.framework}`);
    expect(existsSync(join(output, selection.output + ".js"))).toBe(true);
    expect(existsSync(join(output, selection.output + ".pak"))).toBe(true);
    const readInputs = JSON.parse(readFileSync(inputs, "utf8")) as string[];
    expect(readInputs).toContain(join(root, "tools/source-app.ts"));
    expect(readInputs).toContain(join(projectRoot === root ? join(root, "apps/vue-sfc-lab") : directory, "pocket.host.config.ts"));
  }
}, 120_000);
