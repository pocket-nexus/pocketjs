// The MicroTS playground's in-browser compiler (bundled into /pocket/compiler-worker.js).
//
// site/microts/lib/kit.ts bundles it from site/microts/kit/ in this checkout,
// so relative imports resolve from that directory (../../../framework/...).
//
// Same pipeline as site/playground/compiler-entry.ts and framework/compiler/vue-sfc-compile.ts:
//   .vue  → class normalization → @vue/compiler-sfc (vapor, inlineTemplate) → Babel type strip
//   .tsx  → babel-preset-solid (universal, @pocketjs/framework/solid/renderer) + Babel type strip
//   .ts   → Babel type strip
// String literals from every file go to tailwind.ts (classes), bake-font.ts (glyphs) and pak.ts (packing).
// Differs from the native AOT build: no MicroTS admission check or model transforms, so
// async tasks in compiled mode (await frames() etc.) cannot be previewed here.
import { transformAsync, parseSync, type PluginObj, type NodePath } from "@babel/core";
import generate from "@babel/generator";
import solidPreset from "babel-preset-solid";
import tsPreset from "@babel/preset-typescript";
import { parse as parseSfc, compileScript } from "@vue/compiler-sfc";
import { parse as parseTemplate, NodeTypes, type ElementNode, type TemplateChildNode } from "@vue/compiler-dom";
import { parse as parseFont, type Font } from "opentype.js";

import { compileClasses, fontSlotInfo } from "../../../framework/compiler/tailwind.ts";
import { bakeSlot } from "../../../framework/compiler/bake-font.ts";
import { PAK_DTYPE, KEY_STYLES, encodeImageEntry, keyFont, keyImage, pack, placeholderImage, type DecodedImage, type PakBlob } from "../../../framework/compiler/pak.ts";
import { PSM } from "../../../contracts/spec/spec.ts";

export type Framework = "vue-vapor" | "solid";

export interface CompileInput {
  files: Record<string, string>;
  entry: string;
  framework: Framework;
}

export interface CompiledModule {
  path: string;
  code: string;
  /** Project modules this one imports; code holds MODULE_TOKEN + path placeholders the preview page swaps for blob URLs */
  deps: string[];
}

export interface CompileOutput {
  entry: string;
  modules: Record<string, CompiledModule>;
  styles: Record<string, number>;
  pak: ArrayBuffer;
  stats: { files: number; classes: number; fontSlots: number; images: number; pakBytes: number; ms: number };
}

export interface CompileDiagnostic {
  file: string;
  message: string;
  line?: number;
  column?: number;
}

export class CompileError extends Error {
  constructor(public diagnostic: CompileDiagnostic) {
    super(diagnostic.message);
  }
}

