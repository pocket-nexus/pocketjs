import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { resolveRuntimeProgram } from "./build/programs.ts";
import { assertDeviceIdentity, fileSha256, type DeviceIdentity } from "./device-evidence.ts";
import { inspectDeviceLease } from "./device-lease.ts";
import { profileRegistry, type ResolvedProfile } from "./profile-resolver.ts";
import { readRuntimeDirectory } from "./repack.ts";
import { readRuntime } from "./repack/shared/runtime.ts";
import { targetState } from "./targets/store.ts";
import { currentHost } from "./targets/types.ts";

export interface DoctorOptions {
  target?: string; config?: string; generic?: boolean; from?: string;
  buildReceipt?: string; runtime?: string; evidence?: string; identity?: string; device?: string;
}
type Check = { name: string; status: "ok" | "fail" | "unverified"; detail: string };

export function verifyBuildReceipt(path: string, selected: Pick<ResolvedProfile, "profile" | "profileHash" | "hostAbi">): void {
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (receipt.schema !== "pocket-runtime-build/1" || receipt.success !== true ||
      receipt.target !== selected.profile.id || receipt.profileHash !== selected.profileHash ||
      receipt.hostAbi !== selected.hostAbi || !receipt.artifact || !receipt.files ||
      typeof receipt.files !== "object" || Array.isArray(receipt.files))
    throw new Error("build receipt is unsuccessful or belongs to another profile/binding generation");
  const artifact = resolve(dirname(path), receipt.artifact);
  const base = lstatSync(artifact).isDirectory() ? artifact : dirname(artifact);
  const names: string[] = [];
  const walk = (file: string) => {
    const stat = lstatSync(file);
    if (stat.isDirectory()) { for (const name of readdirSync(file).sort()) walk(join(file, name)); return; }
    if (!stat.isFile()) throw new Error("artifact contains a non-regular file: " + file);
    const name = relative(base, file), recorded = receipt.files[name];
    if (!recorded || stat.size !== recorded.bytes || fileSha256(file) !== recorded.sha256)
      throw new Error("artifact differs from build receipt: " + name);
    names.push(name);
  };
  walk(artifact);
  if (!names.length || JSON.stringify(names.sort()) !== JSON.stringify(Object.keys(receipt.files).sort()))
    throw new Error("artifact file list differs from build receipt");
}

/** Read-only inspection: building, installing, deployment and measurements remain explicit actions. */
export async function inspectProgram(options: DoctorOptions) {
  const selected = await resolveRuntimeProgram({ from: options.from ?? process.cwd(), target: options.target,
    runtimeConfig: options.config, generic: options.generic, env: process.env });
  const checks: Check[] = [];
  const check = async (name: string, run: () => string | Promise<string>) => {
    try { checks.push({ name, status: "ok", detail: await run() }); }
    catch (error) { checks.push({ name, status: "fail", detail: error instanceof Error ? error.message : String(error) }); }
  };
  const unverified = (name: string, detail: string) => checks.push({ name, status: "unverified", detail });
  await check("profile", () => {
    if (selected.hostAbi !== POCKET_BINDING_GENERATION) throw new Error("unsupported binding generation");
    return selected.profileHash;
  });
  const recipe = selected.config?.value.build, host = currentHost();
  if (recipe) await check("build host", () => {
    if (!host || !recipe.hosts.includes(host)) throw new Error("unsupported build host: " + host);
    return host;
  });
  if (recipe?.toolchain) await check("toolchain", () => {
    const state = targetState({ id: recipe.toolchain!.target, title: selected.profile.id, hosts: recipe.hosts,
      toolchain: recipe.toolchain, contract: { kind: "profile", target: selected.profile.id, registry: () => profileRegistry(selected.profile) } });
    if (state.state !== "installed" && state.state !== "nothing to install")
      throw new Error(JSON.stringify(state));
    return state.state;
  });
  else unverified("toolchain", "External tools are checked by the program's native build.");
  if (options.buildReceipt) await check("build receipt", () => {
    verifyBuildReceipt(options.buildReceipt!, selected);
    return resolve(options.buildReceipt!);
  });
  else unverified("build receipt", "Supply --build-receipt to verify native output bytes.");
  if (options.runtime) await check("runtime", async () => {
    const runtime = await readRuntime(readRuntimeDirectory(resolve(options.runtime!)), selected.profile.id);
    if (runtime.profileHash !== selected.profileHash) throw new Error("runtime profileHash differs from selected program");
    return runtime.pocketjs;
  });
  if (options.evidence || options.identity) await check("device evidence", () => {
    if (!options.evidence || !options.identity) throw new Error("--evidence and --identity must be supplied together");
    const record = JSON.parse(readFileSync(options.evidence, "utf8"));
    const expected = JSON.parse(readFileSync(options.identity, "utf8")) as DeviceIdentity;
    if (record.schemaVersion !== 1 || !Array.isArray(record.observations) || !record.observations.length)
      throw new Error("device evidence has no observations");
    assertDeviceIdentity(expected, record.identity);
    if (options.device && expected.device !== options.device) throw new Error("evidence device differs from --device");
    return `${record.observations.length} recorded observations match the supplied device/runtime/assets identity; acceptance budgets belong to the product.`;
  });
  else unverified("device evidence", "No device observations supplied; hardware acceptance is unverified.");
  if (options.device) await check("device lease", () => {
    const lease = inspectDeviceLease(options.device!);
    if (lease.state === "busy") throw new Error(`device busy: pid=${lease.owner?.pid ?? "unknown"}`);
    return lease.state;
  });
  return { schema: "pocket-doctor/1", ok: checks.every(check => check.status !== "fail"),
    target: selected.profile.id, profileHash: selected.profileHash, hostAbi: selected.hostAbi,
    config: selected.config?.path, checks };
}
