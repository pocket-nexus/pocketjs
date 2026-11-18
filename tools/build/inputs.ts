import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { BUNDLE_SECTION, decodeBundle, decodeIdentity, findSection } from "../../contracts/spec/bundle.ts";
import { extractHostBuildInputs } from "../../framework/compiler/host-build-inputs.ts";
import type { ResolvedBuildPlan } from "../../framework/compiler/plan.ts";
import type { RuntimeAotInput, RuntimeApplication } from "../../framework/src/host-config.ts";
import type { ResolvedProfile } from "../profile-resolver.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const text = new TextDecoder("utf-8", { fatal: true });
const outputName = (name: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error("runtime input has an invalid application output name");
  return name;
};

/** The same admission applies to native compilation and byte-only repacking:
 * the bundle's plan verifies its own checksum and host contract, records the
 * program's profile, and names the identity the bundle carries. A program
 * built for one host contract compiles in the plan's facts, so the bundle's
 * host contract hash must be the program's. */
export function admitApplication(selected: ResolvedProfile, bytes: Uint8Array) {
  const bundle = decodeBundle(bytes);
  if (bundle.hostAbi !== POCKET_BINDING_GENERATION) throw new Error("application binding generation differs from this runtime; recompile the application");
  if (bundle.profileHash !== selected.profileHash) throw new Error("application profileHash differs from the program profile");
  const identityBytes = findSection(bundle, BUNDLE_SECTION.identity);
  const planBytes = findSection(bundle, BUNDLE_SECTION.plan);
  const js = findSection(bundle, BUNDLE_SECTION.js);
  if (!identityBytes || !planBytes || !js?.length || js[js.length - 1] !== 0) throw new Error("application lacks identity, plan or NUL-terminated JavaScript");
  let plan: ResolvedBuildPlan;
  try { plan = JSON.parse(text.decode(planBytes)) as ResolvedBuildPlan; }
  catch { throw new Error("application plan section is not JSON"); }
  // Verifies planHash, the recorded host contract and profileHash.
  extractHostBuildInputs(plan, { expectedTarget: selected.profile.id, expectedProfileHash: selected.profileHash });
  if (plan.profileHash !== bundle.profileHash) throw new Error("application bundle and plan profile hashes differ");
  const identity = decodeIdentity(identityBytes);
  if (identity.id !== plan.app.id || identity.title !== plan.app.title || identity.output !== plan.app.output) throw new Error("application bundle and plan identities differ");
  const output = outputName(plan.app.output);
  return { bundle, plan, planBytes, js, output };
}

/** Admit before writing intermediates or invoking a native toolchain. */
export function prepareApplication(selected: ResolvedProfile, bundlePath: string, outdir: string): RuntimeApplication {
  const bytes = readFileSync(resolve(bundlePath));
  const { bundle, plan, planBytes, js, output } = admitApplication(selected, bytes);
  const directory = resolve(outdir, ".inputs", sha256(bytes));
  mkdirSync(directory, { recursive: true });
  const planPath = resolve(directory, "plan.json");
  const jsPath = resolve(directory, `${output}.js`), pakPath = resolve(directory, `${output}.pak`);
  const snapshotPath = resolve(directory, ".input.pkb");
  writeFileSync(snapshotPath, bytes);
  writeFileSync(planPath, planBytes);
  // The js section's terminator belongs to the bundle; native embedding
  // helpers add their own terminator when converting a script to a C array.
  writeFileSync(jsPath, js.subarray(0, js.length - 1));
  writeFileSync(pakPath, findSection(bundle, BUNDLE_SECTION.pak) ?? new Uint8Array());
  return { bundlePath: snapshotPath, directory, planPath, plan, jsPath, pakPath };
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
