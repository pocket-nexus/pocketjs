#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_COMPONENTS, RUST_TARGETS, verifyNativeReceipt, type IdfTarget } from "./esp-idf-native-receipt.ts";
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
      [join(root, "hosts/esp-idf/native/abi"), "abi"],
      [join(root, "hosts/esp-idf/native/runtime"), "runtime"],
      [join(root, "engine/core"), "core"],
      [join(root, "engine/spec"), "spec"],
      [join(root, "engine/drivers"), "drivers"],
      [join(root, "engine/raster"), "raster"],
      [join(root, "engine/present"), "present"],
      [join(root, "engine/package"), "package"],
      [join(root, "engine/modules/media"), "modules/media"],
      [join(root, "engine/render/draw-ops"), "render/draw-ops"],
      [join(root, "engine/render/glyph-pages"), "render/glyph-pages"],
      ...(spec.crate === "render-rgb565" ? [[join(root, "engine/backends/rgb565"), "renderer"]] : []),
    ];
    for (const [source, name] of sources) cpSync(source, join(vendor, name), { recursive: true, filter: path => !ignored(path) });
    const manifest = join(vendor, "native/Cargo.toml");
    writeFileSync(manifest, readFileSync(manifest, "utf8")
      .replaceAll("../../../../engine/core", "../core")
      .replaceAll("../../../../engine/backends/rgb565", "../renderer"));
    if (spec.crate === "render-rgb565") {
      const backendManifest = join(vendor, "renderer/Cargo.toml");
      // The backend moves from engine/backends/rgb565 to vendor/renderer;
      // its engine siblings are one level closer in the staged component.
      writeFileSync(backendManifest, readFileSync(backendManifest, "utf8")
        .replaceAll(/(\bpath\s*=\s*["'])\.\.\/\.\.\//g, "$1../"));
    }
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
