#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pocket from "../../../contracts/spec/pocket-package.ts";
import { PROFILE_HASH_FIELDS } from "../../../contracts/spec/profile.ts";
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export function generatedIdfContracts(): Map<string, string> {
  const constants: Record<string, number> = {
    POCKET_MAGIC: pocket.POCKET_PACKAGE_MAGIC, POCKET_VERSION: pocket.POCKET_PACKAGE_VERSION,
    POCKET_HEADER_SIZE: pocket.POCKET_PACKAGE_HEADER_SIZE, POCKET_VARIANT_SIZE: pocket.POCKET_PACKAGE_VARIANT_SIZE,
    POCKET_SECTION_SIZE: pocket.POCKET_PACKAGE_SECTION_SIZE, POCKET_ALIGN: pocket.POCKET_PACKAGE_ALIGN,
    POCKET_TARGET_MAX_BYTES: pocket.POCKET_PACKAGE_TARGET_MAX_BYTES, POCKET_FOOTER_SIZE: pocket.POCKET_PACKAGE_FOOTER_SIZE,
    HOST_INPUTS_MAGIC: pocket.POCKET_HOST_INPUTS_MAGIC, HOST_INPUTS_VERSION: pocket.POCKET_HOST_INPUTS_VERSION,
    HOST_INPUTS_SIZE: pocket.POCKET_HOST_INPUTS_SIZE,
  };
  for (const [name, value] of Object.entries(pocket.POCKET_SECTION)) constants[`SECTION_${name.replace(/[A-Z]/g, c => "_" + c).toUpperCase()}`] = value;
  for (const [group, fields] of Object.entries(pocket.POCKET_LAYOUT)) for (const [name, value] of Object.entries(fields))
    constants[`OFFSET_${group.replace(/[A-Z]/g, c => "_" + c).toUpperCase()}_${name.replace(/[A-Z]/g, c => "_" + c).toUpperCase()}`] = value;
  const pyConstants = "# Generated from contracts/spec/pocket-package.ts. Do not edit.\n" +
    Object.entries(constants).map(([key, value]) => `${key} = ${value}\n`).join("") +
    `HOST_PRESENTATIONS = ${JSON.stringify(pocket.HOST_PRESENTATIONS)}\nPROFILE_HASH_FIELDS = ${JSON.stringify(PROFILE_HASH_FIELDS)}\n`;
  const rustConstants = "// Generated from contracts/spec/pocket-package.ts. Do not edit.\n#![allow(dead_code)]\n" +
    Object.entries(constants).map(([key, value]) => `pub const ${key}: ${key.includes("MAGIC") || key.includes("VERSION") || key.startsWith("SECTION_") ? "u32" : "usize"} = ${value};\n`).join("");
  return new Map([
    ["platforms/esp-idf/pocket_runtime/tools/package_format.py", pyConstants],
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
