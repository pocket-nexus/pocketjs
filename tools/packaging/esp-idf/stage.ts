#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_COMPONENTS, RUST_TARGETS, verifyNativeReceipt, type IdfTarget } from "./receipt.ts";
import { verifyComponentVersions } from "./component-versions.ts";
import { generatedIdfContracts } from "./contracts.ts";
import { vendorIdfProgram } from "./vendor.ts";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
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
  const targets = (Object.keys(RUST_TARGETS) as IdfTarget[]).filter(target =>
    NATIVE_COMPONENTS.every(spec => existsSync(join(root, "platforms/esp-idf", spec.component, "lib", target, spec.archive))));
  if (!targets.length) throw new Error("no native archives to stage");
  for (const spec of NATIVE_COMPONENTS) for (const target of targets)
    await verifyNativeReceipt(root, spec, target);
  // No staging output is created before all source/archive/version checks pass.
  mkdirSync(output, { recursive: true });
  for (const name of names) {
    cpSync(join(root, "platforms/esp-idf", name), join(output, name), { recursive: true, filter: source => !ignored(source) });
    cpSync(join(root, "LICENSE"), join(output, name, "LICENSE"));
  }
  for (const spec of NATIVE_COMPONENTS) {
    const component = join(output, spec.component);
    for (const target of targets) {
      const destination = join(component, "lib", target);
      mkdirSync(destination, { recursive: true });
      for (const file of [spec.archive, "build-receipt.json"])
        cpSync(join(root, "platforms/esp-idf", spec.component, "lib", target, file), join(destination, file));
      await verifyNativeReceipt(root, spec, target, destination);
    }
    const vendor = join(component, "vendor");
    mkdirSync(vendor, { recursive: true });
    vendorIdfProgram(root, vendor);
    const componentManifest = join(component, "idf_component.yml");
    writeFileSync(componentManifest, readFileSync(componentManifest, "utf8").replace(/targets:\n(?:  - [^\n]+\n)+/, `targets:\n${targets.map(target => `  - ${target}\n`).join("")}`));
    // Platform headers remain separate from the generic SDK. The component's
    // public include directory resolves them in both checkout and Registry builds.
    for (const name of ["pocket_drivers.h", "pocket_quickjs_abi.h", "pocket_runtime.h", "pocket_spec.h"])
      cpSync(join(root, "contracts/generated", name), join(component, "include", name));
  }
  const ppaInclude = join(output, "pocket_render_esp_ppa/include/pocket");
  mkdirSync(ppaInclude, { recursive: true });
  cpSync(join(root, "platforms/esp-idf/render-ppa/include/pocket/render_esp_ppa.h"), join(ppaInclude, "render_esp_ppa.h"));
  const guest = join(output, "pocket_guest_quickjs");
  mkdirSync(join(guest, "generated"), { recursive: true });
  for (const name of ["guest.c", "generated_ops.h"])
    cpSync(join(root, "engine/guest-quickjs/src", name), join(guest, "generated", name));
  cpSync(join(root, "engine/guest-quickjs/include/pocket_guest_quickjs.h"), join(guest, "include/pocket_guest_quickjs.h"));
  for (const spec of NATIVE_COMPONENTS) for (const target of targets)
    await verifyNativeReceipt(root, spec, target, join(output, spec.component, "lib", target));
  console.log("ESP-IDF component staging verified: " + output);
}

export async function stageEspIdfMain(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  if (args.length && (args.length !== 2 || args[0] !== "--output")) throw new Error("usage: esp-idf-release [--output directory]");
  await stageEspIdfComponents(ROOT, resolve(args[1] ?? join(ROOT, "dist/esp-idf-components")));
}

if (import.meta.main) await stageEspIdfMain();
