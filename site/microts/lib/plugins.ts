// Bun.build plugins for the MicroTS site bundle.
//
//   *.vue                         Vue SFC → JS (script setup, inline template); <style> blocks are
//                                 compiled into the `css` map and appended to the site stylesheet
//   *.md?tabs                     homepage code tabs, rendered at build time
//   microts:docs                  { slug: () => import(page) } for every page in catalog.ts
//   microts:files/<kind>/<name>   a directory of source files as { name: text } (starter, template,
//                                 example = apps/<name>, retro = a generated Pocket Retro game)
//   microts:retro-catalog         the generated Pocket Retro game list
//   microts:retro-sources         { id: () => import(game sources) } for every game in the list
//   microts:retro-code            { id: () => import(code tabs) } for every game in the list: game.ts and
//                                 the tabs of content/home/retro.md, rendered at build time
//   microts:build                 build constants (source commit, worker URLs)
//   microts:shells                the devices' shells: pictures from the front and where screens and keys are
//   retro, retro-sdk/*            the generated Pocket Retro SDK
import type { BunPlugin } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { compileScript, compileStyle, parse } from "@vue/compiler-sfc";
import { MICROTS_DOCS } from "../src/docs/catalog.ts";
import { getHighlighter, highlight, renderMarkdown, renderTabs } from "./markdown.ts";
import { ROOT, SITE, RETRO_OUT } from "./paths.ts";
import { shellProfiles } from "./shells.ts";

const js = (contents: string) => ({ contents, loader: "js" as const });

export function vuePlugin(css: Map<string, string>): BunPlugin {
  return {
    name: "microts-vue",
    setup(b) {
      b.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const { descriptor, errors } = parse(source, { filename: path });
        if (errors.length) throw new Error(`${relative(ROOT, path)}: ${errors[0]!.message}`);
        const id = Bun.hash(relative(ROOT, path)).toString(16).slice(0, 8);
        const scopeId = `data-v-${id}`;
        const scoped = descriptor.styles.some((s) => s.scoped);
        const script = compileScript(descriptor, {
          id,
          isProd: true,
          inlineTemplate: true,
          genDefaultAs: "__sfc__",
          templateOptions: { id, scoped, compilerOptions: { scopeId: scoped ? scopeId : undefined } },
          fs: { fileExists: existsSync, readFile: (f) => readFileSync(f, "utf8") },
        });
        const styles = descriptor.styles.map((style) => {
          const out = compileStyle({ source: style.content, filename: path, id: scopeId, scoped: style.scoped, isProd: true });
          if (out.errors.length) throw new Error(`${relative(ROOT, path)}: ${out.errors[0]!.message}`);
          return out.code;
        });
        if (styles.length) css.set(path, styles.join("\n"));
        else css.delete(path);
        let code = script.content;
        if (scoped) code += `\n__sfc__.__scopeId = ${JSON.stringify(scopeId)};`;
        code += "\nexport default __sfc__;\n";
        return { contents: code, loader: script.lang === "ts" ? "ts" : "js" };
      });
    },
  };
}

export function markdownPlugin(): BunPlugin {
  return {
    name: "microts-markdown",
    setup(b) {
      b.onResolve({ filter: /\.md\?tabs$/ }, (a) => ({
        path: resolve(dirname(a.importer), a.path.replace(/\?tabs$/, "")),
        namespace: "md-tabs",
      }));
      b.onLoad({ filter: /.*/, namespace: "md-tabs" }, async ({ path }) =>
        js(`export default ${JSON.stringify(await renderTabs(readFileSync(path, "utf8")))};`),
      );
      b.onResolve({ filter: /^microts:docs$/ }, () => ({ path: "docs", namespace: "microts-docs" }));
      b.onLoad({ filter: /.*/, namespace: "microts-docs" }, () =>
        js(
          `export const DOCS = {\n${MICROTS_DOCS.map((d) => `  ${JSON.stringify(d.slug)}: () => import(${JSON.stringify(`microts-doc:${d.slug}`)}),`).join("\n")}\n};`,
        ),
      );
      b.onResolve({ filter: /^microts-doc:/ }, (a) => ({ path: a.path.slice("microts-doc:".length), namespace: "microts-doc" }));
      b.onLoad({ filter: /.*/, namespace: "microts-doc" }, async ({ path: slug }) => {
        const file = join(ROOT, "site/content/docs", `${slug}.md`);
        return js(`export default ${JSON.stringify(await renderMarkdown(readFileSync(file, "utf8")))};`);
      });
    },
  };
}

const FILE_DIRS: Record<string, (name: string) => { dir: string; match: RegExp }> = {
  starter: (name) => ({ dir: join(SITE, "src/playground/ui/starters", name), match: /./ }),
  template: (name) => ({ dir: join(SITE, "src/playground/templates", name), match: /./ }),
  example: (name) => ({ dir: join(ROOT, "apps", name), match: /\.(vue|tsx?)$/ }),
  retro: (name) => ({ dir: join(RETRO_OUT, "games", name), match: /\.ts$/ }),
};

