// site/build.ts — the pocketjs.dev static-site generator.
//
//   bun site/build.ts            # -> site/dist/  (the deployable tree)
//
// Produces:
//   /pg/runtime.js        the ONE PocketJS runtime bundle (import-map target)
//   /pg/compiler.js       the in-browser build pipeline (babel+tailwind+bake)
//   /pg/playground.bundle.js  CodeMirror editor + host loop + glue
//   /pg/pocketjs.wasm     Rust core + software rasterizer
//   /pg/fonts/*.ttf       Inter (the browser font baker fetches these)
//   /demo-assets/*        demo images (the browser image baker fetches these)
//   /pg/demos.json        editable single-file demos (name/title/source)
//   /playground/          the live editor page
//   /docs/*, /index.html  rendered from site/content (added below)

import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { marked } from "marked";
import { createHighlighter } from "shiki";
import {
  propsHelperCode,
  propsHelperId,
  ssrHelperCode,
  ssrHelperId,
  vaporHelperCode,
  vaporHelperId,
  vdomHelperCode,
  vdomHelperId,
} from "@vue-jsx-vapor/runtime/raw";
import {
  ICON_LINKS,
  OG_IMAGE_URL,
  SITE_DESC,
  SITE_TITLE,
  SITE_URL,
  injectSiteFooterDescription,
  renderPage,
} from "./templates.ts";
import { BLOG_POSTS, DOC_NAV, type DocSection } from "./nav.ts";
import {
  assertDocDemoBuilt,
  findDocDemoDirectives,
  resolveDocDemo,
  type DocDemo,
} from "./doc-demos.ts";
import { emitSingleLodStagePackage } from "./stage-package.ts";
import { renderHomeShowcase } from "./home-showcase.ts";
import { SHOWCASE_APPS } from "./showcase.ts";

const ROOT = new URL("..", import.meta.url).pathname; // repo root
const SITE = ROOT + "site/";
const OUT = SITE + "dist/";
const SHIMS = SITE + "playground/babel-shims/";

const write = (rel: string, data: string | Uint8Array) => {
  const p = OUT + rel;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};
const copy = (from: string, toRel: string) => {
  const p = OUT + toRel;
  mkdirSync(dirname(p), { recursive: true });
  cpSync(from, p, { recursive: true });
};

// --- node-builtin shims: let @babel/core + preset-solid bundle for the browser
const SHIM_MAP: Record<string, string> = { assert: "assert.js", "node:assert": "assert.js", path: "path.js", "node:path": "path.js" };
const SHIM_EMPTY = new Set([
  "fs", "node:fs", "fs/promises", "node:fs/promises", "os", "node:os", "module", "node:module",
  "url", "node:url", "util", "node:util", "zlib", "node:zlib", "stream", "node:stream",
  "tty", "node:tty", "crypto", "node:crypto", "v8", "node:v8", "process", "node:process",
]);
const shimPlugin: import("bun").BunPlugin = {
  name: "node-shims",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.path === "@vue-jsx-vapor/compiler-rs-wasm32-wasi") {
        return { path: SITE + "playground/vue-vapor-wasi.ts" };
      }
      if (SHIM_MAP[a.path]) return { path: SHIMS + SHIM_MAP[a.path] };
      if (SHIM_EMPTY.has(a.path)) return { path: SHIMS + "empty.js" };
      return undefined;
    });
  },
};

// octane 0.1.26's package root re-exports compile() from compile.js while the
// package is marked side-effect free. Bun 1.3.14 can retain the re-export
// binding but prune its declaration in a browser bundle. Resolve the browser
// compiler straight to the owning module; normal Bun/Node consumers keep using
// the public `octane/compiler` subpath in source.
const octaneBrowserCompilerPlugin: import("bun").BunPlugin = {
  name: "octane-browser-compiler",
  setup(b) {
    b.onResolve({ filter: /^octane\/compiler$/ }, () => {
      const packageDir = dirname(Bun.resolveSync("octane/package.json", ROOT));
      return { path: join(packageDir, "dist/compiler/compile.js") };
    });
  },
};

// A `process` shim, prepended before any bundled import runs (babel reads the
// global process.* at module-eval time — a define/import shim is too late).
const PROCESS_PRELUDE =
  `globalThis.process||=({env:{NODE_ENV:"production"},platform:"browser",arch:"wasm32",` +
  `versions:{node:"20.0.0"},version:"v20.0.0",argv:[],argv0:"",execPath:"",cwd:function(){return"/"},` +
  `chdir:function(){},nextTick:function(f){var a=[].slice.call(arguments,1);` +
  `Promise.resolve().then(function(){f.apply(null,a)})},on:function(){},once:function(){},off:function(){},` +
  `removeListener:function(){},emit:function(){},emitWarning:function(){},exit:function(){},` +
  `hrtime:function(){return[0,0]},browser:true});globalThis.global||=globalThis;\n`;

// Vue Vapor's DOM helpers must target PocketJS's native-tree facade, not the
// embedding playground page. Native app builds apply this same define across
// the whole guest bundle in tools/build.ts; the site's split Vue runtime and
// JSX helper bundles need it independently.
const VUE_VAPOR_DOCUMENT_DEFINE = {
  document: "globalThis.__pocketDocument",
} as const;

async function bundle(
  entry: string,
  outfile: string,
  opts: {
    shims?: boolean;
    prelude?: string;
    external?: string[];
    plugins?: import("bun").BunPlugin[];
  } = {},
) {
  const res = await Bun.build({
    entrypoints: [SITE + entry],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"', "process.env.BABEL_ENV": '"production"', "process.platform": '"browser"' },
    external: opts.external,
    minify: true,
    sourcemap: "none",
    plugins: [...(opts.shims ? [shimPlugin] : []), ...(opts.plugins ?? [])],
  });
  if (!res.success) {
    for (const l of res.logs) console.error(String(l));
    throw new Error(`bundle failed: ${entry}`);
  }
  const code = (opts.prelude ?? "") + (await res.outputs[0].text());
  write(outfile, code);
  console.log(`  ${outfile}  (${(code.length / 1024).toFixed(0)} KiB)`);
}

async function bundleSolid(outfile: string) {
  const packageJsonPath = Bun.resolveSync("solid-js/package.json", ROOT);
  const packageDir = dirname(packageJsonPath);
  const packageJson = await Bun.file(packageJsonPath).json() as {
    exports?: { "."?: { browser?: { import?: string }; import?: string } };
  };
  const browserEntry = packageJson.exports?.["."]?.browser?.import ?? packageJson.exports?.["."]?.import;
  if (!browserEntry) throw new Error("solid-js browser entry not found");
  const entry = join(packageDir, browserEntry);
  const res = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    sourcemap: "none",
  });
  if (!res.success) {
    for (const l of res.logs) console.error(String(l));
    throw new Error("bundle failed: solid-js");
  }
  const code = await res.outputs[0].text();
  write(outfile, code);
  console.log(`  ${outfile}  (${(code.length / 1024).toFixed(0)} KiB)`);
}