export const MODULE_TOKEN = "__pocket_module__:";
const SOLID_RENDERER_MODULE = "@pocketjs/framework/solid/renderer";
const EXTENSIONS = [".ts", ".tsx", ".vue"];

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function resolveRelative(files: Record<string, string>, from: string, spec: string): string | undefined {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  const base = normalize(dir + spec);
  if (base in files) return base;
  for (const ext of EXTENSIONS) if (base + ext in files) return base + ext;
  for (const ext of EXTENSIONS) if (`${base}/index${ext}` in files) return `${base}/index${ext}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Babel plugins: collect strings (class candidates + glyph codepoints) and rewrite project-relative imports
// ---------------------------------------------------------------------------

interface Collected {
  classStrings: Set<string>;
  codepoints: Set<number>;
}

function collectorPlugin(out: Collected): PluginObj {
  const add = (s: string) => {
    if (!s) return;
    for (const ch of s) out.codepoints.add(ch.codePointAt(0)!);
    out.classStrings.add(s);
  };
  return {
    name: "microts-collect",
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
              add(path.node.value);
            },
            JSXAttribute(path) {
              const name = path.node.name;
              if (name.type === "JSXIdentifier" && name.name === "classList") {
                throw path.buildCodeFrameError(
                  'PocketJS: `classList` is not supported. Use ternaries of full class literals: class={cond() ? "p-2 bg-red-500" : "p-2 bg-slate-700"}',
                );
              }
              const v = path.node.value;
              if (
                name.type === "JSXIdentifier" &&
                name.name === "class" &&
                v?.type === "JSXExpressionContainer" &&
                v.expression.type === "TemplateLiteral" &&
                v.expression.expressions.length > 0
              ) {
                throw path.buildCodeFrameError(
                  "PocketJS: template-interpolated class fragments are not supported. Styles compile at build time; use ternaries of full literals.",
                );
              }
            },
          });
        },
      },
    },
  };
}

function rewritePlugin(files: Record<string, string>, from: string, deps: Set<string>): PluginObj {
  const rewrite = (path: NodePath<any>) => {
    const source = path.node.source;
    if (!source || typeof source.value !== "string") return;
    const spec: string = source.value;
    if (!spec.startsWith("./") && !spec.startsWith("../")) return;
    const target = resolveRelative(files, from, spec);
    if (!target) throw path.buildCodeFrameError(`Cannot find module "${spec}" in this project`);
    deps.add(target);
    source.value = MODULE_TOKEN + target;
  };
  return {
    name: "microts-rewrite",
    visitor: {
      ImportDeclaration: rewrite,
      ExportNamedDeclaration: rewrite,
      ExportAllDeclaration: rewrite,
    },
  };
}

// ---------------------------------------------------------------------------
// Vue: merge a static class and a ternary :class into full literals (mirrors normalizeVueAotClasses in
// microts/compiler/aot-browser.ts, which uses the TypeScript compiler API; this does the same with Babel)
// ---------------------------------------------------------------------------

function mergeClassExpression(prefix: string, node: any): any | undefined {
  if (node.type === "StringLiteral") return { type: "StringLiteral", value: `${prefix} ${node.value}`.trim() };
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return { type: "StringLiteral", value: `${prefix} ${node.quasis[0].value.cooked}`.trim() };
  if (node.type === "ConditionalExpression") {
    const yes = mergeClassExpression(prefix, node.consequent);
    const no = mergeClassExpression(prefix, node.alternate);
    if (yes && no) return { ...node, consequent: yes, alternate: no, extra: undefined };
  }
  return undefined;
}

function normalizeVueClasses(source: string, filename: string): string {
  const { descriptor } = parseSfc(source, { filename });
  if (!descriptor.template || !descriptor.scriptSetup) return source;
  const hosts = new Set<string>();
  const script = parseSync(descriptor.scriptSetup.content, {
    filename: filename + ".ts",
    presets: [[tsPreset, {}]],
    babelrc: false,
    configFile: false,
  });
  for (const statement of script?.program.body ?? []) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "@pocketjs/framework/vue-vapor/components") continue;
    for (const spec of statement.specifiers) {
      if (spec.type !== "ImportSpecifier") continue;
      const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
      if (["View", "Text", "Image"].includes(imported)) hosts.add(spec.local.name);
    }
  }
  const root = parseTemplate(descriptor.template.content);
  const offset = descriptor.template.loc.start.offset;
  const edits: { start: number; end: number; text: string }[] = [];
  const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const visit = (node: ElementNode) => {
    if (hosts.has(node.tag)) {
      const fixed = node.props.find((p) => p.type === NodeTypes.ATTRIBUTE && p.name === "class");
      const dynamic = node.props.find(
        (p) => p.type === NodeTypes.DIRECTIVE && p.name === "bind" && p.arg?.type === NodeTypes.SIMPLE_EXPRESSION && p.arg.content === "class",
      );
      if (fixed?.type === NodeTypes.ATTRIBUTE && fixed.value && dynamic?.type === NodeTypes.DIRECTIVE && dynamic.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
        let expression: any;
        try {
          const file = parseSync(`(${dynamic.exp.content});`, { filename: "class.ts", presets: [[tsPreset, {}]], babelrc: false, configFile: false });
          const statement = file?.program.body[0];
          expression = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
        } catch {
          expression = undefined;
        }
        if (expression?.type === "ConditionalExpression") {
          const merged = mergeClassExpression(fixed.value.content, expression);
          if (merged) {
            const text = generate(merged as never, { comments: false }).code;
            edits.push({ start: offset + fixed.loc.start.offset, end: offset + fixed.loc.end.offset, text: "" });
            edits.push({
              start: offset + dynamic.loc.start.offset,
              end: offset + dynamic.loc.end.offset,
              text: `:class="${escapeAttribute(text)}"`,
            });
          }
        }
      }
    }
    for (const child of node.children) if (child.type === NodeTypes.ELEMENT) visit(child);
  };
  for (const child of root.children as TemplateChildNode[]) if (child.type === NodeTypes.ELEMENT) visit(child);
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

function compileVue(source: string, filename: string): string {
  source = normalizeVueClasses(source, filename);
  const { descriptor, errors } = parseSfc(source, { filename, templateParseOptions: { comments: false } });
  if (errors.length > 0) throw sfcError(filename, errors[0]);
  if (!descriptor.scriptSetup) throw new CompileError({ file: filename, message: `${filename} must use <script setup lang="ts">` });
  if (!descriptor.template) throw new CompileError({ file: filename, message: `${filename} must contain a <template>` });
  if (descriptor.styles.length > 0)
    throw new CompileError({ file: filename, message: `<style> blocks are not supported in ${filename}; use PocketJS class literals or :style` });
  try {
    return compileScript(descriptor, {
      id: `pocketjs-${filename.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      inlineTemplate: true,
      sourceMap: false,
      vapor: true,
      templateOptions: { compilerOptions: { mode: "module", comments: false } },
    }).content;
  } catch (e) {
    throw sfcError(filename, e);
  }
}

