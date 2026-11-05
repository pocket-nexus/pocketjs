// Reproducible pocketjs.dev build from a fresh checkout. Keep local preview,
// main deploys, and tag releases on the same prerequisite chain.
import { docDemoAppsIn, resolveDocDemo } from "../site/doc-demos.ts";

const ROOT = new URL("..", import.meta.url).pathname;

async function run(...args: string[]) {
  const child = Bun.spawn(["bun", ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

await run("tools/wasm.ts");
await run("tools/text-wasm.ts");
// The homepage stage ships the Pocket Launcher + every admitted app as
// `.pocket` packages (docs/LAUNCHER.md + docs/PLATFORM.md): registry scan, per-app
// bundles, deterministic sim-rendered covers, the launcher bundle, then
// the packages the stage serves.
await run("tools/launcher.ts", "pack");
// Live docs demos: every app a `:::demo <app>` directive names under
// site/content/docs/. site/build.ts throws when one of these is missing, so
// the artifact chain and the directive stay in step from a fresh checkout.
for (const app of docDemoAppsIn(ROOT + "site/content/docs/")) {
  const demo = resolveDocDemo(app);
  await run("tools/build.ts", demo.output, `--framework=${demo.framework}`);
}
// Independent display sizes for the two authored handheld models.
await run("tools/build.ts", "3ds-demo-main", "--outdir=dist/handheld-apps");
await run("tools/build.ts", "motions-main", "--density=2", "--outdir=dist/handheld-apps");
// site/build.ts bundles the playground runtimes with dist/hero.styles.ts.
await run("tools/build.ts", "hero");
await run("site/build.ts");
