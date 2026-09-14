/** Compile a Vue SFC with Vue's production Vapor pipeline. */

import { compileScript, parse } from "@vue/compiler-sfc";
import { checkVueAotSource, hasVueAotContract, normalizeVueAotClasses } from "../../vapor/compiler/aot-browser.ts";

function compilerError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Compile the PocketJS SFC subset: `<script setup>` plus `<template>`.
 *
 * Vue owns script/template binding analysis and emits an inline Vapor render
 * function. PocketJS subsequently strips TypeScript, folds target features,
 * and bundles that ordinary ESM output. Because the template compiles inline,
 * every static class and text node is an ordinary string literal in this
 * output, so the shared pass-1 AST collector sees them with no
 * template-specific walk here.
 */
export function compileVueSfc(
  source: string,
  filename: string,
  options: { stripTypes?: boolean; aot?: boolean; strict?: boolean } = {},
): { code: string } {
  if (options.aot ?? hasVueAotContract(source, filename)) {
    checkVueAotSource(source, filename, options.strict);
  }
  source = normalizeVueAotClasses(source, filename);
  // compileScript reuses the descriptor's pre-parsed template AST, so comments
  // must be stripped here — compilerOptions below would arrive too late.
  const { descriptor, errors } = parse(source, {
    filename,
    templateParseOptions: { comments: false },
  });
  if (errors.length > 0) {
    throw new Error(
      `PocketJS: failed to parse Vue SFC ${filename}: ${errors.map(compilerError).join("; ")}`,
    );
  }
  if (!descriptor.scriptSetup) {
    throw new Error(
      `PocketJS: ${filename} must use <script setup>; options-API-only .vue files are not supported`,
    );
  }
  if (!descriptor.template) {
    throw new Error(`PocketJS: ${filename} must contain a <template>`);
  }
  if (descriptor.scriptSetup.src || descriptor.template.src) {
    throw new Error(`PocketJS: external src blocks are not supported in ${filename}`);
  }
  if (descriptor.template.lang && descriptor.template.lang !== "html") {
    throw new Error(`PocketJS: template preprocessors are not supported in ${filename}`);
  }
  if (descriptor.styles.length > 0) {
    throw new Error(
      `PocketJS: <style> blocks are not supported in ${filename}; use PocketJS class literals or :style`,
    );
  }

  const compiled = compileScript(descriptor, {
    id: `pocketjs-${filename.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    inlineTemplate: true,
    sourceMap: false,
    vapor: true,
    templateOptions: {
      compilerOptions: {
        mode: "module",
        // Backstop for re-parses inside compileScript.
        comments: false,
      },
    },
  });
  const code = options.stripTypes
    ? new Bun.Transpiler({ loader: "ts" }).transformSync(compiled.content)
    : compiled.content;

  return { code };
}

if (import.meta.main) {
  const filename = process.argv[2];
  if (!filename) {
    console.error("usage: bun compiler/vue-sfc-compile.ts <Component.vue>");
    process.exit(1);
  }
  const result = compileVueSfc(await Bun.file(filename).text(), filename, { stripTypes: true });
  console.log(result.code);
}
