// site/playground/compiler-entry.ts — the WHOLE PocketJS build pipeline,
// running in the browser. Bun bundles this (browser, ESM, with the node-builtin
// shims in ./babel-shims) into site/dist/pg/compiler.js, which the playground
// lazy-loads. compileApp(source) does exactly what tools/build.ts does — the
// SAME @babel/core + babel-preset-solid transform, the SAME framework/compiler/tailwind.ts
// class compiler, the SAME framework/compiler/bake-font.ts atlas baker, the SAME
// framework/compiler/pak.ts packer — so a playground app compiles byte-identically to a
// real `bun tools/build.ts` run. Only two build-time-only pieces are swapped
// for browser equivalents: fonts/images are fetched (not read from disk) and
// images are rasterized with a <canvas> instead of the node PNG/SVG decoders.

import { transformAsync, type PluginObj } from "@babel/core";
import solidPreset from "babel-preset-solid";
import tsPreset from "@babel/preset-typescript";
import { transformVueJsxVapor } from "vue-jsx-vapor/api";
import { parse as parseFont, type Font } from "opentype.js";

import { compileClasses, fontSlotInfo } from "../../framework/compiler/tailwind.ts";
import { registerAnimationTheme } from "../../framework/compiler/animation.ts";
import motionsManifest from "../../apps/motions/pocket.app.json";
import musicManifest from "../../apps/music/pocket.app.json";

// The playground compiles single-file demos without their app-dir
// pocket.app.json, so install the demo themes that define keyframes —
// motions (the homepage/blog motion studies) and music (the Octane
// equalizer's baked bar timelines) — merged as the playground-wide default.
// Namespaces are disjoint; a collision would mean a demo rename, not magic.
registerAnimationTheme({
  keyframes: { ...motionsManifest.app.theme?.keyframes, ...musicManifest.app.theme?.keyframes },
  animation: { ...motionsManifest.app.theme?.animation, ...musicManifest.app.theme?.animation },
});
import { bakeSlot } from "../../framework/compiler/bake-font.ts";
import {
  PAK_DTYPE,
  KEY_STYLES,
  encodeImageEntry,
  encodeSpriteEntry,
  keyFont,
  keyImage,
  keySprite,
  pack,
  placeholderImage,
  type DecodedImage,
  type PakBlob,
} from "../../framework/compiler/pak.ts";
import { PSM } from "../../contracts/spec/spec.ts";

/** babel `moduleName` — the specifier the universal transform imports its
 *  runtime helpers from. The playground import-map points it at runtime.js. */
const SOLID_RENDERER_MODULE = "@pocketjs/framework/solid/renderer";

/** Octane universal-renderer descriptor — mirrors framework/compiler/jsx-plugin.ts
 *  OCTANE_RENDERER_DESCRIPTOR; the import map points the module id at
 *  runtime-octane.js. */
const OCTANE_RENDERER = {
  id: "pocket",
  module: "@pocketjs/framework/octane/renderer",
  target: "universal",
  server: "unsupported",
  text: "host",
  capabilities: ["portal"],
} as const;

type PlaygroundFramework = "solid" | "vue-vapor" | "octane";

interface SpriteMeta {
  cols: number;
  rows: number;
  frames: number;
  step: number;
  psm?: number;
}

export interface CompileResult {
  /** ESM: JSX compiled to universal-renderer calls, default export = the app. */
  code: string;
  /** class literal → styleId (index.ts mount() takes this as opts.styles). */
  styleMap: Record<string, number>;
  /** styles.bin + font atlases + images (mount() takes this as opts.pak). */
  pak: ArrayBuffer;
  classCount: number;
  slotCount: number;
  imageNames: string[];
}

// ---------------------------------------------------------------------------
// pass-1 collector — mirrors framework/compiler/jsx-plugin.ts makeCollector: candidate
// class strings + text codepoints from the PRISTINE AST, plus the same loud
// lints (classList / interpolated class / banned solid imports / HTML entities).
// ---------------------------------------------------------------------------

const BANNED_SOLID = new Set(["createResource", "useTransition", "startTransition"]);

interface Collected {
  classStrings: string[];
  codepoints: Set<number>;
}

