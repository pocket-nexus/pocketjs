// Deterministic codegen: framework/compiler/subpaths.ts -> the `exports`
// map in package.json.
//
// Run from PocketJS/:  bun tools/gen-exports.ts   (part of `bun run gen`)
//
// tests/contract.ts imports renderExportsBlock() and byte-compares it
// against the committed package.json block, so the npm surface can never
// drift from the subpath registry — the engine/core/src/spec.rs mechanism
// applied to the second generated artifact. Only the exports block is
// touched; the rest of package.json is never rewritten.

import { npmExports } from "../framework/compiler/subpaths.ts";

/** The exact `"exports": { … }` block text, at package.json's indentation. */
export function renderExportsBlock(): string {
  const entries = Object.entries(npmExports());
  const lines = entries.map(
    ([key, value], i) =>
      `    ${JSON.stringify(key)}: ${JSON.stringify(value)}${i < entries.length - 1 ? "," : ""}`,
  );
  return `"exports": {\n${lines.join("\n")}\n  }`;
}

/** Replace the generated block; nested conditional exports stay on their entry line. */
export function withGeneratedExports(pkgText: string): string {
  const block = /"exports": \{[\s\S]*?\n  \}/;
  if (!block.test(pkgText)) {
    throw new Error("gen-exports: package.json has no exports block");
  }
  return pkgText.replace(block, renderExportsBlock());
}

if (import.meta.main) {
  const path = new URL("../package.json", import.meta.url).pathname;
  const before = await Bun.file(path).text();
  const after = withGeneratedExports(before);
  if (after !== before) {
    await Bun.write(path, after);
    console.log(`wrote ${path} (exports block)`);
  } else {
    console.log("package.json exports already current");
  }
}
