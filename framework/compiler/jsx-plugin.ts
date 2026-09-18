// Framework-aware pass-1 Babel transform + AST collection.

import { transformAsync, type NodePath, type PluginObj } from "@babel/core";
import type { ParserOptions } from "@babel/parser";
import type {
  Expression,
  MemberExpression,
  Node,
  ObjectProperty,
  OptionalMemberExpression,
} from "@babel/types";
import solidPreset from "babel-preset-solid";
import tsPreset from "@babel/preset-typescript"; // untyped - see framework/compiler/ambient.d.ts
import { transformVueJsxVapor } from "vue-jsx-vapor/api";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileVueSfc } from "./vue-sfc-compile.ts";
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
import type { BunPlugin } from "bun";
import { compile as octaneCompile } from "octane/compiler";
import solidPresetPkg from "babel-preset-solid/package.json";
import compilerSfcPkg from "@vue/compiler-sfc/package.json";
import vuePkg from "vue/package.json";
import vueJsxVaporPkg from "vue-jsx-vapor/package.json";
import octanePkg from "octane/package.json";
import babelCorePkg from "@babel/core/package.json";
import tsPresetPkg from "@babel/preset-typescript/package.json";
import type { PocketFramework } from "../src/config.ts";
import { POCKET_FRAMEWORKS, SUBPATHS } from "./subpaths.ts";

export type { PocketFramework };

export const RENDERER_PATH = fileURLToPath(new URL("../src/renderer.ts", import.meta.url));
export const RENDERER_SOLID_PATH = fileURLToPath(new URL("../src/renderer-solid.ts", import.meta.url));
export const RENDERER_VUE_VAPOR_PATH = fileURLToPath(new URL("../src/renderer-vue-vapor.ts", import.meta.url));
export const RENDERER_OCTANE_PATH = fileURLToPath(new URL("../src/renderer-octane.ts", import.meta.url));

/**
 * subpath -> absolute module file, per framework — derived once from the
 * SUBPATHS registry (framework/compiler/subpaths.ts, THE declaration).
 * A missing entry means "this framework does not resolve the subpath":
 * pass 1 skips it and pass 2 falls through to Bun's package.json
 * resolution.
 */
const RESOLVED: Record<PocketFramework, Record<string, string>> = (() => {
  const root = new URL("../../", import.meta.url);
  const out: Record<PocketFramework, Record<string, string>> = {
    solid: {},
    "vue-vapor": {},
    octane: {},
  };
  for (const [name, decl] of Object.entries(SUBPATHS)) {
    for (const fw of POCKET_FRAMEWORKS) {
      const rel = typeof decl.file === "string" ? decl.file : decl.file[fw];
      if (rel) out[fw][name] = fileURLToPath(new URL(rel, root));
    }
  }
  return out;
})();
const OCTANE_PROFILING_STUB_PATH = fileURLToPath(
  new URL("../src/octane-profiling-stub.ts", import.meta.url),
);
const GENERATED_STYLES_PATH = fileURLToPath(
  new URL("../src/styles.generated.ts", import.meta.url),
);
const VUE_VAPOR_RUNTIME_PATH = fileURLToPath(
  new URL("../../node_modules/vue/dist/vue.runtime-with-vapor.esm-browser.prod.js", import.meta.url),
);
const SOLID_RUNTIME_PATH = fileURLToPath(
  new URL("../../node_modules/solid-js/dist/solid.js", import.meta.url),
);
const SOLID_UNIVERSAL_RUNTIME_PATH = fileURLToPath(
  new URL("../../node_modules/solid-js/universal/dist/universal.js", import.meta.url),
);

const PACKAGE_NAME = "@pocketjs/framework";
const CACHE_DIR = fileURLToPath(new URL("../../.cache/transforms/", import.meta.url));
const CACHE_VERSION = "2"; // manual backstop; compiler sources are hashed in below
const COMPILER_DIR = new URL("./", import.meta.url).pathname;

