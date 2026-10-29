import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { readCommunitySigner } from "../community-key.ts";
import { readRuntimeDirectory } from "../repack.ts";
import { admitPocket, readRuntime, type RepackIdentity } from "../repack/shared/runtime.ts";
import { admissionHost, describeRejection, selectVariant } from "../../contracts/spec/admission.ts";
import { decodePocketPackage, findSection, POCKET_SECTION } from "../../contracts/spec/pocket-package.ts";
import type { ResolvedBuildPlan } from "../../framework/src/manifest/plan.ts";
import { releasedRuntime } from "../release/fetch.ts";
import { resolveRuntimeProgram } from "./programs.ts";

export interface PackOptions {
  target?: string; config?: string; runtime?: string; pocket: string; output?: string;
  id?: string; title?: string; author?: string; version?: string; icon?: string;
  releaseVersion?: string; manifestUrl?: string;
}
/** Repacking consumes a recipe's byte-to-byte adapter and a verified runtime. */
export async function packRuntime(options: PackOptions, cwd = process.cwd()): Promise<string> {
  const selected = await resolveRuntimeProgram({ from: cwd, target: options.target, hostConfig: options.config, generic: true, env: process.env });
  const recipe = selected.config!.value.build;
  const adapter = recipe?.genericRuntime;
  if (!adapter) throw new Error("this host config has no genericRuntime.repack adapter");
  const pocket = new Uint8Array(readFileSync(resolve(cwd, options.pocket)));
  let runtimeDirectory = options.runtime ? resolve(cwd, options.runtime) : undefined;
  // A build output root may hold its runtime artifact in a named subdirectory.
  if (runtimeDirectory && !existsSync(resolve(runtimeDirectory, "runtime.json")) && existsSync(resolve(runtimeDirectory, "build-receipt.json"))) {
    const receipt = JSON.parse(readFileSync(resolve(runtimeDirectory, "build-receipt.json"), "utf8"));
    if (receipt.schema !== "pocket-runtime-build/1" || receipt.success !== true || receipt.hostAbi !== POCKET_BINDING_GENERATION || receipt.profileHash !== selected.profileHash || typeof receipt.artifact !== "string")
      throw new Error("runtime build receipt does not match the selected profile");
    const artifact = resolve(runtimeDirectory, receipt.artifact);
    const child = relative(runtimeDirectory, artifact);
    if (child === ".." || child.startsWith("../")) throw new Error("runtime build receipt artifact is outside the output directory");
    runtimeDirectory = artifact;
  }
  if (runtimeDirectory && !existsSync(resolve(runtimeDirectory, "runtime.json"))) throw new Error("generic runtime has no runtime.json");
  const runtime = runtimeDirectory ? readRuntimeDirectory(runtimeDirectory) :
    await releasedRuntime(selected.profile.id, selected.profileHash, { version: options.releaseVersion, manifestUrl: options.manifestUrl });
  const metadata = await readRuntime(runtime, selected.profile.id);
  if (metadata.profileHash !== selected.profileHash) throw new Error("runtime profileHash differs from the host config");
  // The runtime's host contract admits the package by its facts; the
  // admitted variant's plan supplies the default identity.
  const selection = selectVariant(decodePocketPackage(pocket), admissionHost(metadata.document, metadata.profileHash, metadata.hostAbi));
  if (!selection.ok) throw new Error(`this runtime does not admit the application: ${describeRejection(selection)}`);
  const plan = JSON.parse(new TextDecoder().decode(findSection(selection.variant, POCKET_SECTION.plan)!)) as ResolvedBuildPlan;
  // The manifest's author and icon (stored as the cover section) are the
  // identity defaults.
  const declared = JSON.parse(new TextDecoder().decode(decodePocketPackage(pocket).manifest)) as { author?: unknown; icon?: unknown };
  const cover = typeof declared.icon === "string" ? findSection(selection.variant, POCKET_SECTION.cover) : null;
  const identity: RepackIdentity = {
    id: options.id ?? plan.app.id, title: options.title ?? plan.app.title,
    author: options.author ?? (typeof declared.author === "string" ? declared.author : "Unspecified"), version: options.version ?? plan.app.version,
    ...(options.icon ? { icon: new Uint8Array(readFileSync(resolve(cwd, options.icon))) } : cover ? { icon: cover } : {}),
  };
  await admitPocket(pocket, metadata, identity);
  const result = await adapter.repack({ runtime, pocket, identity, ...(adapter.signed ? { signer: readCommunitySigner() } : {}) });
  const output = resolve(cwd, options.output ?? `${plan.app.output}${adapter.extension ?? ".bin"}`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, result);
  console.log(`✓ Package: ${output} (${result.length} bytes)`);
  return output;
}