async function bundleSolidUniversal(outfile: string) {
  const entry = Bun.resolveSync("solid-js/universal", ROOT);
  const res = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    external: ["solid-js"],
    minify: true,
    sourcemap: "none",
  });
  if (!res.success) {
    for (const l of res.logs) console.error(String(l));
    throw new Error("bundle failed: solid-js/universal");
  }
  const code = await res.outputs[0].text();
  write(outfile, code);
  console.log(`  ${outfile}  (${(code.length / 1024).toFixed(0)} KiB)`);
}

async function bundleVueVapor(outfile: string) {
  const entry = Bun.resolveSync("vue/dist/vue.runtime-with-vapor.esm-browser.prod.js", ROOT);
  const res = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    conditions: ["browser"],
    define: {
      "process.env.NODE_ENV": '"production"',
      ...VUE_VAPOR_DOCUMENT_DEFINE,
    },
    minify: true,
    sourcemap: "none",
  });
  if (!res.success) {
    for (const l of res.logs) console.error(String(l));
    throw new Error("bundle failed: vue-vapor");
  }
  const code = await res.outputs[0].text();
  if (!code.includes("globalThis.__pocketDocument")) {
    throw new Error("Vue Vapor browser runtime does not target the PocketJS document facade");
  }
  write(outfile, code);
  console.log(`  ${outfile}  (${(code.length / 1024).toFixed(0)} KiB)`);
}

function patchVaporHelperCode(code: string): string {
  const patched = code.replace(
    `if (i && i.appContext.vapor && p === "__vapor") {
          return true;
        }
        return Reflect.get`,
    `if (i && i.appContext.vapor && p === "__vapor") {
          return true;
        }
        if (i && i.appContext.vapor && p === "inheritAttrs") {
          return false;
        }
        return Reflect.get`,
  );
  return new Bun.Transpiler({
    loader: "js",
    define: VUE_VAPOR_DOCUMENT_DEFINE,
  }).transformSync(patched);
}

function writeVueVaporHelpers(): void {
  const helpers = new Map([
    [propsHelperId, propsHelperCode],
    [vdomHelperId, vdomHelperCode],
    [vaporHelperId, vaporHelperCode],
    [ssrHelperId, ssrHelperCode],
  ]);
  for (const [id, code] of helpers) {
    const name = id.split("/").pop();
    if (!name) continue;
    const isVaporHelper = id === vaporHelperId;
    const output = isVaporHelper ? patchVaporHelperCode(code) : code;
    if (isVaporHelper && !output.includes("globalThis.__pocketDocument")) {
      throw new Error("Vue Vapor JSX helper does not target the PocketJS document facade");
    }
    write(`pg/vue-jsx-vapor/${name}.js`, output);
  }
  console.log("  pg/vue-jsx-vapor/*  (4 helpers)");
}

function writeStaticHeaders(): void {
  write(
    "_headers",
    `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
`,
  );
}

// Docs slugs that were retired by merging their page into the one that already
// owned the subject. The Worker serves site/dist with not_found_handling set to
// the 404 page (site/wrangler.jsonc), so without these a bookmark to a retired
// slug dies instead of landing on its successor.
const RETIRED_DOC_SLUGS: [from: string, to: string][] = [
  ["/docs/concepts/", "/docs/architecture/"],
  ["/docs/tailwind/", "/docs/styling/"],
  ["/docs/net/", "/docs/api/"],
];

function writeStaticRedirects(): void {
  const lines = RETIRED_DOC_SLUGS.map(([from, to]) => `${from} ${to} 301`);
  write("_redirects", lines.join("\n") + "\n");
  console.log(`  _redirects  (${lines.length} retired docs slugs)`);
}

// --- editable demos (mostly single-file; gallery inlines generated tile data)
type SpriteMeta = Record<string, { cols: number; rows: number; frames: number; step: number; psm?: number }>;
type DemoVariant = { framework: "solid" | "vue-vapor" | "octane"; source: string; spriteMeta?: SpriteMeta };
type DemoEntry = { name: string; title: string; variants: DemoVariant[] };

function inlinePlaygroundImports(name: string, source: string): string | null {
  if (name === "launcher") {
    const registryPath = ROOT + "apps/launcher/registry.generated.ts";
    const registrySource = readFileSync(registryPath, "utf8");
    const registryStart = registrySource.indexOf("export const REGISTRY");
    if (registryStart < 0) throw new Error("launcher registry has no REGISTRY export");
    const registry = registrySource.slice(registryStart).replace(/^export\s+/gm, "");
    const withDefaultRegistry = source.replace(
      "export default function Launcher(props: LauncherProps) {",
      "export default function Launcher(props: LauncherProps = { registry: REGISTRY }) {",
    );
    if (withDefaultRegistry === source) {
      throw new Error("launcher Playground wrapper could not supply its registry");
    }
    return registry + "\n" + withDefaultRegistry;
  }
  if (!/from\s+["']\.\.?\//.test(source)) return source;
  if (name === "gallery") {
    const tilesPath = ROOT + "apps/gallery/tiles.ts";
    const tiles = readFileSync(tilesPath, "utf8").replace(/^export\s+/gm, "");
    return source.replace(
      /import\s+\{\s*GALLERY_PAGES,\s*TILES_PER_PAGE,\s*TILE_SRCS\s*\}\s+from\s+["']\.\/tiles\.ts["'];\n?/,
      tiles + "\n",
    );
  }
  return null;
}

function demoSpriteMeta(name: string): SpriteMeta | undefined {
  const path = ROOT + "apps/" + name + "/sprites.json";
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as SpriteMeta;
}

function demoManifest() {
  const dir = ROOT + "apps/";
  const out: DemoEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const app = dir + name + "/app.tsx";
    const vueApp = dir + name + "/app.vue-vapor.tsx";
    const octaneApp = dir + name + "/app.octane.tsx";
    const main = dir + name + "/main.tsx";
    if (!existsSync(app)) continue;
    // The playground (and every demo shelf on the site) shows only
    // PSP-admissible demos: a committed manifest that does not resolve
    // against the psp target (desktop-only capabilities, non-console
    // viewport) keeps its demo off the site.
    const manifestPath = dir + name + "/pocket.json";
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!validateAndResolveBuildPlan(manifest, { target: "psp" }).ok) continue;
    }
    const source = inlinePlaygroundImports(name, readFileSync(app, "utf8"));
    if (source === null) continue; // multi-file demo
    let title = name[0].toUpperCase() + name.slice(1);
    if (existsSync(main)) {
      const mainSource = readFileSync(main, "utf8");
      if (/@playground\s+false\b/.test(mainSource)) continue;
      const m = mainSource.match(/@title\s+PocketJS:\s*(.+)/);
      if (m) title = m[1].trim();
    }
    const spriteMeta = demoSpriteMeta(name);
    const variants: DemoVariant[] = [{ framework: "solid", source, spriteMeta }];
    if (existsSync(vueApp)) {
      const vueSource = inlinePlaygroundImports(name, readFileSync(vueApp, "utf8"));
      if (vueSource !== null) {
        variants.push({ framework: "vue-vapor", source: vueSource, spriteMeta });
      }
    }
    if (existsSync(octaneApp)) {
      const octaneSource = inlinePlaygroundImports(name, readFileSync(octaneApp, "utf8"));
      if (octaneSource !== null) {
        variants.push({ framework: "octane", source: octaneSource, spriteMeta });
      }
    }
    out.push({ name, title, variants });
  }
  return out;
}