/**
 * Hash of this package's own compiler sources: transform behavior lives here,
 * and neither dependency versions nor input hashes cover it, so a warm cache
 * would otherwise serve output from the previous implementation.
 *
 * The set is walked from this file's own imports rather than hand-listed - a
 * literal list rots the moment a compiler module is added or split, which is
 * exactly the failure this key exists to prevent. Only `framework/compiler` is
 * in scope: everything under `framework/src` is a transform *input*, hashed as
 * it is transformed.
 */
async function hashCompilerSources(): Promise<string> {
  const scanner = new Bun.Transpiler({ loader: "ts" });
  const sources = new Map<string, string>();
  const pending = [new URL("./jsx-plugin.ts", import.meta.url)];
  while (pending.length > 0) {
    const url = pending.pop()!;
    if (!url.pathname.startsWith(COMPILER_DIR)) continue;
    const name = url.pathname.slice(COMPILER_DIR.length);
    if (sources.has(name)) continue;
    const source = await Bun.file(url).text();
    sources.set(name, source);
    for (const { path } of scanner.scanImports(source)) {
      if (path.startsWith(".")) pending.push(new URL(path, url));
    }
  }
  const h = new Bun.CryptoHasher("sha256");
  for (const name of [...sources.keys()].sort()) h.update(name + "\0" + sources.get(name)! + "\0");
  return h.digest("hex");
}

let implementationHash: Promise<string> | undefined;

function compilerImplementationHash(): Promise<string> {
  return (implementationHash ??= hashCompilerSources());
}

const JSX_PARSER_OPTS: ParserOptions = { plugins: ["jsx"] };

const BANNED_SOLID_IMPORTS = new Set(["createResource", "useTransition", "startTransition"]);

// Per-framework identity. Module resolution is NOT here — it is derived
// from the SUBPATHS registry (framework/compiler/subpaths.ts) into RESOLVED
// above; rootPath/rendererPath are views into the same derivation.
export const FRAMEWORKS: Record<
  PocketFramework,
  {
    label: string;
    outputSuffix: string;
    rendererPath: string;
    rootPath: string;
  }
> = {
  solid: {
    label: "Solid",
    outputSuffix: "",
    rendererPath: RESOLVED.solid.renderer,
    rootPath: RESOLVED.solid[""],
  },
  "vue-vapor": {
    label: "Vue Vapor",
    outputSuffix: ".vue-vapor",
    rendererPath: RESOLVED["vue-vapor"].renderer,
    rootPath: RESOLVED["vue-vapor"][""],
  },
  octane: {
    label: "Octane",
    outputSuffix: ".octane",
    rendererPath: RESOLVED.octane.renderer,
    rootPath: RESOLVED.octane[""],
  },
};

/**
 * The universal-renderer descriptor handed to the Octane compiler: JSX lowers
 * to static host plans + dynamic slots and every runtime import retargets to
 * the pocket renderer module (framework/src/renderer-octane.ts).
 */
export const OCTANE_RENDERER_DESCRIPTOR = {
  id: "pocket",
  module: `${"@pocketjs/framework"}/octane/renderer`,
  target: "universal",
  server: "unsupported",
  text: "host",
  capabilities: ["portal"],
} as const;

