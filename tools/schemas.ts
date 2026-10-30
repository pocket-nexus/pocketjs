#!/usr/bin/env bun
// The published JSON schemas: contracts/schema/pocket-2.json (application
// manifests) and contracts/schema/pocket-host-2.json (host contracts).
//   bun tools/schemas.ts           # write
//   bun tools/schemas.ts --check   # fail when a committed schema is stale
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePocketManifestV2Schema } from "../contracts/spec/pocket-manifest.ts";
import { generatePocketProfileSchema } from "../contracts/spec/profile.ts";

const root = resolve(import.meta.dir, "..");
export const SCHEMAS: ReadonlyMap<string, () => string> = new Map([
  ["contracts/schema/pocket-2.json", generatePocketManifestV2Schema],
  ["contracts/schema/pocket-host-2.json", generatePocketProfileSchema],
]);

if (import.meta.main) {
  const check = process.argv.includes("--check");
  for (const [path, generate] of SCHEMAS) {
    const file = resolve(root, path), text = generate();
    if (check) {
      if (!existsSync(file) || readFileSync(file, "utf8") !== text) throw new Error(`stale schema: ${path}; run bun tools/schemas.ts`);
    } else if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
  }
}
