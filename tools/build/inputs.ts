import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { decodeIdentity, decodePocketPackage, findSection, findVariant, POCKET_SECTION } from "../../contracts/spec/pocket-package.ts";
import { extractHostBuildInputs } from "../../framework/src/manifest/host-build-inputs.ts";
import type { ResolvedBuildPlan } from "../../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../../framework/src/manifest/resolve.ts";
import type { RuntimeAotInput, RuntimeApplication } from "../../framework/src/runtime-config.ts";
import { profileRegistry, type ResolvedProfile } from "../profile-resolver.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const text = new TextDecoder("utf-8", { fatal: true });
const outputName = (name: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error("runtime input has an invalid application output name");
  return name;
};

/** The same admission applies to native compilation and byte-only repacking. */
export function admitApplication(selected: ResolvedProfile, bytes: Uint8Array) {
  const decoded = decodePocketPackage(bytes);
  const variant = findVariant(decoded, selected.profile.id);
  if (!variant) throw new Error(`application has no ${selected.profile.id} variant`);
  if (variant.hostAbi !== POCKET_BINDING_GENERATION) throw new Error("application binding generation differs from this runtime; recompile the application");
  if (variant.profileHash !== selected.profileHash) throw new Error("application profileHash differs from the program profile");
  const identityBytes = findSection(variant, POCKET_SECTION.identity);
  const planBytes = findSection(variant, POCKET_SECTION.plan);
  const js = findSection(variant, POCKET_SECTION.js);
  if (!identityBytes || !planBytes || !js?.length || js[js.length - 1] !== 0) throw new Error("application lacks identity, plan or NUL-terminated JavaScript");
  const plan = JSON.parse(text.decode(planBytes)) as ResolvedBuildPlan;
  extractHostBuildInputs(plan, { expectedTarget: selected.profile.id, expectedProfileHash: selected.profileHash });
  const identity = decodeIdentity(identityBytes);
  if (identity.id !== plan.app.id || identity.title !== plan.app.title || identity.output !== plan.app.output) throw new Error("application package and plan identities differ");
  const manifest = JSON.parse(text.decode(decoded.manifest));
  const resolved = validateAndResolveBuildPlan(manifest, { target: selected.profile.id, executionClass: "guest", hostExtension: plan.hostExtension }, profileRegistry(selected.profile));
  if (!resolved.ok || resolved.plan.planHash !== plan.planHash) throw new Error("application manifest and resolved plan differ");
  const output = outputName(plan.app.output);
  return { decoded, variant, plan, planBytes, js, output };
}

/** Admit before writing intermediates or invoking a native toolchain. */
export function prepareApplication(selected: ResolvedProfile, packagePath: string, outdir: string): RuntimeApplication {
  const bytes = readFileSync(resolve(packagePath));
  const { decoded, variant, plan, planBytes, js, output } = admitApplication(selected, bytes);
  const directory = resolve(outdir, ".inputs", sha256(bytes));
  mkdirSync(directory, { recursive: true });
  const planPath = resolve(directory, "plan.json"), manifestPath = resolve(directory, "pocket.json");
  const jsPath = resolve(directory, `${output}.js`), pakPath = resolve(directory, `${output}.pak`);
  const snapshotPath = resolve(directory, ".input.pocket");
  writeFileSync(snapshotPath, bytes);
  writeFileSync(planPath, planBytes);
  writeFileSync(manifestPath, decoded.manifest);
  // The package terminator belongs to the package; native embedding helpers
  // add their own terminator when converting a source bundle to a C array.
  writeFileSync(jsPath, js.subarray(0, js.length - 1));
  writeFileSync(pakPath, findSection(variant, POCKET_SECTION.pak) ?? new Uint8Array());
  return { packagePath: snapshotPath, directory, planPath, plan, jsPath, pakPath, manifestPath };
}

export function prepareAot(selected: ResolvedProfile, directory: string, outdir?: string): RuntimeAotInput & { output: string } {
  directory = realpathSync(resolve(directory));
  const dependencyManifest = resolve(directory, "dependencies.json");
  const manifestBytes = readFileSync(dependencyManifest);
  const manifest = JSON.parse(text.decode(manifestBytes));
  if (manifest.schemaVersion !== 1 || manifest.kind !== "aot" || manifest.hostAbi !== POCKET_BINDING_GENERATION || manifest.profileHash !== selected.profileHash)
    throw new Error("AOT source manifest does not match the program profile or binding generation; recompile with pocket compile --aot");
  const plan = manifest.plan as ResolvedBuildPlan;
  extractHostBuildInputs(plan, { expectedTarget: selected.profile.id, expectedProfileHash: selected.profileHash });
  if (manifest.planHash !== plan.planHash || !Array.isArray(manifest.outputs) || !manifest.outputs.length) throw new Error("invalid AOT output manifest");
  const names = new Set<string>();
  const files = new Map<string, Uint8Array>();
  for (const output of manifest.outputs) {
    const name = output?.file;
    if (typeof name !== "string" || !name || isAbsolute(name) || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..") || names.has(name))
      throw new Error("invalid or duplicate AOT output path");
    names.add(name);
    const path = realpathSync(resolve(directory, name));
    const local = relative(directory, path);
    if (local === ".." || local.startsWith("../") || !statSync(path).isFile()) throw new Error(`AOT output is outside its source directory: ${name}`);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== output.sha256) throw new Error(`AOT output checksum mismatch: ${name}`);
    files.set(name, bytes);
  }
  if (!names.has("include.rs") || !names.has("mod.rs")) throw new Error("AOT output manifest lacks generated sources");
  if (outdir) {
    directory = resolve(outdir, ".inputs", `aot-${sha256(manifestBytes)}`);
    mkdirSync(directory, { recursive: true });
    for (const [name, bytes] of files) {
      const path = resolve(directory, name); mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, bytes);
    }
    writeFileSync(resolve(directory, "dependencies.json"), manifestBytes);
  }
  return { directory, includeFile: resolve(directory, "include.rs"), dependencyManifest: resolve(directory, "dependencies.json"), output: outputName(plan.app.output) };
}
