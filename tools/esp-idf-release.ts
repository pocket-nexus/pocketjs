#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_COMPONENTS, NATIVE_ENGINE_CRATES, RUST_TARGETS, verifyNativeReceipt, type IdfTarget } from "./esp-idf-native-receipt.ts";
import { verifyComponentVersions } from "./esp-idf-component-versions.ts";
import { generatedIdfContracts } from "./esp-idf-contracts.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ignored = (source: string): boolean => {
  const name = basename(source);
  return name === "target" || name.startsWith("target-") || name === "__pycache__" ||
    name === ".DS_Store" || name === "lib" || name === "vendor";
};

export async function stageEspIdfComponents(root: string, output: string): Promise<void> {
  if (existsSync(output)) throw new Error("output already exists: " + output);
  const names = verifyComponentVersions(root);
  for (const [path, expected] of generatedIdfContracts())
    if (readFileSync(join(root, path), "utf8") !== expected) throw new Error("stale generated contract: " + path);
  for (const spec of NATIVE_COMPONENTS) for (const target of Object.keys(RUST_TARGETS) as IdfTarget[])
    await verifyNativeReceipt(root, spec, target);
  // No staging output is created before all source/archive/version checks pass.
  mkdirSync(output, { recursive: true });
  for (const name of names) {
    cpSync(join(root, "hosts/esp-idf/components", name), join(output, name), { recursive: true, filter: source => !ignored(source) });
    cpSync(join(root, "LICENSE"), join(output, name, "LICENSE"));
  }
  for (const spec of NATIVE_COMPONENTS) {
    const component = join(output, spec.component);
    for (const target of Object.keys(RUST_TARGETS) as IdfTarget[]) {
      const destination = join(component, "lib", target);
      mkdirSync(destination, { recursive: true });
      for (const file of [spec.archive, "build-receipt.json"])
        cpSync(join(root, "hosts/esp-idf/components", spec.component, "lib", target, file), join(destination, file));
      await verifyNativeReceipt(root, spec, target, destination);
    }
    const vendor = join(component, "vendor");
    mkdirSync(vendor, { recursive: true });
    const sources = [
      [join(root, "hosts/esp-idf/native", spec.crate), "native"],
      ...NATIVE_ENGINE_CRATES.map(crate => [join(root, "engine", crate), crate]),
    ];
    for (const [source, name] of sources) cpSync(source, join(vendor, name), { recursive: true, filter: path => !ignored(path) });
    const manifest = join(vendor, "native/Cargo.toml");
    writeFileSync(manifest, readFileSync(manifest, "utf8")
      .replaceAll("../../../../engine/runtime-cabi", "../runtime-cabi"));
  }
  for (const spec of NATIVE_COMPONENTS) for (const target of Object.keys(RUST_TARGETS) as IdfTarget[])
    await verifyNativeReceipt(root, spec, target, join(output, spec.component, "lib", target));
  console.log("ESP-IDF component staging verified: " + output);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output")) throw new Error("usage: esp-idf-release [--output directory]");
  await stageEspIdfComponents(ROOT, resolve(args[1] ?? join(ROOT, "dist/esp-idf-components")));
}