function copyDemoAssets(): void {
  const demosDir = ROOT + "apps/";
  for (const name of readdirSync(demosDir)) {
    const dir = demosDir + name + "/";
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (/\.(?:png|svg)$/i.test(file)) copy(dir + file, "demo-assets/" + file);
    }
  }
  const launcherCovers = ROOT + "apps/launcher/covers/";
  if (existsSync(launcherCovers)) copy(launcherCovers, "demo-assets/covers/");
}

type BabelImport = {
  type: "ImportDeclaration";
  source: { value: string };
  specifiers: Array<
    | { type: "ImportDefaultSpecifier" }
    | { type: "ImportNamespaceSpecifier" }
    | { type: "ImportSpecifier"; imported: { type: string; name?: string; value?: string } }
  >;
};

/**
 * Link every generated variant against the exact browser import map and the
 * actual emitted bundle exports. A site build used to stop after writing the
 * editable source into demos.json, so missing subpath mappings and curated
 * facade exports could ship while every build stayed green.
 */
async function verifyPlaygroundModules(demos: DemoEntry[]): Promise<void> {
  // Import the emitted browser artifact rather than its source entry. This is
  // what catches bundler-only failures such as a retained call whose imported
  // binding was tree-shaken out. Bust Bun's ESM cache for repeated builds in
  // one process.
  const compilerUrl = pathToFileURL(OUT + "pg/compiler.js");
  compilerUrl.searchParams.set("build", String(Date.now()));
  const [{ transformAppSource }, { transformAsync }] = await Promise.all([
    import(compilerUrl.href) as Promise<typeof import("./playground/compiler-entry.ts")>,
    import("@babel/core"),
  ]);
  const scanner = new Bun.Transpiler({ loader: "js" });
  const exportCache = new Map<string, Set<string>>();
  const failures: string[] = [];

  const emittedPath = (specifier: string): string | null => {
    const mapped = PLAYGROUND_IMPORTS[specifier];
    if (mapped) return mapped;
    if (specifier.startsWith("/pg/")) return specifier;
    try {
      const url = new URL(specifier);
      if (url.origin === "https://pocketjs.dev" && url.pathname.startsWith("/pg/")) {
        return url.pathname;
      }
    } catch {
      // Bare specifier: the missing-map error below should name it directly.
    }
    return null;
  };

  const moduleExports = async (path: string): Promise<Set<string> | null> => {
    const cached = exportCache.get(path);
    if (cached) return cached;
    const file = OUT + path.replace(/^\//, "");
    if (!existsSync(file)) return null;
    const exports = new Set(scanner.scan(readFileSync(file, "utf8")).exports);
    exportCache.set(path, exports);
    return exports;
  };

  for (const demo of demos) {
    for (const variant of demo.variants) {
      const label = `${demo.name}/${variant.framework}`;
      try {
        const { code } = await transformAppSource(
          variant.source,
          variant.framework,
          "https://pocketjs.dev/",
        );
        if (!scanner.scan(code).exports.includes("default")) {
          failures.push(`${label}: transformed module has no default export`);
        }
        const parsed = await transformAsync(code, {
          filename: `${label}.js`,
          ast: true,
          code: false,
          babelrc: false,
          configFile: false,
          sourceMaps: false,
        });
        const imports = (parsed?.ast?.program.body ?? []).filter(
          (node) => node.type === "ImportDeclaration",
        ) as unknown as BabelImport[];
        for (const node of imports) {
          const specifier = node.source.value;
          const target = emittedPath(specifier);
          if (!target) {
            failures.push(`${label}: import map has no entry for ${specifier}`);
            continue;
          }
          const exports = await moduleExports(target);
          if (!exports) {
            failures.push(`${label}: mapped module does not exist: ${specifier} -> ${target}`);
            continue;
          }
          for (const imported of node.specifiers) {
            if (imported.type === "ImportNamespaceSpecifier") continue;
            const name = imported.type === "ImportDefaultSpecifier"
              ? "default"
              : imported.imported.name ?? imported.imported.value;
            if (name && !exports.has(name)) {
              failures.push(`${label}: ${specifier} does not export ${name}`);
            }
          }
        }
      } catch (error) {
        failures.push(`${label}: transform failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`playground module audit failed:\n  ${failures.join("\n  ")}`);
  }
  const variants = demos.reduce((count, demo) => count + demo.variants.length, 0);
  console.log(`  playground modules linked  (${variants} variants)`);
}

async function main() {
  console.log("pocketjs.dev build:");
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeStaticHeaders();
  writeStaticRedirects();

  // 1. bundles
  await bundleSolid("pg/solid.js");
  await bundleSolidUniversal("pg/solid-universal.js");
  await bundleVueVapor("pg/vue-vapor.js");
  writeVueVaporHelpers();
  await bundle("playground/runtime-entry.ts", "pg/runtime.js", { external: ["solid-js", "solid-js/universal"] });
  await bundle("playground/runtime-vue-vapor-entry.ts", "pg/runtime-vue-vapor.js", { external: ["vue"] });
  await bundle("playground/compiler-entry.ts", "pg/compiler.js", {
    shims: true,
    prelude: PROCESS_PRELUDE,
    plugins: [octaneBrowserCompilerPlugin],
  });
  // Octane framework modules must pass through the Octane compiler (hook call
  // sites get slots; JSX lowers to universal plans), so this bundle runs under
  // the same jsxPlugin the real build uses. Self-contained: the universal
  // runtime (octane/universal/native) is bundled in, no import-map external.
  // Imported lazily AFTER pg/compiler.js is bundled: loading jsx-plugin.ts
  // (vue-jsx-vapor/api and friends) into this process poisons Bun's module
  // classification for the wasi-shim graph and the compiler bundle then fails
  // with a require-of-top-level-await error.
  const { jsxPlugin } = await import("../framework/compiler/jsx-plugin.ts");
  await bundle("playground/runtime-octane-entry.ts", "pg/runtime-octane.js", {
    plugins: [jsxPlugin("octane")],
  });
  await bundle("playground/playground.js", "pg/playground.bundle.js");
  // Live docs demos (`:::demo <app>`). Bundled from source so it can import
  // the framework's own touch packing helpers instead of restating them.
  await bundle("playground/embed.js", "pg/embed.js");
  await bundle("assets/pocket-stage-web.js", "assets/pocket-stage-web.js");
  await bundle("assets/handheld-stages.js", "assets/handheld-stages.js", {
    external: ["/assets/pocket-stage-web.js"],
  });

  // 2. runtime assets
  // Keep the editor-facing URL byte-identical to the schema used by the
  // validator. The deployed path is POCKET_MANIFEST_SCHEMA_ID —
  // /schema/pocket-2.json, independent of where the repo keeps the file.
  copy(ROOT + "contracts/schema/pocket-2.json", "schema/pocket-2.json");
  copy(ROOT + "contracts/schema/pocket-idf-host-1.json", "schema/pocket-idf-host-1.json");
  copy(ROOT + "hosts/web/pocketjs.wasm", "pg/pocketjs.wasm");
  // The AppInstance realm a docs demo boots into: one hidden same-origin
  // iframe per demo, so several demos on one page never share globals.
  copy(ROOT + "hosts/web/app-instance.html", "pg/app-instance.html");
  copy(ROOT + "hosts/web/app-instance.js", "pg/app-instance.js");
  copy(ROOT + "hosts/web/wasm-ops.js", "pg/wasm-ops.js");
  for (const name of ["offload-worker.js", "text-worker.js", "text-engine.js", "pocket_text.wasm"]) {
    copy(ROOT + "hosts/web/" + name, "pg/" + name);
  }
  copy(ROOT + "assets/fonts/Inter-Regular.ttf", "pg/fonts/Inter-Regular.ttf");
  copy(ROOT + "assets/fonts/Inter-Bold.ttf", "pg/fonts/Inter-Bold.ttf");
  for (const f of readdirSync(ROOT + "assets/images/")) copy(ROOT + "assets/images/" + f, "demo-assets/" + f);
  copyDemoAssets();

  // Homepage Pocket Stage package: the Pocket Launcher plus every admitted
  // app (docs/LAUNCHER.md) — the same deck the PSP EBOOT ships, wasm-rendered.
  // The deploy workflow builds the launcher family first; fail here instead
  // of silently publishing a shell with a missing screen app when
  // site/build.ts is run by hand.
  const registryPath = ROOT + "dist/launcher-registry.json";
  if (!existsSync(registryPath)) {
    throw new Error("missing dist/launcher-registry.json — run: bun tools/launcher.ts covers");
  }
  const launcherRegistry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    apps: { output: string; id: string; title: string }[];
  };
  const stageApps = ["launcher-main", ...launcherRegistry.apps.map((a) => a.output)];
  for (const output of stageApps) {
    const source = ROOT + `dist/packages/${output}.pocket`;
    if (!existsSync(source)) {
      throw new Error(`missing dist/packages/${output}.pocket — run: bun tools/launcher.ts pack`);
    }
    copy(source, `stage/apps/${output}.pocket`);
  }
  write(
    "stage/apps/apps.json",
    JSON.stringify({
      apps: launcherRegistry.apps.map(({ output, id, title }) => ({ output, id, title })),
    }),
  );
  const pspPackage = ROOT + "engine/pocket3d/examples/handheld/assets/dibad-psp/";
  emitSingleLodStagePackage(pspPackage, OUT + "stage/", "psp-profile.json", "orbit");
  for (const device of ["new-nintendo-3ds", "ps-vita-2000"]) {
    emitSingleLodStagePackage(ROOT + `engine/pocket3d/examples/handheld/assets/${device}/`,
      OUT + `stage/${device}/`, "profile.json", "orbit");
  }
  for (const output of ["3ds-demo-main", "motions-main"]) {
    for (const ext of ["js", "pak"]) {
      const path = ROOT + `dist/handheld-apps/${output}.${ext}`;
      if (!existsSync(path)) throw new Error(`missing ${path}; run bun run site:build`);
      copy(path, `stage/handheld-apps/${output}.${ext}`);
    }
  }

  // 3. demos manifest
  const demos = demoManifest();
  write("pg/demos.json", JSON.stringify(demos));
  console.log(`  pg/demos.json  (${demos.length} demos: ${demos.map((d) => d.name).join(", ")})`);
  await verifyPlaygroundModules(demos);

  // 4. static assets + Tailwind CSS (compiled AFTER pages exist so the content
  //    scan sees every class; we render pages to a temp first, then compile).
  for (const asset of [
    // the icon family, rendered from favicon.svg by tools/icons.ts
    "favicon.svg",
    "favicon.ico",
    "favicon-96.png",
    "apple-touch-icon.png",
    // what an iOS client fetches from the root when it reads no link tag
    "apple-touch-icon-precomposed.png",
    "apple-touch-icon-167.png",
    "apple-touch-icon-152.png",
    "apple-touch-icon-120.png",
    "icon-192.png",
    "icon-512.png",
    "icon-512-maskable.png",
    "safari-pinned-tab.svg",
    "site.webmanifest",
    "og-image.svg",
    "og-image.png",
  ]) {
    if (existsSync(SITE + "assets/" + asset)) copy(SITE + "assets/" + asset, asset);
  }
  // OpenStrike desktop screenshot (referenced by the shipping-openstrike post).
  copy(SITE + "assets/os-dust2.jpg", "assets/os-dust2.jpg");
  // The original hardware capture (embedded by the introducing-pocketjs post).
  copy(SITE + "assets/pocketjs-hardware-demo.mp4", "assets/pocketjs-hardware-demo.mp4");
  // The hero demo wall + its poster frame (baked by site/bake-demo-wall.ts).
  copy(SITE + "assets/pocketjs-demo-wall.mp4", "assets/pocketjs-demo-wall.mp4");
  copy(SITE + "assets/pocketjs-demo-wall.jpg", "assets/pocketjs-demo-wall.jpg");
  // The Pocket Vapor promo film (embedded at the top of the pocket-vapor post;
  // rendered by vapor/scripts/promo/, poster frame lives in assets/blog/).
  copy(SITE + "assets/pocket-vapor-promo.mp4", "assets/pocket-vapor-promo.mp4");
  // Blog illustration loops (animated GIFs rendered by the engine itself).
  if (existsSync(SITE + "assets/blog/")) {
    for (const f of readdirSync(SITE + "assets/blog/")) copy(SITE + "assets/blog/" + f, "assets/blog/" + f);
  }
  // Wall crops: hero-collage stills + use-case card backgrounds, extracted
  // from the baked demo wall's known tile grid.
  if (existsSync(SITE + "assets/wall/")) {
    for (const f of readdirSync(SITE + "assets/wall/")) copy(SITE + "assets/wall/" + f, "assets/wall/" + f);
  }

  // Sponsor avatars, downloaded by tools/sponsors.ts so the page never calls
  // out to GitHub at run time.
  if (existsSync(SITE + "assets/sponsors/")) {
    for (const f of readdirSync(SITE + "assets/sponsors/")) copy(SITE + "assets/sponsors/" + f, "assets/sponsors/" + f);
  }

  // 5. playground page
  write("playground/index.html", renderPage({
    title: "Playground",
    active: "playground",
    body: readFileSync(SITE + "playground/page.html", "utf8"),
    bodyClass: "pg-page",
    head: IMPORT_MAP,
    scripts: ['<script type="module" src="/pg/playground.bundle.js"></script>'],
    path: "/playground/",
  }));
  // 6. homepage — bespoke design with its own chrome, landing.css and
  //    landing.js (the framework code tabs). Not wrapped in the shared
  //    header/footer (those stay for docs + playground).
  write("index.html", renderHome());
  // The homepage ships one stylesheet: the same tokens and chrome the Tailwind
  // build imports, plus the landing sections, concatenated in layer order.
  write("assets/landing.css", ["tokens.css", "base.css", "chrome.css", "landing.css", "showcase.css"]
    .map((f) => readFileSync(SITE + "assets/" + f, "utf8"))
    .join("\n"));
  await bundle("assets/landing.js", "assets/landing.js", {
    external: ["/assets/pocket-stage-web.js", "/assets/handheld-stages.js"],
  });
  for (const image of new Set(SHOWCASE_APPS.map((app) => app.image))) {
    if (image.startsWith("/assets/showcase/")) copy(SITE + image.slice(1), image.slice(1));
  }
  // home.css stays for the /for/ pages, which keep the .lp-* chrome.
  copy(SITE + "assets/home.css", "assets/home.css");

  // 6b. /for/ use-case pages — landing-styled (home.css chrome, no hero).
  //     site/for/shell.html carries the shared nav + footer; each fragment
  //     carries the page's main content.
  for (const page of FOR_PAGES) {
    write(`for/${page.slug}/index.html`, renderForPage(page));
  }

  // 7. docs + blog (setupMarkdown installs the shared marked/shiki renderer)
  const highlight = await setupMarkdown();
  await buildDocs(highlight);
  await buildBlog();
  buildChangelog();

  // 7b. 404
  write("404.html", renderPage({
    title: "Not found",
    active: "",
    bodyClass: "",
    head: "",
    scripts: [],
    path: "/404.html",
    body: `<section class="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-5 py-24 text-center">
      <div class="font-mono text-6xl font-bold text-gradient">404</div>
      <h1 class="mt-4 text-2xl font-bold text-slate-100">This screen doesn't exist.</h1>
      <p class="mt-2 text-slate-400">The page you're looking for isn't in the tree — try the docs or head home.</p>
      <div class="mt-7 flex gap-3"><a href="/" class="btn btn-primary px-5 py-2.5">Home</a><a href="/docs/overview/" class="btn px-5 py-2.5">Docs</a></div>
    </section>`,
  }));

  // 8. Tailwind CSS (@source in tailwind.css scans the site/ SOURCE for classes)
  await compileCss();

  console.log("pocketjs.dev build: done -> site/dist/");
}

// The homepage is a standalone document (its design owns its own header +
// footer + CSS). site/home.html holds the body; site/assets/landing.css the
// styles. Display faces come from Google Fonts; the fallback stacks keep the
// page readable when that request fails. Its meta description is the shared
// SITE_DESC, so the positioning sentence is stated in exactly one place.
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The sponsor gallery is generated data: `bun tools/sponsors.ts` refreshes
// site/sponsors.json and the avatars beside it (public sponsorships only).
const SPONSOR_SLOT = "{{SPONSOR_GALLERY}}";
function renderSponsorGallery(): string {
  const { sponsors } = JSON.parse(readFileSync(SITE + "sponsors.json", "utf8")) as {
    sponsors: { login: string; name: string; url: string; avatar: string }[];
  };
  return sponsors
    .map((s) => {
      const label = escapeHtml(s.name === s.login ? s.login : `${s.name} (${s.login})`);
      return `<a href="${s.url}" target="_blank" rel="noreferrer" title="${label}">` +
        `<img src="${s.avatar}" alt="${label}" width="56" height="56" loading="lazy"></a>`;
    })
    .join("\n      ");
}

function renderHome(): string {
  const raw = readFileSync(SITE + "home.html", "utf8");
  const slots = raw.split(SPONSOR_SLOT).length - 1;
  if (slots !== 1) throw new Error(`Expected ${SPONSOR_SLOT} exactly once in the homepage; found ${slots}`);
  const body = renderHomeShowcase(raw.replace(SPONSOR_SLOT, () => renderSponsorGallery()));
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: "PocketJS",
    description: SITE_DESC,
    url: SITE_URL,
    codeRepository: "https://github.com/pocket-stack/pocketjs",
    programmingLanguage: ["TypeScript", "JavaScript", "Rust"],
    runtimePlatform: [
      "Sony PSP",
      "Sony PS Vita",
      "Nokia E7 (Symbian)",
      "PocketBook",
      "ESP32",
      "Game Boy Advance",
      "Game Boy",
      "NES",
      "Playdate",
      "macOS",
      "PPSSPP",
      "Vita3K",
      "WebAssembly",
      "Bun",
    ],
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SITE_TITLE}</title>
<meta name="description" content="${SITE_DESC}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${SITE_URL}/">
<meta property="og:title" content="${SITE_TITLE}">
<meta property="og:description" content="${SITE_DESC}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PocketJS">
<meta property="og:url" content="${SITE_URL}/">
<meta property="og:image" content="${OG_IMAGE_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${SITE_TITLE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${SITE_TITLE}">
<meta name="twitter:description" content="${SITE_DESC}">
<meta name="twitter:image" content="${OG_IMAGE_URL}">
<meta name="theme-color" content="#171226">
${ICON_LINKS}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=STIX+Two+Text:ital,wght@0,400;0,600;1,400&family=VT323&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/assets/landing.css">
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
${body}
<script type="module" src="/assets/landing.js"></script>
</body>
</html>`;
}

// The /for/ pages share the homepage's bespoke chrome (home.css, no shared
// Tailwind shell): site/for/shell.html holds the nav + footer, and
// site/for/<slug>.html the main content. Linked from the use-case cards.
const FOR_PAGES = [
  {
    slug: "interfaces",
    title: "PocketJS for user interfaces",
    desc: "Components, signals and Tailwind classes in Solid, Vue Vapor or Octane become one native tree that runs on every machine in the registry.",
  },
  {
    slug: "games",
    title: "PocketJS for games",
    desc: "Rust engine cores under JavaScript gameplay: OpenStrike holds a locked 60 fps on a 333 MHz PSP while the HUD stays a Solid app.",
  },
  {
    slug: "worlds",
    title: "PocketJS for 3D worlds",
    desc: "Pocket3D cooks a scene once and renders it through wgpu, sceGu, GXM and OpenGL ES, up to VRM humans with spring-bone physics.",
  },
  {
    slug: "agents",
    title: "PocketJS for AI-native apps",
    desc: "A virtual clock makes every frame a pure function of an input tape: sessions agents can drive, replay and diff, on a runtime small enough to host the agent itself.",
  },
];

function renderForPage(page: { slug: string; title: string; desc: string }): string {
  const shell = injectSiteFooterDescription(readFileSync(SITE + "for/shell.html", "utf8"));
  const main = readFileSync(SITE + `for/${page.slug}.html`, "utf8");
  if (!shell.includes("{{FOR_MAIN}}")) throw new Error("for/shell.html must contain {{FOR_MAIN}}");
  const body = shell.replace("{{FOR_MAIN}}", main);
  const url = `${SITE_URL}/for/${page.slug}/`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} · PocketJS</title>
<meta name="description" content="${page.desc}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${page.title} · PocketJS">
<meta property="og:description" content="${page.desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PocketJS">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${OG_IMAGE_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${page.title} · PocketJS">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${page.title} · PocketJS">
<meta name="twitter:description" content="${page.desc}">
<meta name="twitter:image" content="${OG_IMAGE_URL}">
<meta name="theme-color" content="#171226">
${ICON_LINKS}
<link rel="stylesheet" href="/assets/home.css">
</head>
<body>
${body}
</body>
</html>`;
}

async function compileCss() {
  const proc = Bun.spawnSync(
    ["bunx", "@tailwindcss/cli", "-i", SITE + "assets/tailwind.css", "-o", OUT + "assets/site.css", "--minify"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    console.error(proc.stderr.toString());
    throw new Error("tailwind build failed");
  }
  const bytes = Bun.file(OUT + "assets/site.css").size;
  console.log(`  assets/site.css  (${(bytes / 1024).toFixed(0)} KiB)`);
}

// Compiled apps resolve every supported public subpath to one singleton
// runtime per framework. Keep the object available to the build-time link
// audit below; JSON.stringify is the one source of truth for the page.
const PLAYGROUND_IMPORTS: Record<string, string> = {
  "solid-js": "/pg/solid.js",
  "solid-js/universal": "/pg/solid-universal.js",
  vue: "/pg/vue-vapor.js",
  "/vue-jsx-vapor/props": "/pg/vue-jsx-vapor/props.js",
  "/vue-jsx-vapor/vdom": "/pg/vue-jsx-vapor/vdom.js",
  "/vue-jsx-vapor/vapor": "/pg/vue-jsx-vapor/vapor.js",
  "/vue-jsx-vapor/ssr": "/pg/vue-jsx-vapor/ssr.js",
  "@pocketjs/framework": "/pg/runtime.js",
  "@pocketjs/framework/animation": "/pg/runtime.js",
  "@pocketjs/framework/audio": "/pg/runtime.js",
  "@pocketjs/framework/clock": "/pg/runtime.js",
  "@pocketjs/framework/components": "/pg/runtime.js",
  "@pocketjs/framework/host": "/pg/runtime.js",
  "@pocketjs/framework/input": "/pg/runtime.js",
  "@pocketjs/framework/launcher": "/pg/runtime.js",
  "@pocketjs/framework/lifecycle": "/pg/runtime.js",
  "@pocketjs/framework/renderer": "/pg/runtime.js",
  "@pocketjs/framework/solid": "/pg/runtime.js",
  "@pocketjs/framework/solid/components": "/pg/runtime.js",
  "@pocketjs/framework/solid/lifecycle": "/pg/runtime.js",
  "@pocketjs/framework/solid/renderer": "/pg/runtime.js",
  "@pocketjs/framework/vue-vapor": "/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/animation": "/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/audio": "/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/components": "/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/input": "/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/lifecycle": "/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/vue-vapor/renderer": "/pg/runtime-vue-vapor.js",
  "@pocketjs/framework/octane": "/pg/runtime-octane.js",
  "@pocketjs/framework/octane/animation": "/pg/runtime-octane.js",
  "@pocketjs/framework/octane/audio": "/pg/runtime-octane.js",
  "@pocketjs/framework/octane/components": "/pg/runtime-octane.js",
  "@pocketjs/framework/octane/input": "/pg/runtime-octane.js",
  "@pocketjs/framework/octane/lifecycle": "/pg/runtime-octane.js",
  "@pocketjs/framework/octane/renderer": "/pg/runtime-octane.js",
};
const IMPORT_MAP = `<script type="importmap">${JSON.stringify({ imports: PLAYGROUND_IMPORTS })}</script>`;

type Highlight = (text: string, rawLang: string) => string;

// Syntax highlighting: Shiki (build-time, self-contained themed HTML) matched
// to the playground editor's one-dark-pro. Installs marked's code renderer so
// every fenced block (docs + blog) becomes a highlighted <pre class="shiki">.
async function setupMarkdown(): Promise<Highlight> {
  const highlighter = await createHighlighter({
    themes: ["one-dark-pro"],
    langs: ["tsx", "typescript", "jsx", "javascript", "json", "bash", "rust", "toml", "html", "css", "diff", "c", "cpp"],
  });
  const LANG_ALIAS: Record<string, string> = { ts: "typescript", js: "javascript", sh: "bash", shell: "bash", console: "bash", jsonc: "json", rs: "rust", text: "text", txt: "text" };
  const loaded = new Set(highlighter.getLoadedLanguages());
  const highlight = (text: string, rawLang: string) => {
    const raw = rawLang.trim().split(/\s+/)[0].toLowerCase();
    const lang = LANG_ALIAS[raw] ?? raw;
    const use = loaded.has(lang) ? lang : "text";
    return highlighter.codeToHtml(text, { theme: "one-dark-pro", lang: use });
  };
  marked.use({
    renderer: {
      code(token: { text?: string; lang?: string }) {
        const text = token.text ?? "";
        return highlight(text, token.lang ?? "");
      },
      // GitHub-style heading slugs so in-page anchors (#3d-transforms) and
      // deep links into docs sections work.
      heading(token: { tokens?: unknown[]; depth?: number; text?: string }) {
        const depth = token.depth ?? 1;
        const html = this.parser!.parseInline(token.tokens as never);
        const slug = (token.text ?? "")
          .toLowerCase()
          .replace(/<[^>]+>/g, "")
          .replace(/[`*_]/g, "")
          .replace(/[^a-z0-9\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-");
        return `<h${depth} id="${slug}">${html}</h${depth}>\n`;
      },
    },
  });
  return highlight;
}

const DOC_DEMO_SCRIPT = '<script type="module" src="/pg/embed.js"></script>';

// `:::demo <app>` -> a live PocketJS app on the page. The figure carries every
// resolved fact site/playground/embed.js needs; the markdown carries only the
// app name and an optional caption.
//
// The .pg-stage chrome is deliberately NOT reused: site/assets/chrome.css hides
// .pg-stage__screen (that stage textures onto a Three.js model) and hardcodes a
// 16/9 box, which is wrong for a 320x480 portrait app. .doc-demo is its own
// component in site/assets/tailwind.css.
function docDemoFigure(demo: DocDemo, caption: string): string {
  // A caption is the directive's own body. A bare `:::demo <app>` gets none:
  // the page's prose around it is the docs author's, not this generator's.
  const captionHtml = caption ? (marked.parseInline(caption) as string) : "";
  const attrs: Record<string, string> = {
    "data-app": demo.app,
    "data-package-id": demo.packageId,
    "data-instance": "/pg/app-instance.html",
    "data-wasm": "/pg/pocketjs.wasm",
    "data-bundle": `/pg/demos/${demo.bundleFile}`,
    "data-pak": `/pg/demos/${demo.pakFile}`,
    "data-width": String(demo.width),
    "data-height": String(demo.height),
    "data-density": String(demo.rasterDensity),
  };
  const attrText = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ");
  return (
    `<figure class="doc-demo" data-doc-demo data-state="idle" ${attrText}>` +
    `<div class="doc-demo__stage" style="--doc-demo-w:${demo.width}px;--doc-demo-ratio:${demo.width}/${demo.height}">` +
    `<canvas class="doc-demo__screen" data-doc-demo-canvas width="${demo.width}" height="${demo.height}"` +
    ` role="img" aria-label="${demo.title}, running live"></canvas>` +
    `<p class="doc-demo__status" data-doc-demo-status>${demo.title} starts when you scroll it into view.</p>` +
    `</div>` +
    (captionHtml ? `<figcaption class="doc-demo__caption">${captionHtml}</figcaption>` : "") +
    `</figure>`
  );
}

async function buildDocs(highlight: Highlight) {
  let frameworkCodeId = 0;
  // One copy per app however many pages embed it.
  const copiedDemos = new Set<string>();
  const renderDocDemos = (markdown: string, used: DocDemo[]) => {
    const directives = findDocDemoDirectives(markdown);
    if (directives.length === 0) return markdown;
    const lines = markdown.split("\n");
    for (const directive of directives) {
      const demo = resolveDocDemo(directive.app);
      // dist/ holds no demo artifact on a fresh clone, so this is the default
      // state, not an edge case: name the command instead of shipping a page
      // with a dead frame.
      assertDocDemoBuilt(demo);
      used.push(demo);
      if (!copiedDemos.has(demo.app)) {
        copiedDemos.add(demo.app);
        copy(demo.distJs, `pg/demos/${demo.bundleFile}`);
        copy(demo.distPak, `pg/demos/${demo.pakFile}`);
      }
      lines[directive.start] = `\n${docDemoFigure(demo, directive.caption)}\n`;
      for (let i = directive.start + 1; i <= directive.end; i++) lines[i] = "";
    }
    return lines.join("\n");
  };
  const renderFrameworkCode = (markdown: string) =>
    markdown.replace(/:::framework-code\n([\s\S]*?)\n:::/g, (_match, body: string) => {
      const FW_LABELS = { solid: "Solid", "vue-vapor": "Vue Vapor", octane: "Octane" } as const;
      const variants: { framework: keyof typeof FW_LABELS; code: string; lang: string; label: string }[] = [];
      body.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_fence, meta: string, code: string) => {
        const parts = meta.trim().split(/\s+/);
        const framework = parts.find((part: string): part is keyof typeof FW_LABELS => part in FW_LABELS);
        if (!framework) return "";
        variants.push({
          framework,
          code: code.replace(/\n$/, ""),
          lang: parts[0] || "text",
          label: FW_LABELS[framework],
        });
        return "";
      });
      if (variants.length === 0) return body;
      const id = frameworkCodeId++;
      const group = `doc-fw-code-${id}`;
      const inputs = variants
        .map((variant, i) =>
          `<input class="doc-fw-radio doc-fw-radio-${variant.framework}" type="radio" name="${group}" id="${group}-${variant.framework}"${i === 0 ? " checked" : ""}>`,
        )
        .join("");
      const tabs = variants
        .map(
          (variant) =>
            `<label class="doc-fw-tab doc-fw-tab-${variant.framework}" for="${group}-${variant.framework}">${variant.label}</label>`,
        )
        .join("");
      const panels = variants
        .map(
          (variant) =>
            `<div class="doc-fw-panel doc-fw-panel-${variant.framework}" data-framework="${variant.framework}">${highlight(variant.code, variant.lang)}</div>`,
        )
        .join("");
      return `<div class="doc-fw-code">${inputs}<div class="doc-fw-tabs" role="tablist">${tabs}</div><div class="doc-fw-panels">${panels}</div></div>`;
    });
  type DocsTree = {
    active: string;
    docsDir: string;
    head: string;
    nav: DocSection[];
    outPrefix: string;
    robots?: string;
    transformFrameworkCode: boolean;
  };
  const buildTree = async (tree: DocsTree) => {
    if (!existsSync(tree.docsDir)) return;
    const hrefFor = (slug: string) => `/${tree.outPrefix}/${slug}/`;
    const sidebarFor = (active: string) =>
      tree.nav.map(
        (sec) =>
          `<div class="doc-sec"><div class="doc-sec-t">${sec.title}</div>` +
          sec.items
            .map((it) => `<a href="${hrefFor(it.slug)}" class="${it.slug === active ? "on" : ""}"${it.slug === active ? ' aria-current="page"' : ""}>${it.title}</a>`)
            .join("") +
          `</div>`,
      ).join("");
    const allSlugs = tree.nav.flatMap((s) => s.items);
    for (let i = 0; i < allSlugs.length; i++) {
      const { slug, title } = allSlugs[i];
      const md = tree.docsDir + slug + ".md";
      if (!existsSync(md)) {
        console.warn(`  ${tree.outPrefix}: MISSING ${slug}.md`);
        continue;
      }
      const source = readFileSync(md, "utf8");
      const pageDemos: DocDemo[] = [];
      const withDemos = renderDocDemos(source, pageDemos);
      const html = await marked.parse(tree.transformFrameworkCode ? renderFrameworkCode(withDemos) : withDemos);
      const prev = allSlugs[i - 1];
      const next = allSlugs[i + 1];
      const pager =
        `<nav class="doc-pager">` +
        (prev ? `<a href="${hrefFor(prev.slug)}" class="prev"><span>Previous</span>${prev.title}</a>` : `<span></span>`) +
        (next ? `<a href="${hrefFor(next.slug)}" class="next"><span>Next</span>${next.title}</a>` : `<span></span>`) +
        `</nav>`;
      const body =
        `<div class="doc-shell">` +
        `<details class="doc-mobile-nav"><summary><span>Browse docs</span><span class="doc-current">${title}</span></summary>` +
        `<nav class="doc-mobile-links" aria-label="Documentation">${sidebarFor(slug)}</nav></details>` +
        `<aside class="doc-nav"><nav aria-label="Documentation">${sidebarFor(slug)}</nav></aside>` +
        `<article class="doc-body" data-slug="${slug}"><div class="prose prose-invert max-w-none doc-content">${html}</div>${pager}</article></div>`;
      write(`${tree.outPrefix}/${slug}/index.html`, renderPage({
        title,
        active: tree.active,
        body,
        bodyClass: "doc-page",
        head: tree.head,
        // Only a page that carries a demo pays for the embed bundle.
        scripts: pageDemos.length > 0 ? [DOC_DEMO_SCRIPT] : [],
        path: hrefFor(slug),
        robots: tree.robots,
      }));
    }
    if (allSlugs.length > 0) {
      const robotsMeta = tree.robots ? `<meta name="robots" content="${tree.robots}">` : "";
      write(
        `${tree.outPrefix}/index.html`,
        `<!doctype html><meta charset="utf-8">${robotsMeta}<meta http-equiv="refresh" content="0; url=${hrefFor(allSlugs[0].slug)}">`,
      );
    }
    console.log(`  ${tree.outPrefix}  (${allSlugs.length} pages)`);
  };

  await buildTree({
    active: "docs",
    docsDir: SITE + "content/docs/",
    head: IMPORT_MAP,
    nav: DOC_NAV,
    outPrefix: "docs",
    transformFrameworkCode: true,
  });
}