function sfcError(file: string, e: unknown): CompileError {
  const err = e as { message?: string; loc?: { start: { line: number; column: number } } };
  return new CompileError({
    file,
    message: err.message ?? String(e),
    line: err.loc?.start.line,
    column: err.loc?.start.column,
  });
}

// ---------------------------------------------------------------------------
// Fonts and images
// ---------------------------------------------------------------------------

let fontBase = "/pocket/fonts/";
let assetBase = "/pocket/assets/";
const fontCache: Record<"regular" | "bold", Promise<Font> | null> = { regular: null, bold: null };

export function configure(opts: { fontBaseUrl?: string; assetBaseUrl?: string }): void {
  if (opts.fontBaseUrl) fontBase = opts.fontBaseUrl;
  if (opts.assetBaseUrl) assetBase = opts.assetBaseUrl;
}

function getFont(bold: boolean): Promise<Font> {
  const key = bold ? "bold" : "regular";
  fontCache[key] ??= fetch(fontBase + (bold ? "Inter-Bold.ttf" : "Inter-Regular.ttf")).then(async (res) => {
    if (!res.ok) throw new Error(`font not found at ${res.url}`);
    return parseFont(await res.arrayBuffer());
  });
  return fontCache[key]!;
}

const IMAGE_RE = /^[\w./-]+\.png$/i;
const nearestPow2 = (n: number) => {
  let p = 1;
  while (p < n) p <<= 1;
  return Math.max(8, Math.min(512, p));
};

