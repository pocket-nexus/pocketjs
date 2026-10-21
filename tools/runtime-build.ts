import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalProfileJson } from "../framework/src/profile.ts";
import type { RuntimeBuildContext, RuntimeBuildStep } from "../framework/src/runtime-config.ts";
import { exportProfile } from "./profile-export.ts";
import { profileRegistry, type ResolvedProfile } from "./profile-resolver.ts";
import { currentHost, type TargetDescriptor } from "./targets/types.ts";
import { requireToolchain, storeLayout, targetLock } from "./targets/store.ts";
import { withSharedLock } from "./targets/lock.ts";

export async function buildRuntime(selected: ResolvedProfile, outdir: string): Promise<void> {
  const config = selected.config;
  if (!config) throw new Error("pocket build requires pocket.runtime-config.ts");
  const exported = exportProfile(selected, outdir);
  const recipe = config.value.build;
  if (!recipe) {
    console.log(`✓ Profile exported: ${exported.header}`);
    console.log("Native compilation is owned by the external build system.");
    return;
  }
  const host = currentHost();
  if (!host || !recipe.hosts.includes(host)) throw new Error(`runtime build supports ${recipe.hosts.join(", ")}, not ${host ?? process.platform}`);
  const descriptor: TargetDescriptor = {
    id: recipe.toolchain?.target ?? selected.profile.id, title: selected.profile.id,
    hosts: recipe.hosts, toolchain: recipe.toolchain,
    contract: { kind: "profile", target: selected.profile.id, registry: () => profileRegistry(selected.profile) },
  };
  const perform = async () => {
    const toolchain = requireToolchain(descriptor);
    const paths = Object.fromEntries(Object.entries(toolchain?.components ?? {}).map(([name, component]) => [name, component.path ?? component.toolchain!]));
    const configDirectory = dirname(config.path);
    const env = {
      POCKETJS_TARGET: selected.profile.id,
      POCKETJS_HOST_ABI: String(selected.hostAbi),
      POCKETJS_TICK_HZ: String(selected.profile.tickHz),
      POCKETJS_PROFILE_JSON: canonicalProfileJson(selected.profile),
      POCKETJS_PROFILE_HASH: selected.profileHash,
      POCKETJS_PROFILE_EXPORT_DIR: outdir,
    };
    const context: RuntimeBuildContext = {
      profile: selected.profile, profileHash: selected.profileHash,
      configDirectory, outdir, env, toolchainPaths: paths,
      async run(command, options = {}) {
        if (!command.length) throw new Error("runtime command must not be empty");
        const child = Bun.spawn([...command], {
          cwd: resolve(configDirectory, options.cwd ?? "."),
          env: { ...process.env, ...options.env, ...env }, stdout: "inherit", stderr: "inherit",
        });
        const status = await child.exited;
        if (status !== 0 || child.signalCode) throw new Error(`${command[0]} failed: ${child.signalCode ?? status}`);
      },
    };
    const steps: readonly RuntimeBuildStep[] = Array.isArray(recipe.steps) ? recipe.steps : [recipe.steps as RuntimeBuildStep];
    for (const step of steps) {
      if (step.kind === "compilerOnly") continue;
      const options = { cwd: step.cwd, env: step.env };
      if (step.kind === "cargo") {
        const rust = Object.values(toolchain?.components ?? {}).find(component => component.kind === "rustup")?.toolchain;
        await context.run(["cargo", ...(rust ? [`+${rust}`] : []), "build", "--locked",
          ...(step.release === false ? [] : ["--release"]),
          ...(step.manifest ? ["--manifest-path", step.manifest] : []),
          ...(step.package ? ["--package", step.package] : []),
          ...(step.target ? ["--target", step.target] : []),
          ...(step.buildStd?.length ? [`-Zbuild-std=${step.buildStd.join(",")}`] : []),
          ...(step.features?.length ? ["--features", step.features.join(",")] : []), ...(step.args ?? [])], options);
      } else if (step.kind === "make") {
        await context.run(["make", ...(step.target ? [step.target] : []),
          ...Object.entries(step.variables ?? {}).map(([key, value]) => `${key}=${value}`), ...(step.args ?? [])], options);
      } else {
        const build = resolve(configDirectory, step.cwd ?? ".", step.buildDirectory ?? ".pocket-build/native");
        await context.run(["cmake", "-S", step.source ?? ".", "-B", build,
          ...Object.entries(step.definitions ?? {}).map(([key, value]) => `-D${key}=${value}`), ...(step.args ?? [])], options);
        await context.run(["cmake", "--build", build, ...(step.target ? ["--target", step.target] : [])], options);
      }
    }
    await recipe.run?.(context);
    if (recipe.artifact) {
      const artifact = resolve(configDirectory, recipe.artifact.replaceAll("{output}", selected.profile.id));
      if (!existsSync(artifact)) throw new Error(`runtime build did not produce ${artifact}`);
      console.log(`✓ Runtime artifact: ${artifact}`);
    }
  };
  mkdirSync(outdir, { recursive: true });
  if (recipe.toolchain) await withSharedLock(targetLock(storeLayout(), descriptor.id), perform);
  else await perform();
}
