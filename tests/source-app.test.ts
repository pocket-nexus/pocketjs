import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FRAMEWORKS, parseFramework } from "../framework/compiler/jsx-plugin.ts";
import { mountedSourceApp, resolveSourceEntry, sourceAppContent, sourceOutputName } from "../tools/source-app.ts";

const root = resolve(import.meta.dir, "..");
const validation = join(root, ".pocket-build/validation/source-app");
mkdirSync(validation, { recursive: true });
const run = mkdtempSync(join(validation, "run-"));

function project(name: string, files: Record<string, unknown>): string {
  const directory = join(run, name);
  for (const [relative, value] of Object.entries(files)) {
    const file = join(directory, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  }
  return directory;
}

function selected(arg: string, projectRoot = root, frameworkFlag?: string) {
  const mounted = mountedSourceApp(arg, root);
  const entry = resolveSourceEntry(mounted, root, projectRoot);
  const app = sourceAppContent(entry, { frameworkRoot: root, projectRoot });
  const framework = parseFramework(frameworkFlag ?? app.framework, frameworkFlag ? "--framework" : "pocket.app.json");
  return { mounted, entry, app, framework, output: sourceOutputName(entry, root) + FRAMEWORKS[framework].outputSuffix };
}

test("the Vue stock demo selects its .ts mount and manifest framework", () => {
  const selection = selected("vue-sfc-lab");
  expect(selection.mounted).toBe("vue-sfc-lab-main");
  expect(selection.entry).toBe(join(root, "apps/vue-sfc-lab/main.ts"));
  expect(selection.framework).toBe("vue-vapor");
  expect(selection.output).toBe("vue-sfc-lab-main.vue-vapor");
  expect(selected("hero")).toMatchObject({ framework: "solid", output: "hero-main" });
});

test("external source paths preserve the project framework and compiler artifact basename", () => {
  const directory = project("custom", {
    "pocket.app.json": { app: { entry: "src/main.ts", framework: "octane" } },
    "src/main.ts": "export const answer = 42;\n",
  });
  const selection = selected("src/main.ts", directory);
  expect(selection.mounted).toBe("src/main.ts");
  expect(selection.entry).toBe(join(directory, "src/main.ts"));
  expect(selection.framework).toBe("octane");
  expect(selection.output).toBe("main.octane");
  expect(selected("src/main.ts", directory, "vue-vapor").framework).toBe("vue-vapor");
  // The wrapper passes this absolute path to a compiler started from the
  // framework checkout, so its working directory cannot select another file.
  expect(resolveSourceEntry(selection.entry, root, root)).toBe(selection.entry);
});

test("entry matching chooses variant content and tracks every examined manifest", () => {
  const theme = { animation: { pulse: "pulse 1s infinite" } };
  const directory = project("variants", {
    "pocket.app.json": { app: { entry: "main.ts", framework: "solid" } },
    "pocket.app.handheld.json": { app: { entry: "handheld/main.ts", framework: "vue-vapor", theme } },
    "pocket.host.json": { format: "pocket-host/2" },
    "main.ts": "export {};\n",
    "handheld/main.ts": "export {};\n",
  });
  const reads: string[] = [];
  const app = sourceAppContent(join(directory, "handheld/main.ts"), {
    frameworkRoot: root, projectRoot: directory, onRead: path => reads.push(path),
  });
  expect(app).toMatchObject({ framework: "vue-vapor", theme });
  expect(reads.sort()).toEqual([join(directory, "pocket.app.handheld.json"), join(directory, "pocket.app.json")]);
  writeFileSync(join(directory, "pocket.app.other.json"), JSON.stringify({ app: { entry: "handheld/main.ts", framework: "solid" } }));
  expect(() => sourceAppContent(join(directory, "handheld/main.ts"), { frameworkRoot: root, projectRoot: directory }))
    .toThrow("manifests disagree on application content");
});

test("a source without a manifest keeps the explicit Solid default", () => {
  const entry = resolve("/pocketjs-source-app-no-manifest/main.ts");
  expect(existsSync(dirname(entry))).toBe(false);
  const app = sourceAppContent(entry, { frameworkRoot: root, projectRoot: dirname(entry) });
  expect(app).toEqual({});
  expect(parseFramework(app.framework, "pocket.app.json")).toBe("solid");
});

test("low-level worker builds use the entry's matched manifest root", () => {
  const directory = project("worker-relative", {
    "pocket.app.json": { app: { entry: "src/main.ts", framework: "solid" }, domains: { worker: { entry: "worker.ts", nodes: [] } } },
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
  writeFileSync(join(directory, "pocket.app.other.json"), JSON.stringify({ app: { entry: "src/main.ts", framework: "solid" }, domains: { worker: { entry: "other.ts", nodes: [] } } }));
  expect(() => sourceAppContent(join(directory, "src/main.ts"), { frameworkRoot: root, projectRoot: root })).toThrow(/manifests disagree/);
}, 120_000);

test("compiler outputs match the wrapper selection for Vue and custom projects", () => {
  const directory = project("compile-custom", {
    "pocket.app.json": { app: { entry: "src/main.ts", framework: "octane" } },
    "src/main.ts": "globalThis.customSourceApp = 42;\n",
  });
  for (const [argument, projectRoot] of [["vue-sfc-lab", root], ["src/main.ts", directory]] as const) {
    const selection = selected(argument, projectRoot);
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
    expect(readInputs).toContain(join(projectRoot === root ? join(root, "apps/vue-sfc-lab") : directory, "pocket.app.json"));
  }
}, 120_000);
