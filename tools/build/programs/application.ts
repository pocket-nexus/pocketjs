import { prepareApplication } from "../inputs.ts";
import { POCKET_BINDING_GENERATION } from "../../../contracts/spec/binding-generation.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { extractHostBuildInputs } from "../../../framework/src/manifest/host-build-inputs.ts";
import type { RuntimeApplication, RuntimeBuildContext } from "../../../framework/src/host-config.ts";
import { hashPocketProfile, type PocketProfile } from "../../../framework/src/profile.ts";

/** Native inputs come from the package admitted by the build executor. */
export function applicationBundle(application: RuntimeApplication, expectedTarget: string) {
  const inputs = extractHostBuildInputs(application.plan, { expectedTarget });
  for (const path of [application.packagePath, application.planPath, application.jsPath, application.pakPath]) {
    if (!existsSync(path)) throw new Error(`native build input is missing: ${path}`);
  }
  return { plan: application.plan, inputs, javaScript: application.jsPath, pack: application.pakPath };
}
export function requireApplication(context: RuntimeBuildContext): RuntimeApplication {
  if (!context.application) throw new Error(`${context.profile.id}: native build requires --pocket with a compiled application`);
  applicationBundle(context.application, context.profile.id);
  if (context.application.plan.profileHash !== context.profileHash) throw new Error("native build package profile differs from the program profile");
  return context.application;
}
export function requireProgramProfile(context: RuntimeBuildContext, profile: PocketProfile): void {
  if (context.profile.id !== profile.id || context.profileHash !== hashPocketProfile(profile)) {
    throw new Error(`${profile.id}: this native recipe requires its declared program profile`);
  }
}
/** Compatibility commands use the same executor and require explicit inputs. */
export async function runProgramBuild(id: string, args: readonly string[]): Promise<void> {
  const root = resolve(import.meta.dir, "../../..");
  const legacyDirectories: Record<string, string> = { "blackberry-classic": "blackberry-qnx", "nokia-e7": "symbian", "ipodtouch6": "ipodtouch", "ios-simulator": "ios" };
  const output = args.some(arg => arg === "--out" || arg === "--outdir" || arg.startsWith("--out=") || arg.startsWith("--outdir=")) ? [] : ["--out", resolve(root, "dist", legacyDirectories[id] ?? id)];
  const child = Bun.spawn([process.execPath, resolve(root, "tools/pocket.ts"), "build", "--config", resolve(root, `programs/${id}/pocket.host.config.ts`), ...output, ...args], {
    cwd: process.cwd(), stdout: "inherit", stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0 || child.signalCode) throw new Error(`${id}: native build failed (${child.signalCode ?? code})`);
}

/** Explicit package input for compatibility CLIs that retain native extensions. */
export function prepareCompiledApplication(profile: PocketProfile, args: readonly string[], outdir: string): RuntimeApplication {
  const index = args.indexOf("--pocket");
  const path = args.find(arg => arg.startsWith("--pocket="))?.slice("--pocket=".length) ?? (index >= 0 ? args[index + 1] : undefined);
  if (!path || path.startsWith("--")) throw new Error(`${profile.id}: native build requires --pocket; run pocket compile first`);
  return prepareApplication({ profile, profileHash: hashPocketProfile(profile), hostAbi: POCKET_BINDING_GENERATION, dependencies: [] }, path, outdir);
}

export function nativeOption(args: readonly string[], name: string): string | undefined {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
