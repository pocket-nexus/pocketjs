// site/microts/build.ts — the MicroTS site (docs + playground), a Vue SPA.
//
//   bun site/microts/build.ts             # -> site/microts/dist/  (the deployable tree)
//   bun site/microts/build.ts --prepare   # only generate .cache/retro/ (typecheck needs the retro SDK)
//   bun site/microts/serve.ts             # dev server: rebuilds the app on change
//
// Produces:
//   /index.html, /assets/*       the SPA (src/), its stylesheet and the retro worker + audio worklet
//   /pocket/*                    the UI preview kit, bundled from this checkout (lib/kit.ts)
//   /retro/<id>/*                Pocket Retro game assets and posters (lib/retro.ts)
//   /shells/*                    the playground devices' pictures (lib/shells.ts)
//
// The docs pages render from site/content/docs/ at build time (src/docs/catalog.ts
// picks the pages from site/nav.ts). The playground's MicroTS examples come
// from apps/vue-sfc-lab and apps/solid-aot-lab.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { buildKit } from "./lib/kit.ts";
import { ROOT, SITE, OUT, CACHE, RETRO_OUT } from "./lib/paths.ts";
import { constantsPlugin, filesPlugin, markdownPlugin, retroPlugin, shellsPlugin, vuePlugin } from "./lib/plugins.ts";
import { prepareRetro } from "./lib/retro.ts";
import { copyShells } from "./lib/shells.ts";

export function sourceCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function check(res: Awaited<ReturnType<typeof Bun.build>>, what: string) {
  if (res.success) return;
  for (const l of res.logs) console.error(String(l));
  throw new Error(`${what}: bundle failed`);
}

const kib = (n: number) => `${(n / 1024).toFixed(0)} KiB`;

/** Bundles the SPA, the retro worker and the stylesheet into dist/assets/ and writes dist/index.html. */
export async function buildApp(opts: { dev: boolean; commit: string }): Promise<void> {
  const t0 = performance.now();
  const assets = join(OUT, "assets");
  rmSync(assets, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true });
  const define = {
    "process.env.NODE_ENV": JSON.stringify(opts.dev ? "development" : "production"),
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  };
  const common = {
    target: "browser" as const,
    format: "esm" as const,
    minify: !opts.dev,
    sourcemap: opts.dev ? ("linked" as const) : ("none" as const),
    define,
  };

  // Workers load by URL, so they are separate bundles with a content-hash query.
  const workerUrl = async (entry: string, name: string) => {
    const res = await Bun.build({ ...common, entrypoints: [join(SITE, entry)], outdir: assets, naming: `${name}.[ext]`, plugins: [retroPlugin()] });
    check(res, entry);
    const out = res.outputs.find((o) => o.kind === "entry-point")!;
    return `/assets/${basename(out.path)}?v=${Bun.hash(await out.text()).toString(16).slice(0, 10)}`;
  };
  const RETRO_WORKER_URL = await workerUrl("src/playground/retro/worker.ts", "retro-worker");
  const RETRO_MIXER_URL = await workerUrl("src/playground/retro/mixer.worklet.ts", "retro-mixer");

  const sfcCss = new Map<string, string>();
  const app = await Bun.build({
    ...common,
    entrypoints: [join(SITE, "src/main.ts")],
    outdir: assets,
    splitting: true,
    naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    plugins: [
      vuePlugin(sfcCss),
      markdownPlugin(),
      filesPlugin(),
      retroPlugin(),
      shellsPlugin(),
      constantsPlugin("build", { COMMIT: opts.commit, RETRO_WORKER_URL, RETRO_MIXER_URL }),
    ],
  });
  check(app, "src/main.ts");
  const entry = basename(app.outputs.find((o) => o.kind === "entry-point")!.path);

  // Tailwind scans src/ (see the @source lines in main.css); SFC <style> blocks follow it.
  const twOut = join(CACHE, "tailwind.css");
  const tw = Bun.spawnSync(
    ["bunx", "@tailwindcss/cli", "-i", join(SITE, "src/styles/main.css"), "-o", twOut, ...(opts.dev ? [] : ["--minify"])],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (tw.exitCode !== 0) {
    console.error(tw.stderr.toString());
    throw new Error("tailwind build failed");
  }
  const css = readFileSync(twOut, "utf8") + "\n" + [...sfcCss.keys()].sort().map((k) => sfcCss.get(k)).join("\n");
  const cssName = `site-${Bun.hash(css).toString(16).slice(0, 10)}.css`;
  writeFileSync(join(assets, cssName), css);

  const html = readFileSync(join(SITE, "index.html"), "utf8")
    .replace("<!-- microts:styles -->", `<link rel="stylesheet" href="/assets/${cssName}" />`)
    .replace(
      "<!-- microts:scripts -->",
      `<script type="module" src="/assets/${entry}"></script>` +
        (opts.dev ? `\n    <script>new EventSource("/__reload").onmessage = () => location.reload();</script>` : ""),
    );
  writeFileSync(join(OUT, "index.html"), html);

  const jsBytes = app.outputs.filter((o) => o.path.endsWith(".js")).reduce((n, o) => n + o.size, 0);
  console.log(
    `app: ${app.outputs.filter((o) => o.path.endsWith(".js")).length} js files ${kib(jsBytes)}, ${cssName} ${kib(css.length)} (${Math.round(performance.now() - t0)} ms)`,
  );
}

/** Static files: the site's public/, shared Pocket brand assets, the devices' shells and the generated retro assets. */
export async function copyStatic(): Promise<void> {
  cpSync(join(SITE, "public"), OUT, { recursive: true });
  for (const f of ["press-start-2p-latin.woff2", "OFL-PressStart2P.txt"]) cpSync(join(ROOT, "site/assets/fonts", f), join(OUT, "fonts", f));
  cpSync(join(ROOT, "site/pocket3d/mark.svg"), join(OUT, "pocket3d-mark.svg"));
  cpSync(join(RETRO_OUT, "public"), join(OUT, "retro"), { recursive: true });
  await copyShells(OUT);
}

export function buildWasm(): void {
  const proc = Bun.spawnSync(["bun", "tools/wasm.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error("bun tools/wasm.ts failed");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  await prepareRetro();
  if (!args.includes("--prepare")) {
    const commit = sourceCommit();
    console.log(`MicroTS site @ pocketjs ${commit.slice(0, 12)} → ${relative(ROOT, OUT)}/`);
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    buildWasm();
    await buildKit(OUT, commit);
    await buildApp({ dev: false, commit });
    await copyStatic();
    if (!existsSync(join(OUT, "index.html"))) throw new Error("index.html was not written");
  }
}
