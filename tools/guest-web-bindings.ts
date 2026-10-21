#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { UI_OPS } from "../contracts/spec/ui-ops.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";

const root = resolve(import.meta.dir, "..");
export function generatedGuestWebBindings(): string {
  const descriptors = UI_OPS.filter(op => op.id !== null).map(({ id, name, args, result }) => ({ id, name, args, result }));
  return readFileSync(resolve(root, "tools/templates/guest-web-bindings.js"), "utf8")
    .replace("/*__POCKET_BINDING_GENERATION__*/", String(POCKET_BINDING_GENERATION))
    .replace("/*__POCKET_UI_DESCRIPTORS__*/", JSON.stringify(descriptors));
}
if (import.meta.main) {
  const content = generatedGuestWebBindings();
  for (const relative of ["engine/guest-web/src/generated-ui.js", "platforms/web/generated-ui.js"]) {
  const path = resolve(root, relative);
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== content) throw new Error("generated web guest bindings differ");
  } else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
}
}