function collectorPlugin(out: Collected, framework: PlaygroundFramework): PluginObj {
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!s) return;
    for (const ch of s) out.codepoints.add(ch.codePointAt(0)!);
    if (!seen.has(s)) {
      seen.add(s);
      out.classStrings.push(s);
    }
  };
  return {
    name: "pocketjs-collect",
    visitor: {
      Program: {
        enter(program) {
          program.traverse({
            StringLiteral(path) {
              add(path.node.value);
            },
            TemplateLiteral(path) {
              for (const q of path.node.quasis) add(q.value.cooked ?? q.value.raw);
            },
            JSXText(path) {
              const raw = path.node.extra?.raw;
              if (typeof raw === "string" && raw !== path.node.value) {
                throw path.buildCodeFrameError(
                  "PocketJS: HTML entities in JSX text aren't decoded by the universal renderer — " +
                    'write the literal character (é, ♥) or a string expression {"\\u00e9"} instead.',
                );
              }
              add(path.node.value);
            },
            JSXAttribute(path) {
              const name = path.node.name;
              if (name.type === "JSXIdentifier" && name.name === "classList") {
                throw path.buildCodeFrameError(
                  "PocketJS: `classList` is not supported. Use ternaries of FULL class literals: " +
                    'class={cond() ? "p-2 bg-red-500" : "p-2 bg-slate-700"}',
                );
              }
              if (name.type === "JSXIdentifier" && name.name === "class") {
                const v = path.node.value;
                if (
                  v?.type === "JSXExpressionContainer" &&
                  v.expression.type === "TemplateLiteral" &&
                  v.expression.expressions.length > 0
                ) {
                  throw path.buildCodeFrameError(
                    "PocketJS: template-interpolated class fragments aren't supported. " +
                      "Styles compile at build time — use ternaries of FULL literals.",
                  );
                }
              }
            },
            ImportDeclaration(path) {
              if (framework !== "solid") return;
              const src = path.node.source.value;
              if (src !== "solid-js" && !src.startsWith("solid-js/")) return;
              for (const spec of path.node.specifiers) {
                if (spec.type !== "ImportSpecifier") continue;
                const imported =
                  spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
                if (BANNED_SOLID.has(imported)) {
                  throw path.buildCodeFrameError(
                    `PocketJS: solid-js \`${imported}\` isn't supported — the PSP QuickJS host has no ` +
                      "scheduler. Use signals + createEffect, or animate() for motion.",
                  );
                }
              }
            },
          });
        },
      },
    },
  };
}

/** Run the exact build transform in the browser. Throws with a code frame on
 *  lint/syntax errors (message carries the frame). */
