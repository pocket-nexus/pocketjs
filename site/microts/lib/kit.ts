// The playground's UI preview kit, bundled from this checkout into <out>/pocket/:
//
//   compiler-worker.js   the in-browser MicroTS project compiler (kit/compiler.ts)
//   preview.html|js      the preview iframe (kit/preview.ts + an import map)
//   vue.js, solid.js     the Vue Vapor runtime and solid-js
//   fw/*.js              @pocketjs/framework subpaths, code-split so they share module state
//   pocketjs.wasm        the Rust UI core and software rasterizer (bun tools/wasm.ts)
//   fonts/Inter-*.ttf    the fonts the compiler bakes glyphs from
//   kit.json             source commit and file sizes
import type { BunPlugin } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ROOT, SITE } from "./paths.ts";

const KIT = join(SITE, "kit");

// The node-builtin shims site/build.ts uses to bundle @babel/core for the browser.
const SHIMS = join(ROOT, "site/playground/babel-shims/");
const SHIM_MAP: Record<string, string> = { assert: "assert.js", "node:assert": "assert.js", path: "path.js", "node:path": "path.js" };
const SHIM_EMPTY = new Set(
  ["fs", "fs/promises", "os", "module", "url", "util", "zlib", "stream", "tty", "crypto", "v8", "process"].flatMap((m) => [m, `node:${m}`]),
);
const shimPlugin: BunPlugin = {
  name: "node-shims",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (SHIM_MAP[a.path]) return { path: SHIMS + SHIM_MAP[a.path] };
      if (SHIM_EMPTY.has(a.path)) return { path: SHIMS + "empty.js" };
      return undefined;
    });
  },
};
// Babel reads process.* at module-evaluation time, so the shim runs before any bundled import.
const PROCESS_PRELUDE =
  `globalThis.process||=({env:{NODE_ENV:"production"},platform:"browser",arch:"wasm32",` +
  `versions:{node:"20.0.0"},version:"v20.0.0",argv:[],argv0:"",execPath:"",cwd:function(){return"/"},` +
  `chdir:function(){},nextTick:function(f){var a=[].slice.call(arguments,1);` +
  `Promise.resolve().then(function(){f.apply(null,a)})},on:function(){},once:function(){},off:function(){},` +
  `removeListener:function(){},emit:function(){},emitWarning:function(){},exit:function(){},` +
  `hrtime:function(){return[0,0]},browser:true});globalThis.global||=globalThis;\n`;
const DEFINE = { "process.env.NODE_ENV": '"production"', "process.env.BABEL_ENV": '"production"', "process.platform": '"browser"' };

// Framework subpaths the preview import map exposes besides vue-vapor/* and solid/*.
// Host-side providers, build tools and devtools stay out; Octane is not a MicroTS front end.
const ROOT_SUBPATHS = new Set([
  ".", "./animation", "./components", "./lifecycle", "./input", "./clock", "./host", "./effects", "./gesture",
  "./physics", "./kinetics", "./audio", "./display", "./renderer", "./model/tasks", "./model/animation",
  "./virtual-list", "./ime", "./pak", "./text", "./text-layout", "./fonts", "./modality", "./actions",
]);