/** The files of one `microts:files/<kind>/<name>` module, for the build and the dev-server watcher. */
export function filesDir(spec: string): { dir: string; match: RegExp } {
  const [kind, name] = spec.split("/");
  const at = kind && name && FILE_DIRS[kind];
  if (!at) throw new Error(`unknown source set microts:files/${spec}`);
  return at(name!);
}

export function filesPlugin(): BunPlugin {
  return {
    name: "microts-files",
    setup(b) {
      b.onResolve({ filter: /^microts:files\// }, (a) => ({ path: a.path.slice("microts:files/".length), namespace: "microts-files" }));
      b.onLoad({ filter: /.*/, namespace: "microts-files" }, ({ path: spec }) => {
        const { dir, match } = filesDir(spec);
        if (!existsSync(dir)) throw new Error(`microts:files/${spec}: ${relative(ROOT, dir)} does not exist`);
        const files: Record<string, string> = {};
        for (const f of readdirSync(dir).sort()) {
          if (match.test(f) && statSync(join(dir, f)).isFile()) files[f] = readFileSync(join(dir, f), "utf8");
        }
        return js(`export default ${JSON.stringify(files)};`);
      });
    },
  };
}

/** `export default { id: () => import(spec(id)) }` for every game in the generated catalog. */
function lazyGames(spec: (id: string) => string): string {
  const { games } = JSON.parse(readFileSync(join(RETRO_OUT, "catalog.json"), "utf8")) as { games: { id: string }[] };
  const load = (id: string) => `  ${JSON.stringify(id)}: () => import(${JSON.stringify(spec(id))}),`;
  return `export default {\n${games.map((g) => load(g.id)).join("\n")}\n};`;
}

export function retroPlugin(): BunPlugin {
  const sdk = join(RETRO_OUT, "sdk");
  return {
    name: "microts-retro",
    setup(b) {
      b.onResolve({ filter: /^retro$/ }, () => ({ path: join(sdk, "retro.ts") }));
      b.onResolve({ filter: /^retro-sdk\// }, (a) => ({ path: join(sdk, a.path.slice("retro-sdk/".length) + ".ts") }));
      b.onResolve({ filter: /^microts:retro-catalog$/ }, () => ({ path: join(RETRO_OUT, "catalog.json") }));
      b.onResolve({ filter: /^microts:retro-sources$/ }, () => ({ path: "retro-sources", namespace: "microts-retro-sources" }));
      b.onLoad({ filter: /.*/, namespace: "microts-retro-sources" }, () => js(lazyGames((id) => `microts:files/retro/${id}`)));
      // The home page code panel: one chunk per game, loaded when the game is picked.
      b.onResolve({ filter: /^microts:retro-code$/ }, () => ({ path: "retro-code", namespace: "microts-retro-code" }));
      b.onLoad({ filter: /.*/, namespace: "microts-retro-code" }, () => js(lazyGames((id) => `microts-retro-code:${id}`)));
      b.onResolve({ filter: /^microts-retro-code:/ }, (a) => ({ path: a.path.slice("microts-retro-code:".length), namespace: "microts-retro-game-code" }));
      b.onLoad({ filter: /.*/, namespace: "microts-retro-game-code" }, async ({ path: id }) => {
        const source = readFileSync(join(RETRO_OUT, "games", id, "game.ts"), "utf8");
        const extra = await renderTabs(readFileSync(join(SITE, "content/home/retro.md"), "utf8").replaceAll("{{game}}", id));
        const tabs = [{ title: "game.ts", html: highlight(await getHighlighter(), source, "ts") }, ...extra.map(({ title, html }) => ({ title, html }))];
        return js(`export default ${JSON.stringify(tabs)};`);
      });
    },
  };
}

export function constantsPlugin(name: string, values: Record<string, unknown>): BunPlugin {
  return {
    name: `microts-${name}`,
    setup(b) {
      const filter = new RegExp(`^microts:${name}$`);
      b.onResolve({ filter }, () => ({ path: name, namespace: `microts-${name}` }));
      b.onLoad({ filter: /.*/, namespace: `microts-${name}` }, () =>
        js(Object.entries(values).map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`).join("\n")),
      );
    },
  };
}

export function shellsPlugin(): BunPlugin {
  return {
    name: "microts-shells",
    setup(b) {
      b.onResolve({ filter: /^microts:shells$/ }, () => ({ path: "shells", namespace: "microts-shells" }));
      b.onLoad({ filter: /.*/, namespace: "microts-shells" }, async () => js(`export const SHELLS = ${JSON.stringify(await shellProfiles())};`));
    },
  };
}