function patchVaporHelperCode(code: string): string {
  return code.replace(
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
}

const VAPOR_HELPERS = new Map([
  [propsHelperId, propsHelperCode],
  [vdomHelperId, vdomHelperCode],
  [vaporHelperId, patchVaporHelperCode(vaporHelperCode)],
  [ssrHelperId, ssrHelperCode],
]);

export function parseFramework(value: string | undefined, source: string): PocketFramework {
  if (value === undefined || value === "") return "solid";
  if (value === "solid" || value === "vue-vapor" || value === "octane") return value;
  throw new Error(`PocketJS ${source}: framework must be "solid", "vue-vapor" or "octane"`);
}

export interface TransformResult {
  /** ESM JS: JSX compiled for the selected framework. */
  code: string;
  /** Candidate class strings (deduped, in AST order). */
  classStrings: string[];
  /** Every codepoint appearing in any collected literal. */
  textCodepoints: Set<number>;
  /** Runtime text inputs observed in executable AST nodes. */
  runtimeTextSources: Set<RuntimeTextSource>;
}

export type RuntimeTextSource = "host-service" | "host-ops-dynamic-key";

interface Collected {
  classStrings: string[];
  textCodepoints: Set<number>;
  runtimeTextSources: Set<RuntimeTextSource>;
}

export type BuildFeatures = Readonly<Record<string, boolean>>;

/** Fold only calls proven to reference the public platform import. */
function makeFeatureFolder(features: BuildFeatures): PluginObj {
  return {
    name: "pocketjs-fold-features",
    visitor: {
      Program(program) {
        // Run before the collector's Program visitor so pass 1 and pass 2 see
        // the same target-specialized AST (Babel presets run after plugins).
        program.traverse({
          CallExpression(path) {
            if (path.node.arguments.length !== 1) return;
            const argument = path.node.arguments[0];
            if (argument?.type !== "StringLiteral") return;

            const callee = path.get("callee");
            if (!callee.isIdentifier()) return;
            const binding = path.scope.getBinding(callee.node.name);
            if (!binding?.path.isImportSpecifier()) return;
            const imported = binding.path.node.imported;
            const importedName = imported.type === "Identifier" ? imported.name : imported.value;
            const declaration = binding.path.parentPath;
            if (
              importedName !== "hasFeature" ||
              !declaration?.isImportDeclaration() ||
              declaration.node.source.value !== `${PACKAGE_NAME}/platform`
            ) return;

            path.replaceWith({ type: "BooleanLiteral", value: features[argument.value] === true });
          },
        });
      },
    },
  };
}

function unwrapExpression(path: NodePath): NodePath<Expression> | null {
  let current = path;
  while (
    current.isParenthesizedExpression() ||
    current.isTSAsExpression() ||
    current.isTSTypeAssertion() ||
    current.isTSNonNullExpression() ||
    current.isTSSatisfiesExpression() ||
    current.isTSInstantiationExpression()
  ) {
    current = current.get("expression") as NodePath;
  }
  return current.isExpression() ? current as NodePath<Expression> : null;
}

function isFrameworkGetOpsCall(path: NodePath): boolean {
  const expression = unwrapExpression(path);
  if (!expression?.isCallExpression()) return false;
  const callee = unwrapExpression(expression.get("callee") as NodePath);
  if (!callee?.isIdentifier()) return false;
  const binding = callee.scope.getBinding(callee.node.name);
  if (!binding?.path.isImportSpecifier()) return false;
  const imported = binding.path.node.imported;
  const importedName = imported.type === "Identifier" ? imported.name : imported.value;
  const declaration = binding.path.parentPath;
  return (
    importedName === "getOps" &&
    declaration?.isImportDeclaration() === true &&
    (declaration.node.source.value === PACKAGE_NAME ||
      declaration.node.source.value.startsWith(PACKAGE_NAME + "/"))
  );
}

/** Whether an expression is getOps() or a same-file local variable initialized
 *  from it. Alias chains are followed by binding identity, not variable name. */
function isHostOpsExpression(path: NodePath, seen = new Set<NodePath>()): boolean {
  const expression = unwrapExpression(path);
  if (!expression) return false;
  if (isFrameworkGetOpsCall(expression)) return true;
  if (!expression.isIdentifier()) return false;
  const binding = expression.scope.getBinding(expression.node.name);
  if (!binding || seen.has(binding.path)) return false;
  seen.add(binding.path);
  if (!binding.path.isVariableDeclarator()) return false;
  const init = binding.path.get("init");
  return init.node !== null && isHostOpsExpression(init as NodePath, seen);
}

function staticPropertyName(computed: boolean, property: Node): string | undefined {
  if (!computed) return property.type === "Identifier" ? property.name : undefined;
  if (property.type === "StringLiteral") return property.value;
  if (property.type === "TemplateLiteral" && property.expressions.length === 0) {
    return property.quasis[0]?.value.cooked ?? property.quasis[0]?.value.raw;
  }
  return undefined;
}

function isLiteralComputedKey(node: Node): boolean {
  return (
    node.type.endsWith("Literal") ||
    (node.type === "TemplateLiteral" && node.expressions.length === 0)
  );
}

function destructuresHostOps(path: NodePath<ObjectProperty>): boolean {
  const pattern = path.parentPath;
  if (!pattern?.isObjectPattern()) return false;
  const parent = pattern.parentPath;
  if (parent?.isVariableDeclarator() && parent.get("id").node === pattern.node) {
    const init = parent.get("init");
    return init.node !== null && isHostOpsExpression(init as NodePath);
  }
  if (parent?.isAssignmentExpression() && parent.get("left").node === pattern.node) {
    return isHostOpsExpression(parent.get("right") as NodePath);
  }
  return false;
}

function collectMemberRuntimeTextSource(
  path: NodePath<MemberExpression | OptionalMemberExpression>,
  out: Collected,
): void {
  const name = staticPropertyName(path.node.computed, path.node.property);
  if (name === "svcPoll") {
    out.runtimeTextSources.add("host-service");
    return;
  }
  if (
    path.node.computed &&
    !isLiteralComputedKey(path.node.property) &&
    isHostOpsExpression(path.get("object") as NodePath)
  ) {
    out.runtimeTextSources.add("host-ops-dynamic-key");
  }
}

function makeCollector(out: Collected, framework: PocketFramework): PluginObj {
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!s) return;
    for (const ch of s) out.textCodepoints.add(ch.codePointAt(0)!);
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
              // The parser normalizes CRLF to LF in node.value while
              // extra.raw keeps the source bytes — line endings are not
              // entities, so compare like-for-like (CRLF checkouts must
              // build exactly like LF ones).
              if (typeof raw === "string" && raw.replace(/\r\n/g, "\n") !== path.node.value) {
                throw path.buildCodeFrameError(
                  "PocketJS: HTML entities in JSX text are not decoded by the JSX renderer - " +
                    'write the literal character (é, ♥) or a string expression {"\\u00e9"} instead.',
                );
              }
              add(path.node.value);
            },
            JSXAttribute(path) {
              const name = path.node.name;
              if (name.type === "JSXIdentifier" && name.name === "classList") {
                throw path.buildCodeFrameError(
                  "PocketJS: `classList` is not supported (v1). Use ternaries of FULL class literals: " +
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
                    "PocketJS: template-interpolated class fragments are not supported (v1). " +
                      "Styles compile at build time - use ternaries of FULL literals.",
                  );
                }
              }
            },
            ObjectProperty(path) {
              // ObjectPattern properties are executable destructuring, unlike
              // TypeScript property signatures. Restricting this to the
              // immediate parent avoids object literals in default values.
              if (!path.parentPath?.isObjectPattern()) return;
              const name = staticPropertyName(path.node.computed, path.node.key);
              if (name === "svcPoll") {
                out.runtimeTextSources.add("host-service");
              } else if (
                path.node.computed &&
                !isLiteralComputedKey(path.node.key) &&
                destructuresHostOps(path)
              ) {
                out.runtimeTextSources.add("host-ops-dynamic-key");
              }
            },
            MemberExpression(path) {
              collectMemberRuntimeTextSource(path, out);
            },
            OptionalMemberExpression(path) {
              collectMemberRuntimeTextSource(path, out);
            },
            ImportDeclaration(path) {
              if (framework !== "solid") return;
              const src = path.node.source.value;
              if (src !== "solid-js" && !src.startsWith("solid-js/")) return;
              for (const spec of path.node.specifiers) {
                if (spec.type !== "ImportSpecifier") continue;
                const imported =
                  spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
                if (BANNED_SOLID_IMPORTS.has(imported)) {
                  throw path.buildCodeFrameError(
                    `PocketJS: solid-js \`${imported}\` is not supported - the PSP QuickJS host has no ` +
                      "scheduler (no setTimeout/queueMicrotask-driven transitions). Use signals + " +
                      "createEffect, or animate() for motion.",
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

async function hashKey(
  path: string,
  src: string,
  framework: PocketFramework,
  features: BuildFeatures | undefined,
): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(
    CACHE_VERSION +
      "\0" +
      (await compilerImplementationHash()) +
      "\0" +
      framework +
      "\0" +
      solidPresetPkg.version +
      "\0" +
      compilerSfcPkg.version +
      "\0" +
      vuePkg.version +
      "\0" +
      vueJsxVaporPkg.version +
      "\0" +
      octanePkg.version +
      "\0" +
      babelCorePkg.version +
      "\0" +
      tsPresetPkg.version +
      "\0" +
      FRAMEWORKS[framework].rendererPath +
      "\0" +
      (features === undefined
        ? "dynamic"
        : JSON.stringify(
            Object.entries(features).sort(([left], [right]) => left.localeCompare(right)),
          )) +
      "\0" +
      path +
      "\0",
  );
  h.update(src);
  return h.digest("hex");
}

interface CacheEntry {
  code: string;
  classStrings: string[];
  textCodepoints: number[];
  runtimeTextSources?: RuntimeTextSource[];
}

function resolvePackageSubpath(spec: string): string | null {
  if (spec === PACKAGE_NAME) return "";
  if (spec.startsWith(PACKAGE_NAME + "/")) return spec.slice(PACKAGE_NAME.length + 1);
  return null;
}

/**
 * Resolve an `@pocketjs/framework[/…]` import to a module file, or null to
 * let Bun's package.json resolution (or an error) take over. A framework
 * prefix (`vue-vapor/audio`) pins that framework's view; a bare subpath
 * resolves through the ACTIVE framework — both are lookups into the same
 * SUBPATHS-derived table, so the registry is the only authority.
 */
export function packagePath(spec: string, framework: PocketFramework): string | null {
  const subpath = resolvePackageSubpath(spec);
  if (subpath === null) return null;
  for (const fw of POCKET_FRAMEWORKS) {
    if (subpath === fw) return RESOLVED[fw][""] ?? null;
    if (subpath.startsWith(fw + "/")) {
      return RESOLVED[fw][subpath.slice(fw.length + 1)] ?? null;
    }
  }
  return RESOLVED[framework][subpath] ?? null;
}

/** Bun reports native paths (`\` separators on Windows); normalize before
 *  matching the `/node_modules/` prefix written in source specifiers. */
function isNodeModuleFile(path: string): boolean {
  return path.replace(/\\/g, "/").includes("/node_modules/");
}

export function frameworkVariantPath(path: string, framework: PocketFramework): string {
  if (framework === "solid" || isNodeModuleFile(path) || path.endsWith(".d.ts")) return path;
  const variant = path.replace(/(\.tsx?)$/, `${FRAMEWORKS[framework].outputSuffix}$1`);
  return variant !== path && existsSync(variant) ? variant : path;
}

function transformOptions(framework: PocketFramework) {
  if (framework === "solid") {
    return {
      presets: [
        [solidPreset, { generate: "universal", moduleName: FRAMEWORKS.solid.rendererPath }],
        [tsPreset, {}],
      ],
      parserOpts: JSX_PARSER_OPTS,
    };
  }
  return {
    presets: [[tsPreset, {}]],
    parserOpts: JSX_PARSER_OPTS,
  };
}

export async function transformFile(
  path: string,
  src: string,
  framework: PocketFramework,
  options: { features?: BuildFeatures } = {},
): Promise<TransformResult> {
  const isVueSfc = path.endsWith(".vue");
  if (isVueSfc && framework !== "vue-vapor") {
    throw new Error(
      `PocketJS: ${path} is a Vue SFC and requires framework \"vue-vapor\" ` +
        `(set app.framework in pocket.json or pass --framework=vue-vapor)`,
    );
  }
  const key = await hashKey(path, src, framework, options.features);
  const cacheFile = CACHE_DIR + key + ".json";
  const cached = (await Bun.file(cacheFile).json().catch(() => null)) as CacheEntry | null;
  if (cached && typeof cached.code === "string") {
    return {
      code: cached.code,
      classStrings: cached.classStrings,
      textCodepoints: new Set(cached.textCodepoints),
      runtimeTextSources: new Set(cached.runtimeTextSources ?? []),
    };
  }

  if (isVueSfc) {
    const result = compileVueSfc(src, path, { stripTypes: true });
    const collected: Collected = {
      classStrings: [],
      textCodepoints: new Set(),
      runtimeTextSources: new Set(),
    };
    const transformed = await transformAsync(result.code, {
      filename: path,
      presets: [],
      parserOpts: JSX_PARSER_OPTS,
      plugins: [
        ...(options.features === undefined ? [] : [makeFeatureFolder(options.features)]),
        makeCollector(collected, framework),
      ],
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
    if (!transformed?.code && transformed?.code !== "") {
      throw new Error(`PocketJS Vue SFC transform produced no output for ${path}`);
    }
    const entry: CacheEntry = {
      code: transformed.code!,
      classStrings: collected.classStrings,
      textCodepoints: [...collected.textCodepoints],
      runtimeTextSources: [...collected.runtimeTextSources],
    };
    await Bun.write(cacheFile, JSON.stringify(entry));
    return {
      code: entry.code,
      classStrings: entry.classStrings,
      textCodepoints: new Set(entry.textCodepoints),
      runtimeTextSources: new Set(entry.runtimeTextSources ?? []),
    };
  }

  const collected: Collected = {
    classStrings: [],
    textCodepoints: new Set(),
    runtimeTextSources: new Set(),
  };
  const opts = transformOptions(framework);
  const plugins = [
    ...(options.features === undefined ? [] : [makeFeatureFolder(options.features)]),
    makeCollector(collected, framework),
  ];
  let res;
  if (framework === "vue-vapor") {
    await transformAsync(src, {
      filename: path,
      presets: opts.presets,
      parserOpts: opts.parserOpts,
      plugins,
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
    const vapor = transformVueJsxVapor(src, path, {}, false, false, false);
    res = await transformAsync(vapor.code, {
      filename: path,
      presets: opts.presets,
      parserOpts: opts.parserOpts,
      plugins: options.features === undefined ? [] : [makeFeatureFolder(options.features)],
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
  } else if (framework === "octane" && path.endsWith(".tsx")) {
    // Collector pass on the pristine source (classes/text literals), then the
    // Octane compiler lowers JSX + hooks against the pocket universal
    // renderer. Plain .ts modules take the shared TS-preset branch below —
    // Octane hook modules must be .tsx so their call sites get slots.
    await transformAsync(src, {
      filename: path,
      presets: opts.presets,
      parserOpts: opts.parserOpts,
      plugins,
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
    const compiled = octaneCompile(src, path, {
      mode: "client",
      renderer: OCTANE_RENDERER_DESCRIPTOR,
    }) as { code: string; diagnostics?: readonly unknown[] };
    res =
      options.features === undefined
        ? { code: compiled.code }
        : await transformAsync(compiled.code, {
            filename: path,
            presets: [],
            parserOpts: opts.parserOpts,
            plugins: [makeFeatureFolder(options.features)],
            babelrc: false,
            configFile: false,
            sourceMaps: false,
          });
  } else {
    res = await transformAsync(src, {
      filename: path,
      presets: opts.presets,
      parserOpts: opts.parserOpts,
      plugins,
      babelrc: false,
      configFile: false,
      sourceMaps: false,
    });
  }
  if (!res?.code && res?.code !== "") {
    throw new Error(`PocketJS transform produced no output for ${path}`);
  }

  const entry: CacheEntry = {
    code: res.code!,
    classStrings: collected.classStrings,
    textCodepoints: [...collected.textCodepoints],
    runtimeTextSources: [...collected.runtimeTextSources],
  };
  await Bun.write(cacheFile, JSON.stringify(entry));
  return {
    code: entry.code,
    classStrings: entry.classStrings,
    textCodepoints: collected.textCodepoints,
    runtimeTextSources: collected.runtimeTextSources,
  };
}

export function jsxPlugin(
  framework: PocketFramework,
  opts: {
    entry?: string;
    features?: BuildFeatures;
    generatedStyles?: string;
  } = {},
): BunPlugin {
  return {
    name: `pocketjs-${framework}-jsx`,
    setup(build) {
      // External applications may have their own node_modules. Resolve both
      // sides of the renderer boundary to PocketJS's browser-mode Solid copy,
      // otherwise identical packages at different paths form two reactive
      // ownership domains and lifecycle hooks silently stop crossing it.
      build.onResolve({ filter: /^solid-js$/ }, () => ({
        path: SOLID_RUNTIME_PATH,
      }));
      build.onResolve({ filter: /^solid-js\/universal$/ }, () => ({
        path: SOLID_UNIVERSAL_RUNTIME_PATH,
      }));
      build.onResolve({ filter: /^@pocketjs\/framework(?:\/.*)?$/ }, (args) => {
        const path = packagePath(args.path, framework);
        return path ? { path } : undefined;
      });
      if (framework !== "solid") {
        build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
          let resolved: string;
          try {
            resolved = Bun.resolveSync(args.path, args.resolveDir);
          } catch {
            return undefined;
          }
          const variant = frameworkVariantPath(resolved, framework);
          return variant !== resolved ? { path: variant } : undefined;
        });
      }
      if (framework === "octane" && process.env.POCKETJS_OCTANE_PROFILER !== "1") {
        // Octane's profiler is replaced with a no-op stub in Pocket bundles:
        // its always-on per-render WeakMap bookkeeping pins render graphs
        // under the pinned QuickJS's non-ephemeron weak marking (and costs
        // frame time). See framework/src/octane-profiling-stub.ts.
        build.onResolve({ filter: /^octane\/profiling$/ }, () => ({
          path: OCTANE_PROFILING_STUB_PATH,
        }));
        build.onResolve({ filter: /^\.\/profiling\.js$/ }, (args) =>
          args.importer.replace(/\\/g, "/").includes("/node_modules/octane/dist/")
            ? { path: OCTANE_PROFILING_STUB_PATH }
            : undefined,
        );
      }
      if (framework === "vue-vapor") {
        build.onResolve({ filter: /^vue$/ }, () => ({ path: VUE_VAPOR_RUNTIME_PATH }));
        build.onResolve({ filter: /^\/vue-jsx-vapor\/(?:props|vdom|vapor|ssr)$/ }, (args) => ({
          path: args.path,
          namespace: "vue-vapor-helper",
        }));
        build.onLoad({ filter: /.*/, namespace: "vue-vapor-helper" }, (args) => {
          const contents = VAPOR_HELPERS.get(args.path);
          if (!contents) return undefined;
          return { contents, loader: "js" };
        });
      }
      build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
        if (isNodeModuleFile(args.path) || args.path.endsWith(".d.ts")) return undefined;
        let src = args.path === GENERATED_STYLES_PATH &&
            opts.generatedStyles !== undefined
          ? opts.generatedStyles
          : await Bun.file(args.path).text();
        if (framework === "vue-vapor" && args.path === opts.entry) {
          src = `import "@pocketjs/framework/prelude";\n${src}`;
        }
        const { code } = await transformFile(args.path, src, framework, { features: opts.features });
        return { contents: code, loader: "js" };
      });
      build.onLoad({ filter: /\.vue$/ }, async (args) => {
        const src = await Bun.file(args.path).text();
        const { code } = await transformFile(args.path, src, framework, { features: opts.features });
        return { contents: code, loader: "js" };
      });
    },
  };
}
