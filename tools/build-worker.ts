import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { workerDeclarationSchema, type WorkerDeclaration } from "../contracts/spec/worker.ts";
import { SUBPATHS, resolvesIn } from "../framework/compiler/subpaths.ts";
import { validateSchema, type ContractDiagnostic } from "../framework/src/manifest/schema.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** The worker import set: the subpath registry rows whose domains include "worker". */
const modules: Record<string, string> = Object.fromEntries(Object.entries(SUBPATHS).flatMap(([name, decl]) => {
  if (!resolvesIn(decl, "worker")) return [];
  if (typeof decl.file !== "string") throw new Error(`subpaths: worker row "${name}" needs one file for every framework`);
  return [[name, decl.file]];
}));

/** One classic script for one independently owned runtime. */
export async function buildWorker(options: {
  declaration: WorkerDeclaration;
  projectRoot: string;
  outdir: string;
  output: string;
}) {
  const entry = resolve(options.projectRoot, options.declaration.entry);
  const wrapper = join(options.outdir, ".entries", `${options.output}.worker.ts`);
  mkdirSync(dirname(wrapper), { recursive: true });
  // The scheduler module binds itself to the host when it evaluates, so it
  // precedes the application entry: the entry's top-level code can start
  // async tasks and publish at once. The declaration reaches it as a define.
  writeFileSync(wrapper, `import ${JSON.stringify(join(ROOT, modules.worker))};\n` +
    `import ${JSON.stringify(entry)};\n`);
  const result = await Bun.build({
    // The wrapper exports nothing, so ESM bundling produces a classic script.
    // An outer IIFE makes QuickJS retain a second copy of the entire source
    // for Function.prototype.toString, increasing the embedded startup peak.
    entrypoints: [wrapper], target: "browser", format: "esm", outdir: options.outdir,
    naming: `${options.output}.worker.js`, minify: true, metafile: true,
    banner: '"use strict";',
    define: { __POCKET_DOMAIN__: '"worker"', __POCKET_WORKER_DECLARATION__: JSON.stringify(options.declaration), "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "worker-domain", setup(builder) {
      builder.onResolve({ filter: /^@pocketjs\/framework(?:\/.*)?$/ }, args => {
        const subpath = args.path.slice("@pocketjs/framework/".length);
        const file = modules[subpath];
        if (!file) throw new Error(`Worker domain cannot import ${args.path}: ${subpath in SUBPATHS ? "the subpath resolves only in the UI domain (app.entry)" : "no such framework subpath"}`);
        return { path: join(ROOT, file) };
      });
      builder.onResolve({ filter: /^(solid-js|vue|octane)(\/|$)/ }, args => {
        throw new Error(`Worker domain cannot import UI framework ${args.path}`);
      });
    } }],
  });
  if (!result.success) throw new AggregateError(result.logs, `Worker build failed: ${entry}`);
  const bundle = result.outputs.find(output => output.kind === "entry-point");
  if (!bundle) throw new Error(`Worker build produced no entry: ${entry}`);
  const source = await bundle.text();
  const scanned = new Bun.Transpiler({ loader: "js" }).scan(source);
  if (scanned.imports.length || scanned.exports.length) throw new Error("Worker bundle must have no runtime imports or exports");
  // Check script syntax without executing it. This also rejects top-level
  // await, which a module bundler can otherwise preserve in its output.
  try { new Script(source, { filename: `${options.output}.worker.js` }); }
  catch (error) { throw new Error("Worker bundle must execute as a classic script", { cause: error }); }
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rootIndex = args.findIndex(arg => arg === "--project-root");
  const projectRootOption = rootIndex >= 0 ? args.splice(rootIndex, 2)[1] : undefined;
  const [manifestPath, outdir = ".pocket-build/worker"] = args;
  if (!manifestPath) throw new Error("usage: bun tools/build-worker.ts <pocket.json> [outdir] [--project-root <dir>]");
  const path = resolve(manifestPath), manifest = await Bun.file(path).json();
  if (!manifest.domains?.worker) throw new Error("Manifest has no domains.worker entry");
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(manifest.domains.worker, workerDeclarationSchema, "/domains/worker", diagnostics);
  if (diagnostics.length) throw new Error(diagnostics.map(item => `${item.path}: ${item.message}`).join("\n"));
  const output = manifest.app.output;
  if (typeof output !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(output)) throw new Error("Worker output requires app.output without path separators");
  // Entry paths are relative to the project root; the default matches `pocket check`.
  await buildWorker({ declaration: manifest.domains.worker, projectRoot: resolve(projectRootOption ?? dirname(path)), outdir: resolve(outdir), output });
}
