// Compile the `app` section of a host config as `pocket compile` does, with
// the end-to-end identity and framework in place of the config's, so an E2E
// package never shadows a demo's own install on a device or an emulator.
//
//   bun tests/e2e/compile-variant.ts compile --config FILE --target ID \
//     --project-root DIR --outdir DIR --plan-dir DIR --output FILE \
//     [--variant '{"id":…,"title":…,"output":…,"framework":…}']
import { resolve } from "node:path";
import type { AppConfig } from "../../contracts/spec/app-config.ts";
import { compileApplication } from "../../tools/compile-app.ts";

/** The fields an E2E run replaces in the config's `app` section. */
export type AppVariant = Partial<Pick<AppConfig, "id" | "title" | "output" | "framework">>;

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.shift() !== "compile") throw new Error("usage: bun tests/e2e/compile-variant.ts compile --config FILE --target ID …");
  const option = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index < 0 ? undefined : args[index + 1];
  };
  const config = option("config"), target = option("target");
  if (!config || !target) throw new Error("--config and --target are required");
  const variant = JSON.parse(option("variant") ?? "{}") as AppVariant;
  try {
    await compileApplication({
      configPath: resolve(config), target,
      ...(option("project-root") ? { projectRoot: resolve(option("project-root")!) } : {}),
      outdir: option("outdir"), planRoot: option("plan-dir"), output: option("output"),
      app: app => ({ ...app, ...variant }),
    });
  } catch (error) {
    console.error(`E2E compile: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
