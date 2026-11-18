import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { readRuntimeDirectory } from "../repack.ts";
import { admitRepackBundle, readRuntime, type RepackIdentity } from "../repack/shared/runtime.ts";
import { admissionHost, admitBundle, describeRejection } from "../../contracts/spec/admission.ts";
import { BUNDLE_SECTION, decodeBundle, findSection } from "../../contracts/spec/bundle.ts";
import type { ResolvedBuildPlan } from "../../framework/compiler/plan.ts";
import { appIdentity, appOutput } from "../../framework/compiler/app-plan.ts";
import { releasedRuntime } from "../release/fetch.ts";
import { resolveRuntimeProgram } from "./programs.ts";

export interface PackOptions {
  target?: string; config?: string; runtime?: string; bundle: string; output?: string;
  id?: string; title?: string; author?: string; version?: string; icon?: string;
  releaseVersion?: string; manifestUrl?: string;
}
/** Repacking consumes a recipe's byte-to-byte adapter and a verified runtime. */
export async function packRuntime(options: PackOptions, cwd = process.cwd()): Promise<string> {
  const selected = await resolveRuntimeProgram({ from: cwd, target: options.target, hostConfig: options.config, generic: true, env: process.env });
  const recipe = selected.config!.value.build;
  const adapter = recipe?.genericRuntime;
  if (!adapter) throw new Error("this host config has no genericRuntime.repack adapter");
  const bytes = new Uint8Array(readFileSync(resolve(cwd, options.bundle)));
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
  // The runtime's host contract admits the bundle by its facts; the plan
  // supplies the default identity.
  const bundle = decodeBundle(bytes);
  const admission = admitBundle(bundle, admissionHost(metadata.document, metadata.profileHash, metadata.hostAbi));
  if (!admission.ok) throw new Error(`this runtime does not admit the application: ${describeRejection(admission)}`);
  const plan = JSON.parse(new TextDecoder().decode(findSection(bundle, BUNDLE_SECTION.plan)!)) as ResolvedBuildPlan;
  // The icon section (the application's `app.icon`) is the icon default. The
  // author comes from --author, or from the `app` section of the
  // application's host config when `pocket pack` runs in its directory.
  const icon = findSection(bundle, BUNDLE_SECTION.icon);
  const app = selected.application?.value.app;
  const declaredAuthor = app && appIdentity(app, appOutput(app)).id === plan.app.id ? app.author : undefined;
  const identity: RepackIdentity = {
    id: options.id ?? plan.app.id, title: options.title ?? plan.app.title,
    author: options.author ?? declaredAuthor ?? "Unspecified", version: options.version ?? plan.app.version,
    ...(options.icon ? { icon: new Uint8Array(readFileSync(resolve(cwd, options.icon))) } : icon ? { icon } : {}),
  };
  await admitRepackBundle(bytes, metadata, identity);
  const result = await adapter.repack({ runtime, bundle: bytes, identity });
  const output = resolve(cwd, options.output ?? `${plan.app.output}${adapter.extension ?? ".bin"}`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, result);
  console.log(`✓ Package: ${output} (${result.length} bytes)`);
  return output;
}
