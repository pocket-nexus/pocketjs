#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as bundle from "../../../contracts/spec/bundle.ts";
import { PROFILE_HASH_FIELDS } from "../../../contracts/spec/profile.ts";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const upper = (name: string) => name.replace(/[A-Z]/g, c => "_" + c).toUpperCase();
export function generatedIdfContracts(): Map<string, string> {
  const constants: Record<string, number> = {
    BUNDLE_MAGIC: bundle.BUNDLE_MAGIC, BUNDLE_VERSION: bundle.BUNDLE_VERSION,
    BUNDLE_HEADER_SIZE: bundle.BUNDLE_HEADER_SIZE, BUNDLE_SECTION_SIZE: bundle.BUNDLE_SECTION_SIZE,
    BUNDLE_ALIGN: bundle.BUNDLE_ALIGN, BUNDLE_FOOTER_SIZE: bundle.BUNDLE_FOOTER_SIZE,
    HOST_INPUTS_MAGIC: bundle.BUNDLE_HOST_INPUTS_MAGIC, HOST_INPUTS_VERSION: bundle.BUNDLE_HOST_INPUTS_VERSION,
    HOST_INPUTS_SIZE: bundle.BUNDLE_HOST_INPUTS_SIZE,
  };
  for (const [name, value] of Object.entries(bundle.BUNDLE_SECTION)) constants[`SECTION_${upper(name)}`] = value;
  for (const [group, fields] of Object.entries(bundle.BUNDLE_LAYOUT)) for (const [name, value] of Object.entries(fields))
    constants[`OFFSET_${upper(group)}_${upper(name)}`] = value;
  const wordType = (key: string) => key.startsWith("SECTION_") || (!key.startsWith("OFFSET_") && /MAGIC|VERSION/.test(key)) ? "u32" : "usize";
  const pyConstants = "# Generated from contracts/spec/bundle.ts. Do not edit.\n" +
    Object.entries(constants).map(([key, value]) => `${key} = ${value}\n`).join("") +
    `HOST_PRESENTATIONS = ${JSON.stringify(bundle.HOST_PRESENTATIONS)}\nPROFILE_HASH_FIELDS = ${JSON.stringify(PROFILE_HASH_FIELDS)}\n`;
  const rustConstants = "// Generated from contracts/spec/bundle.ts. Do not edit.\n#![allow(dead_code)]\n" +
    Object.entries(constants).map(([key, value]) => `pub const ${key}: ${wordType(key)} = ${value};\n`).join("");
  return new Map([
    ["platforms/esp-idf/pocket_runtime/tools/bundle_format.py", pyConstants],
    ["engine/package/src/package_format.rs", rustConstants],
  ]);
}
if (import.meta.main) {
  const check = Bun.argv.includes("--check");
  for (const [path, contents] of generatedIdfContracts()) {
    const file = resolve(root, path);
    if (check) {
      if (!existsSync(file) || readFileSync(file, "utf8") !== contents) throw new Error(`stale generated contract: ${path}`);
    } else await Bun.write(file, contents);
  }
}