export async function buildKit(outDir: string, commit: string): Promise<void> {
  const wasm = join(ROOT, "hosts/web/pocketjs.wasm");
  if (!existsSync(wasm)) throw new Error("hosts/web/pocketjs.wasm is missing; run `bun tools/wasm.ts`");
  const OUT = join(outDir, "pocket");
  const sizes: Record<string, number> = {};
  const write = (rel: string, data: string | Uint8Array) => {
    const p = join(OUT, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    sizes[rel] = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  };

  async function bundle(entry: string, out: string, opts: { shims?: boolean; prelude?: string; external?: string[]; define?: Record<string, string> } = {}) {
    const res = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      conditions: ["browser"],
      define: { ...DEFINE, ...opts.define },
      external: opts.external,
      minify: true,
      sourcemap: "none",
      plugins: opts.shims ? [shimPlugin] : [],
    });
    if (!res.success) {
      for (const l of res.logs) console.error(String(l));
      throw new Error(`bundle failed: ${relative(ROOT, entry)}`);
    }
    write(out, (opts.prelude ?? "") + (await res.outputs[0]!.text()));
  }
  const resolve = (spec: string) => Bun.resolveSync(spec, ROOT);

  await bundle(join(KIT, "compiler-worker.ts"), "compiler-worker.js", { shims: true, prelude: PROCESS_PRELUDE });
  // Vue Vapor's DOM helpers target the PocketJS native-tree document, as in site/build.ts.
  await bundle(resolve("vue/dist/vue.runtime-with-vapor.esm-browser.prod.js"), "vue.js", { define: { document: "globalThis.__pocketDocument" } });
  if (!readFileSync(join(OUT, "vue.js"), "utf8").includes("globalThis.__pocketDocument"))
    throw new Error("Vue Vapor runtime does not target the PocketJS document facade");
  {
    const pkgPath = resolve("solid-js/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const browser = pkg.exports?.["."]?.browser?.import ?? pkg.exports?.["."]?.import;
    await bundle(join(dirname(pkgPath), browser), "solid.js");
  }
  // The framework's Solid renderer takes createRenderer from solid-js/universal; solid-js stays shared.
  await bundle(resolve("solid-js/universal"), "solid-universal.js", { external: ["solid-js"] });
  await bundle(join(KIT, "preview.ts"), "preview.js");

  // One entry per vue-vapor/solid subpath in package.json exports, code-split so they share state.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const subpaths: Record<string, string> = {};
  for (const [key, value] of Object.entries<any>(pkg.exports ?? {})) {
    if (!/^\.\/(vue-vapor|solid)(\/|$)/.test(key) && !ROOT_SUBPATHS.has(key)) continue;
    const file = typeof value === "string" ? value : value.default;
    if (typeof file === "string" && file.endsWith(".ts")) subpaths[key === "." ? "@pocketjs/framework" : "@pocketjs/framework/" + key.slice(2)] = file;
  }
  const frameworkPlugin: BunPlugin = {
    name: "microts-kit-framework",
    setup(b) {
      b.onResolve({ filter: /styles\.generated(\.ts)?$/ }, () => ({ path: join(KIT, "styles-generated.ts") }));
      b.onResolve({ filter: /^solid-js\/web$/ }, () => ({ path: join(KIT, "solid-web.ts") }));
    },
  };
  const fw = await Bun.build({
    entrypoints: [...new Set(Object.values(subpaths))].map((f) => join(ROOT, f)),
    root: join(ROOT, "framework/src"),
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    sourcemap: "none",
    conditions: ["browser"],
    external: ["vue", "solid-js"],
    define: DEFINE,
    naming: { entry: "[dir]/[name].[ext]", chunk: "chunk-[hash].[ext]" },
    plugins: [frameworkPlugin],
  });
  if (!fw.success) {
    for (const l of fw.logs) console.error(String(l));
    throw new Error("framework bundle failed");
  }
  const entryOut: Record<string, string> = {};
  for (const o of fw.outputs) {
    const rel = "fw/" + relative(".", o.path).replace(/^\.\//, "");
    write(rel, await o.text());
    if (o.kind === "entry-point") entryOut[rel.replace(/^fw\//, "").replace(/\.js$/, ".ts")] = rel;
  }
  const imports: Record<string, string> = { vue: "./vue.js", "solid-js": "./solid.js", "solid-js/universal": "./solid-universal.js" };
  for (const [spec, file] of Object.entries(subpaths)) {
    const out = entryOut[file.replace(/^\.\/framework\/src\//, "")];
    if (!out) throw new Error(`no bundle for ${spec} (${file})`);
    imports[spec] = "./" + out;
  }

  write("pocketjs.wasm", readFileSync(wasm));
  for (const f of ["Inter-Regular.ttf", "Inter-Bold.ttf", "LICENSE.txt"]) write(`fonts/${f}`, readFileSync(join(ROOT, "assets/fonts", f)));
  write("LICENSE.txt", readFileSync(join(ROOT, "LICENSE")));
  write(
    "preview.html",
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MicroTS preview</title>
<script type="importmap">${JSON.stringify({ imports }, null, 1)}</script>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  body{display:grid;place-items:center}
  canvas{display:block;outline:none}
</style>
</head>
<body>
<canvas id="screen" tabindex="0" width="480" height="272"></canvas>
<script type="module" src="./preview.js"></script>
</body>
</html>
`,
  );
  write("kit.json", JSON.stringify({ repo: "pocket-nexus/pocketjs", commit, version: pkg.version, imports, sizes }, null, 2) + "\n");
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  console.log(`kit: ${Object.keys(sizes).length} files, ${(total / 1024 / 1024).toFixed(2)} MiB → ${relative(ROOT, OUT)}/`);
}
