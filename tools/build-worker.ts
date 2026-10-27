import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { workerDeclarationSchema, type WorkerDeclaration } from "../contracts/spec/worker.ts";
import { validateSchema, type ContractDiagnostic } from "../framework/src/manifest/schema.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const modules: Record<string, string> = {
  worker: "framework/src/worker.ts", io: "framework/src/io.ts", "io/i2c": "framework/src/io/i2c.ts",
  clock: "framework/src/clock.ts", fs: "framework/src/fs-api.ts", db: "framework/src/db-api.ts",
};

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
  writeFileSync(wrapper, `import { bindWorker } from ${JSON.stringify(join(ROOT, modules.worker))};\n` +
    `import { turn } from ${JSON.stringify(entry)};\n` +
    `bindWorker(turn, ${JSON.stringify(options.declaration)});\n`);
  const result = await Bun.build({
    // The wrapper exports nothing, so ESM bundling produces a classic script.
    // An outer IIFE makes QuickJS retain a second copy of the entire source
    // for Function.prototype.toString, increasing the embedded startup peak.
    entrypoints: [wrapper], target: "browser", format: "esm", outdir: options.outdir,
    naming: `${options.output}.worker.js`, minify: true, metafile: true,
    banner: '"use strict";',
    define: { __POCKET_WORKER_DECLARATION__: JSON.stringify(options.declaration), "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "worker-domain", setup(builder) {
      builder.onResolve({ filter: /^@pocketjs\/framework(?:\/.*)?$/ }, args => {
        const subpath = args.path.slice("@pocketjs/framework/".length);
        const file = modules[subpath];
        if (!file) throw new Error(`Worker domain cannot import ${args.path}`);
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
  const [manifestPath, outdir = ".pocket-build/worker"] = process.argv.slice(2);
  if (!manifestPath) throw new Error("usage: bun tools/build-worker.ts <pocket.json> [outdir]");
  const path = resolve(manifestPath), manifest = await Bun.file(path).json();
  if (!manifest.app?.worker) throw new Error("Manifest has no app.worker entry");
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(manifest.app.worker, workerDeclarationSchema, "/app/worker", diagnostics);
  if (diagnostics.length) throw new Error(diagnostics.map(item => `${item.path}: ${item.message}`).join("\n"));
  const output = manifest.app.output ?? manifest.name;
  if (typeof output !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(output)) throw new Error("Worker output requires app.output or name without path separators");
  await buildWorker({ declaration: manifest.app.worker, projectRoot: dirname(path), outdir: resolve(outdir), output });
}