export async function transformAppSource(
  source: string,
  framework: PlaygroundFramework,
  baseUrl = typeof location === "undefined" ? "https://pocketjs.dev/" : location.href,
): Promise<{ code: string; collected: Collected }> {
  const collected: Collected = { classStrings: [], codepoints: new Set() };
  let res;
  if (framework === "vue-vapor") {
    await transformAsync(source, {
      filename: "app.tsx",
      presets: [[tsPreset, {}]],
      parserOpts: { plugins: ["jsx"] },
      plugins: [collectorPlugin(collected, framework)],
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
    const vapor = transformVueJsxVapor(
      source,
      "app.tsx",
      {
        compiler: {
          runtimeModuleName: new URL("/pg/vue-jsx-vapor/vapor.js", baseUrl).href,
        },
      },
      false,
      false,
      false,
    );
    res = await transformAsync(vapor.code, {
      filename: "app.tsx",
      presets: [[tsPreset, {}]],
      parserOpts: { plugins: ["jsx"] },
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
  } else if (framework === "octane") {
    await transformAsync(source, {
      filename: "app.tsx",
      presets: [[tsPreset, {}]],
      parserOpts: { plugins: ["jsx"] },
      plugins: [collectorPlugin(collected, framework)],
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
    // Load this branch lazily. Octane marks its package side-effect free; a
    // static import from 0.1.26 was pruned by Bun while its call site survived,
    // leaving every Octane demo with an undefined minified binding.
    const { compile } = await import("octane/compiler");
    res = compile(source, "app.tsx", { mode: "client", renderer: OCTANE_RENDERER }) as {
      code: string;
    };
  } else {
    res = await transformAsync(source, {
      filename: "app.tsx",
      presets: [
        [solidPreset, { generate: "universal", moduleName: SOLID_RENDERER_MODULE }],
        [tsPreset, {}],
      ],
      parserOpts: { plugins: ["jsx"] },
      plugins: [collectorPlugin(collected, framework)],
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
  }
  if (!res?.code && res?.code !== "") throw new Error("PocketJS: transform produced no output");
  return { code: res.code!, collected };
}

// ---------------------------------------------------------------------------
// fonts — fetch + parse Inter once, then bakeSlot() (the real baker) per slot.
// ---------------------------------------------------------------------------

let fontBase = "/pg/fonts/";
const fontCache: Record<"regular" | "bold", Font | null> = { regular: null, bold: null };

async function getFont(bold: boolean): Promise<Font> {
  const key = bold ? "bold" : "regular";
  if (!fontCache[key]) {
    const file = bold ? "Inter-Bold.ttf" : "Inter-Regular.ttf";
    const res = await fetch(fontBase + file);
    if (!res.ok) throw new Error(`PocketJS: font ${file} not found at ${fontBase}`);
    fontCache[key] = parseFont(await res.arrayBuffer());
  }
  return fontCache[key]!;
}

/** Mirrors framework/compiler/bake-font.ts bakeAtlases charset rule, but with fetched
 *  fonts. Charset = ASCII 32..126 + collected codepoints + extraChars. */
async function bakeAtlases(codepoints: Iterable<number>, slots: number[], extraChars: string) {
  const cps = new Set<number>();
  for (let c = 32; c <= 126; c++) cps.add(c);
  for (const cp of codepoints) if (cp >= 32 && cp !== 127) cps.add(cp);
  for (const ch of extraChars) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 32 && cp !== 127) cps.add(cp);
  }
  const chars = [...cps].sort((a, b) => a - b);
  const out = [];
  for (const slot of [...slots].sort((a, b) => a - b)) {
    const { px, bold } = fontSlotInfo(slot);
    out.push(bakeSlot(await getFont(bold), slot, px, bold, chars));
  }
  return out;
}

// ---------------------------------------------------------------------------
// images — rasterize png/svg to RGBA with a <canvas>, snapped to a pow2 cell
// (encodeImageEntry requires pow2 <= 512). Missing asset -> checker placeholder.
// ---------------------------------------------------------------------------

let assetBase = "/demo-assets/";
const IMAGE_RE = /^[\w./-]+\.(?:png|svg)$/i;
const nearestPow2 = (n: number) => {
  let p = 1;
  while (p < n) p <<= 1;
  return Math.max(8, Math.min(512, p));
};

function svgImageBlob(source: string): Blob {
  const normalized = /<svg\b[^>]*\bxmlns\s*=/i.test(source)
    ? source
    : source.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return new Blob([normalized], { type: "image/svg+xml" });
}

async function rasterizeImage(name: string): Promise<DecodedImage> {
  const res = await fetch(assetBase + name).catch(() => null);
  if (!res || !res.ok) return placeholderImage();
  // SVG markup copied from app directories is also accepted by native builds,
  // where an XML namespace is optional. Browser image decoders require it on
  // standalone SVG blobs, so normalize the root before creating the image URL.
  const blob = name.toLowerCase().endsWith(".svg")
    ? svgImageBlob(await res.text())
    : await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new window.Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    const w = nearestPow2(img.naturalWidth || img.width || 64);
    const h = nearestPow2(img.naturalHeight || img.height || 64);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const rgba = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer.slice(0));
    return { width: w, height: h, rgba };
  } catch {
    return placeholderImage();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// compileApp — the public entry the playground calls on every (debounced) edit.
// ---------------------------------------------------------------------------

export function configure(opts: { fontBaseUrl?: string; assetBaseUrl?: string }): void {
  if (opts.fontBaseUrl) fontBase = opts.fontBaseUrl;
  if (opts.assetBaseUrl) assetBase = opts.assetBaseUrl;
}

export async function compileApp(
  source: string,
  opts: {
    extraChars?: string;
    framework?: PlaygroundFramework;
    spriteMeta?: Record<string, SpriteMeta>;
  } = {},
): Promise<CompileResult> {
  const framework = opts.framework ?? "solid";
  const { code, collected } = await transformAppSource(source, framework);

  const styles = compileClasses(collected.classStrings);
  const atlases = await bakeAtlases(collected.codepoints, styles.usedFontSlots, opts.extraChars ?? "");

  const blobs: PakBlob[] = [
    { key: KEY_STYLES, dtype: PAK_DTYPE.u8, data: styles.bin },
    ...atlases.map((a) => ({ key: keyFont(a.slot), dtype: PAK_DTYPE.u8, data: a.bytes })),
  ];

  const imageNames = [...new Set(collected.classStrings.filter((s) => IMAGE_RE.test(s)))];
  for (const name of imageNames) {
    const img = await rasterizeImage(name);
    const sprite = opts.spriteMeta?.[name];
    if (sprite) {
      blobs.push({
        key: keySprite(name),
        dtype: PAK_DTYPE.u8,
        data: encodeSpriteEntry(
          {
            atlasW: img.width,
            atlasH: img.height,
            frameCount: sprite.frames,
            cols: sprite.cols,
            frameStep: sprite.step,
            rgba: img.rgba,
          },
          sprite.psm ?? PSM.PSM_8888,
        ),
      });
    } else {
      blobs.push({ key: keyImage(name), dtype: PAK_DTYPE.u8, data: encodeImageEntry(img, PSM.PSM_8888) });
    }
  }

  const packed = pack(blobs);
  // Fresh, offset-0 ArrayBuffer so mount()'s pak reader sees exactly the pack.
  const pak = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);

  return {
    code,
    styleMap: styles.ids,
    pak,
    classCount: styles.records.length,
    slotCount: atlases.length,
    imageNames,
  };
}