async function rasterizeImage(name: string): Promise<DecodedImage> {
  try {
    const res = await fetch(assetBase + name);
    if (!res.ok) return placeholderImage();
    const bitmap = await createImageBitmap(await res.blob());
    const w = nearestPow2(bitmap.width);
    const h = nearestPow2(bitmap.height);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return { width: w, height: h, rgba: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer.slice(0)) };
  } catch {
    return placeholderImage();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function babelError(file: string, e: unknown): CompileError {
  if (e instanceof CompileError) return e;
  const err = e as { message?: string; loc?: { line: number; column: number } };
  // Babel's message carries a file-path prefix and a code frame; keep the frame, drop the duplicate path
  const message = String(err.message ?? e).replace(/^\/?[^:\n]*:\s*/, "");
  // .vue is template-compiled by this step, so the frame and line point at compiled output, not source; keep the message only
  if (file.endsWith(".vue")) return new CompileError({ file, message: message.split("\n")[0]!.replace(/\s*\(\d+:\d+\)$/, "") });
  return new CompileError({ file, message, line: err.loc?.line, column: err.loc ? err.loc.column + 1 : undefined });
}

export async function compileProject(input: CompileInput): Promise<CompileOutput> {
  const t0 = performance.now();
  const { files, framework } = input;
  if (!(input.entry in files)) throw new CompileError({ file: input.entry, message: `Entry ${input.entry} is missing` });
  const collected: Collected = { classStrings: new Set(), codepoints: new Set() };
  const modules: Record<string, CompiledModule> = {};
  const queue = [input.entry];
  while (queue.length) {
    const path = queue.shift()!;
    if (modules[path]) continue;
    const source = files[path]!;
    const deps = new Set<string>();
    let code: string;
    if (path.endsWith(".vue")) {
      if (framework !== "vue-vapor") throw new CompileError({ file: path, message: ".vue files need the Vue Vapor framework" });
      code = compileVue(source, path);
    } else {
      code = source;
    }
    const isTsx = path.endsWith(".tsx");
    const presets: unknown[] = [];
    if (isTsx) {
      if (framework !== "solid") throw new CompileError({ file: path, message: "This playground compiles .tsx with the Solid front end; use .vue files for Vue" });
      presets.push([solidPreset, { generate: "universal", moduleName: SOLID_RENDERER_MODULE }]);
    }
    presets.push([tsPreset, isTsx ? {} : { allExtensions: true }]);
    let res;
    try {
      res = await transformAsync(code, {
        filename: path.endsWith(".vue") ? path + ".ts" : path,
        presets: presets as never,
        parserOpts: isTsx ? { plugins: ["jsx"] } : undefined,
        plugins: [collectorPlugin(collected), rewritePlugin(files, path, deps)],
        babelrc: false,
        configFile: false,
        sourceMaps: false,
        // Type stripping keeps line numbers so runtime errors map to editor lines; .vue output is template-compiled, so its lines are not kept
        retainLines: !path.endsWith(".vue"),
      });
    } catch (e) {
      throw babelError(path, e);
    }
    modules[path] = { path, code: res?.code ?? "", deps: [...deps] };
    queue.push(...deps);
  }

  const styles = compileClasses([...collected.classStrings]);
  const cps = new Set<number>();
  for (let c = 32; c <= 126; c++) cps.add(c);
  for (const cp of collected.codepoints) if (cp >= 32 && cp !== 127) cps.add(cp);
  const chars = [...cps].sort((a, b) => a - b);
  const blobs: PakBlob[] = [{ key: KEY_STYLES, dtype: PAK_DTYPE.u8, data: styles.bin }];
  // The core draws Text with no font-size class from slot 0 (12px), but usedFontSlots only guarantees the
  // 16px DEFAULT_FONT_SLOT; bake both so Text with only a color class has glyphs to draw
  for (const slot of [...new Set([0, ...styles.usedFontSlots])].sort((a, b) => a - b)) {
    const { px, bold } = fontSlotInfo(slot);
    const atlas = bakeSlot(await getFont(bold), slot, px, bold, chars);
    blobs.push({ key: keyFont(atlas.slot), dtype: PAK_DTYPE.u8, data: atlas.bytes });
  }
  const images = [...collected.classStrings].filter((s) => IMAGE_RE.test(s));
  for (const name of images) blobs.push({ key: keyImage(name), dtype: PAK_DTYPE.u8, data: encodeImageEntry(await rasterizeImage(name), PSM.PSM_8888) });
  const packed = pack(blobs);
  const pak = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer;

  return {
    entry: input.entry,
    modules,
    styles: styles.ids,
    pak,
    stats: {
      files: Object.keys(modules).length,
      classes: styles.records.length,
      fontSlots: new Set([0, ...styles.usedFontSlots]).size,
      images: images.length,
      pakBytes: pak.byteLength,
      ms: Math.round(performance.now() - t0),
    },
  };
}
