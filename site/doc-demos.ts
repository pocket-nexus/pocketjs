// site/doc-demos.ts — the `:::demo <app>` directive's resolver.
//
// A docs page embeds a live PocketJS app by naming an apps/<app>/ directory.
// Everything the page needs (dist artifact names, logical size, raster
// density, the command that produces the artifact) is derived here from that
// app's pocket.app.json, so the markdown never repeats a build detail and the
// site build and the prerequisite chain in tools/site-build.ts cannot drift.
//
// Imported by BOTH site/build.ts (to emit the figure and copy the artifacts)
// and tools/site-build.ts (to build the artifacts before the site runs).

import { existsSync, readFileSync, readdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;

export interface DocDemo {
  /** apps/<app>/ directory name, the token written after `:::demo`. */
  app: string;
  /** pocket.app.json app.output — the dist artifact's base name. */
  output: string;
  framework: "solid" | "vue-vapor" | "octane";
  /** pocket.app.json id, handed to the AppInstance realm as its package id. */
  packageId: string;
  title: string;
  /** Logical viewport in PocketJS pixels. */
  width: number;
  height: number;
  /** Raster density the artifact is baked at; the host must init to match. */
  rasterDensity: number;
  /** Absolute path of the built bundle. */
  distJs: string;
  /** Absolute path of the built pak. */
  distPak: string;
  /** File name (no directory) the site serves the bundle under. */
  bundleFile: string;
  pakFile: string;
  /** The exact command that produces both artifacts. */
  buildCommand: string;
}

// framework/compiler/jsx-plugin.ts FRAMEWORKS[*].outputSuffix. tools/build.ts:207
// names a low-level artifact `${app.output}${outputSuffix}`; only a resolved
// build plan drops the suffix, and a docs demo is a low-level build.
const OUTPUT_SUFFIX = { solid: "", "vue-vapor": ".vue-vapor", octane: ".octane" } as const;

/** The legacy touch wire form packs x:9,y:9 (framework/src/touch.ts). */
const LEGACY_COORD_LIMIT = 512;

export class MissingDemoArtifactError extends Error {
  constructor(demo: DocDemo, missing: string[]) {
    super(
      `docs demo "${demo.app}" is missing ${missing.join(" and ")} — run: ${demo.buildCommand}`,
    );
    this.name = "MissingDemoArtifactError";
  }
}

/** Resolve `:::demo <app>` against apps/<app>/pocket.app.json. Throws if unbuilt. */
export function resolveDocDemo(app: string): DocDemo {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(app)) {
    throw new Error(`:::demo wants an apps/ directory name, got ${JSON.stringify(app)}`);
  }
  const manifestPath = `${ROOT}apps/${app}/pocket.app.json`;
  if (!existsSync(manifestPath)) {
    throw new Error(`:::demo ${app} has no manifest at apps/${app}/pocket.app.json`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    id?: string;
    title?: string;
    app?: {
      output?: string;
      framework?: keyof typeof OUTPUT_SUFFIX;
      viewport?: { fixed?: { logical?: [number, number] | [number, number][] | { min: [number, number] } } };
    };
  };
  const output = manifest.app?.output;
  const framework = manifest.app?.framework;
  // A preference list's first size; a range's lower bound.
  const declared = manifest.app?.viewport?.fixed?.logical;
  const logical = !declared ? undefined : "min" in declared ? declared.min
    : typeof declared[0] === "number" ? declared as [number, number] : (declared as [number, number][])[0];
  if (!output || !framework || !(framework in OUTPUT_SUFFIX)) {
    throw new Error(`apps/${app}/pocket.app.json declares no app.output/app.framework`);
  }
  if (!logical || logical.length !== 2) {
    throw new Error(`apps/${app}/pocket.app.json declares no app.viewport.fixed.logical`);
  }
  const [width, height] = logical;
  if (width >= LEGACY_COORD_LIMIT || height >= LEGACY_COORD_LIMIT) {
    // site/playground/embed.js packs contacts in the legacy 9-bit form.
    throw new Error(
      `:::demo ${app} is ${width}x${height}; the embedded pointer driver packs the legacy 9-bit touch form (max 511 per axis)`,
    );
  }
  const base = `${output}${OUTPUT_SUFFIX[framework]}`;
  return {
    app,
    output,
    framework,
    packageId: manifest.id ?? output,
    title: manifest.title ?? app,
    width,
    height,
    // A low-level build bakes glyph coverage and __POCKET_PIXEL_RATIO__ at
    // density 1, so the AppInstance realm must init the core at 1 as well.
    rasterDensity: 1,
    distJs: `${ROOT}dist/${base}.js`,
    distPak: `${ROOT}dist/${base}.pak`,
    bundleFile: `${base}.js`,
    pakFile: `${base}.pak`,
    buildCommand: `bun tools/build.ts ${output} --framework=${framework}`,
  };
}

/** Fail with the exact build command when either artifact is absent. */
export function assertDocDemoBuilt(demo: DocDemo): void {
  const missing: string[] = [];
  if (!existsSync(demo.distJs)) missing.push(`dist/${demo.bundleFile}`);
  if (!existsSync(demo.distPak)) missing.push(`dist/${demo.pakFile}`);
  if (missing.length > 0) throw new MissingDemoArtifactError(demo, missing);
}

export interface DocDemoDirective {
  app: string;
  /** Raw markdown between the opening line and the closing fence. */
  caption: string;
  /** Line range in the source, for the replace pass. */
  start: number;
  end: number;
}

/**
 * Naive pre-parse, line by line:
 *
 *     :::demo clear            a demo with no caption
 *
 *     :::demo clear            a demo whose caption is the fenced body
 *     Drag a row sideways.
 *     :::
 *
 * A closing fence is optional so a bare directive line stands alone; the body
 * runs to the first `:::` line or to the next blank line, whichever comes first.
 */
export function findDocDemoDirectives(markdown: string): DocDemoDirective[] {
  const lines = markdown.split("\n");
  const found: DocDemoDirective[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^:::demo[ \t]+(\S+)[ \t]*$/.exec(lines[i]);
    if (!open) continue;
    const body: string[] = [];
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === ":::") {
        end = j;
        break;
      }
      if (lines[j].trim() === "") break;
      body.push(lines[j]);
      end = j;
    }
    found.push({ app: open[1], caption: body.join(" ").trim(), start: i, end });
  }
  return found;
}

/** Every app named by a `:::demo` directive anywhere under a docs directory. */
export function docDemoAppsIn(docsDir: string): string[] {
  if (!existsSync(docsDir)) return [];
  const apps = new Set<string>();
  for (const file of readdirSync(docsDir)) {
    if (!file.endsWith(".md")) continue;
    for (const found of findDocDemoDirectives(readFileSync(docsDir + file, "utf8"))) {
      apps.add(found.app);
    }
  }
  return [...apps].sort();
}