// --- blog: /blog/ index + one page per post from site/content/blog/<slug>.md.
// Relies on the marked/shiki renderer installed by setupMarkdown().
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function formatPostDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

const BLOG_DESC = "Announcements and engineering notes from the PocketJS team.";
function buildChangelog() {
  const md = SITE + "content/changelog.md";
  if (!existsSync(md)) return;
  const html = marked.parse(readFileSync(md, "utf8")) as string;
  write("changelog/index.html", renderPage({
    title: "Changelog",
    active: "changelog",
    desc: "Engine and site milestones — what shipped in each PocketJS release.",
    path: "/changelog/",
    body:
      `<main class="mx-auto w-full max-w-3xl px-6 py-14">` +
      `<article class="prose prose-invert max-w-none doc-content">${html}</article>` +
      `</main>`,
  }));
  console.log("  changelog  (1 page)");
}

async function buildBlog() {
  const dir = SITE + "content/blog/";
  const posts = [...BLOG_POSTS].sort((a, b) => (a.date < b.date ? 1 : -1));
  const rendered: typeof posts = [];
  for (const post of posts) {
    const md = dir + post.slug + ".md";
    if (!existsSync(md)) {
      console.warn(`  blog: MISSING ${post.slug}.md`);
      continue;
    }
    const html = await marked.parse(readFileSync(md, "utf8"));
    const body =
      `<article class="mx-auto max-w-3xl px-5 py-14">` +
      `<a href="/blog/" class="text-sm text-slate-400 hover:text-brand-2">&larr; Blog</a>` +
      `<header class="mt-4 border-b border-line pb-8">` +
      `<time datetime="${post.date}" class="font-mono text-xs uppercase tracking-wide text-slate-500">${formatPostDate(post.date)}</time>` +
      `<h1 class="mt-3 text-4xl font-bold tracking-tight text-slate-100">${post.title}</h1>` +
      `<p class="mt-4 text-lg text-slate-400">${post.description}</p>` +
      `<p class="mt-4 text-sm text-slate-400">Written by <a class="font-semibold text-slate-200 hover:text-brand-2" href="${post.author.url}" target="_blank" rel="noreferrer">${post.author.name}</a></p>` +
      `</header>` +
      `<div class="prose prose-invert max-w-none doc-content mt-8">${html}</div>` +
      `</article>`;
    write(`blog/${post.slug}/index.html`, renderPage({
      title: post.title,
      active: "blog",
      body,
      bodyClass: "",
      head: "",
      scripts: [],
      path: `/blog/${post.slug}/`,
      description: post.description,
    }));
    rendered.push(post);
  }
  const cards = rendered
    .map(
      (p) =>
        `<a href="/blog/${p.slug}/" class="group block rounded-xl border border-line bg-surface/60 p-6 transition-colors hover:border-brand">` +
        `<time datetime="${p.date}" class="font-mono text-xs uppercase tracking-wide text-slate-500">${formatPostDate(p.date)}</time>` +
        `<h2 class="mt-2 text-2xl font-bold text-slate-100 group-hover:text-brand-2">${p.title}</h2>` +
        `<p class="mt-2 text-slate-400">${p.description}</p>` +
        `<span class="mt-4 inline-block text-sm font-semibold text-brand-2">Read post &rarr;</span>` +
        `</a>`,
    )
    .join("");
  write("blog/index.html", renderPage({
    title: "Blog",
    active: "blog",
    body:
      `<section class="mx-auto max-w-3xl px-5 pb-20 pt-14">` +
      `<h1 class="text-4xl font-bold tracking-tight text-slate-100">Blog</h1>` +
      `<p class="mt-3 text-slate-400">${BLOG_DESC}</p>` +
      `<div class="mt-10 grid gap-5">${cards}</div>` +
      `</section>`,
    bodyClass: "",
    head: "",
    scripts: [],
    path: "/blog/",
    description: BLOG_DESC,
  }));
  console.log(`  blog  (${rendered.length} posts)`);
}

await main();
