// bun run macos [app] [flags…] — build + launch a PocketJS app on the portable Rust
// macOS host (hosts/desktop over the macos-app target; docs/BACKENDS.md).
//
//   bun run macos                    # the note, baked package fonts
//   bun run macos hero               # a fixed-viewport console demo,
//                                    # size-locked + baked glyphs
//   bun run macos note -- --file todo.md
//   bun run macos note --proof       # headless-ish acceptance: scripted
//                                    # typing, autosave round-trips, quits
//
// Everything host-facing derives from resolved contracts. An ordinary app
// becomes one ResolvedBuildPlan. A directory with pocket.system.json becomes
// one ResolvedSystemPlan containing complete installed-package
// plans; the host receives that file without child-plan field projection.
// The windowed run stays attached to your terminal; Cmd+Q quits.
import { existsSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { $ } from "bun";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import {
  validateAndResolveSystemPlan,
  validatePocketSystem,
  type ResolvedSystemPlan,
} from "../framework/src/manifest/system.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";

const root = new URL("..", import.meta.url).pathname;
// The portable desktop host is a git-only crate (npm files map ships
// this wrapper for parity with tools/note.ts, whose widget host is git-only
// too) — fail with directions instead of a cargo error mid-build.
if (!existsSync(`${root}hosts/desktop/Cargo.toml`)) {
  console.error(
    "bun run macos needs a git checkout: hosts/desktop is not part of the npm package (github.com/pocket-stack/pocketjs).",
  );
  process.exit(1);
}
const argv = process.argv.slice(2).filter((a) => a !== "--");
const proof = argv.includes("--proof");
const buildOnly = argv.includes("--build-only");
const rest = argv.filter((f) => f !== "--proof" && f !== "--build-only");
const appArg = rest[0] && !rest[0].startsWith("--") ? rest.shift()! : "note";
const appDir = appArg.replace(/-main$/, "");

const manifestPath = `${root}apps/${appDir}/pocket.json`;
if (!existsSync(manifestPath)) {
  throw new Error(`pocket-desktop-host: no manifest at apps/${appDir}/pocket.json`);
}
const systemPath = `${root}apps/${appDir}/pocket.system.json`;
let systemPlan: ResolvedSystemPlan | undefined;
let plan: ResolvedBuildPlan;

if (existsSync(systemPath)) {
  const rawSystem = await Bun.file(systemPath).json();
  const system = validatePocketSystem(rawSystem);
  if (!system.ok) {
    throw new Error(
      `pocket-desktop-host: invalid Pocket System at apps/${appDir}/pocket.system.json: ` +
        system.diagnostics
          .map((d) => `${d.path || "/"}: ${d.message}`)
          .join("; "),
    );
  }
  const installed = new Set(system.value.installation.installedPackages);
  const packages = await Promise.all(
    system.value.applications.catalog
      .filter((entry) => installed.has(entry.package))
      .map(async (entry) => ({
        source: entry.manifest,
        manifest: await Bun.file(`${root}${entry.manifest}`).json(),
      })),
  );
  const resolution = validateAndResolveSystemPlan(rawSystem, {
    target: "macos-app",
    packages,
  });
  if (!resolution.ok) {
    throw new Error(
      `pocket-desktop-host: ${system.value.title} did not resolve against macos-app: ` +
        resolution.diagnostics
          .map((d) => `${d.path || "/"}: ${d.message}`)
          .join("; "),
    );
  }
  systemPlan = resolution.plan;
  plan = systemPlan.systemUI.plan;
} else {
  const manifest = await Bun.file(manifestPath).json();
  const resolution = validateAndResolveBuildPlan(manifest, {
    target: "macos-app",
  });
  if (!resolution.ok) {
    throw new Error(
      `pocket-desktop-host: ${appDir} did not resolve against macos-app: ${resolution.diagnostics
        .map((d) => `${d.path || "/"}: ${d.message}`)
        .join("; ")}`,
    );
  }
  plan = resolution.plan;
}

const planPath = `${root}.pocket/macos-app/${plan.app.output}.plan.json`;
mkdirSync(resolvePath(planPath, ".."), { recursive: true });
const installedPlans = systemPlan
  ? [
      systemPlan.systemUI.plan,
      ...systemPlan.applications.map((entry) => entry.plan),
    ]
  : [plan];
for (const packagePlan of installedPlans) {
  const packagePlanPath = `${root}.pocket/macos-app/${packagePlan.app.output}.plan.json`;
  await Bun.write(packagePlanPath, JSON.stringify(packagePlan, null, 2) + "\n");
  await $`bun tools/build.ts --plan=${packagePlanPath} --project-root=${root}`.cwd(
    root,
  );
}

let systemPlanPath: string | undefined;
if (systemPlan) {
  systemPlanPath = `${root}.pocket/macos-app/${systemPlan.system.name}.system.plan.json`;
  await Bun.write(systemPlanPath, JSON.stringify(systemPlan, null, 2) + "\n");
}
await $`cargo build --release`.cwd(`${root}hosts/desktop`);

if (buildOnly) {
  console.log(
    (systemPlan
      ? `pocket-desktop-host: built SystemUI ${plan.app.output} + ` +
        `${systemPlan.applications.length} application packages`
      : `pocket-desktop-host: built ${plan.app.output}`) + " + release host",
  );
  process.exit(0);
}

const bin = `${root}hosts/desktop/target/release/pocket-desktop-host`;
const env = { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" };

// Every host flag derives from the resolved plan (issue #295 landed the
// companion list and viewport policy in it):
//   fixed        — plan.viewport.policy (size-locked run)
//   companions   — plan.companions: the svc names the app speaks; the host
//                  builds its svcOpen allowlist from exactly this list
//   editor       — the NOTE companion dialect (apps/note/svc.ts) — wired
//                  when the app declares the "note" companion
const fixed = plan.viewport.policy === "fixed";
const editor = plan.companions.includes("note");
const flags: string[] = systemPlanPath
  ? ["--system-plan", systemPlanPath]
  : [
      "--app",
      plan.app.output,
      "--title",
      plan.app.title,
      "--viewport",
      `${plan.viewport.logical[0]}x${plan.viewport.logical[1]}`,
      "--density",
      String(plan.viewport.rasterDensity),
      ...(fixed ? ["--fixed"] : []),
      ...(plan.companions.length > 0
        ? ["--companions", plan.companions.join(",")]
        : []),
      ...(editor ? ["--editor"] : []),
    ];

if (proof && !editor) {
  console.error(
    "bun run macos --proof drives the NOTE companion protocol (scripted typing + autosave); " +
      `${appDir} declares [${plan.companions.join(", ")}]. Script other apps with the host's ` +
      "--mouse/--key/--type/--click flags directly.",
  );
  process.exit(1);
}
if (proof) {
  const file = `${root}dist/macos-proof.md`;
  await $`rm -f ${file}`;
  // Click the header's pencil toggle (note-widget's proof coordinates),
  // then type — the debounced autosave must round-trip the text.
  await $`${bin} ${flags} --file ${file} --click 350,15@10 --type PROOF-POCKET-@40 --quit-after 220`.env(
    env,
  );
  const saved = (
    await Bun.file(file)
      .text()
      .catch(() => "")
  ).includes("PROOF-POCKET-");
  if (!saved)
    throw new Error("macos proof: autosave round-trip missed the typed text");
  console.log(
    "\nproof: typing landed at the caret through the svc protocol and the\ndebounced autosave wrote the file back out through the portable host.",
  );
} else {
  const fileFlags =
    editor && !rest.some((f) => f === "--file")
      ? ["--file", `${process.env.HOME}/.pocket-note.md`]
      : [];
  await $`${bin} ${flags} ${fileFlags} ${rest}`.env(env);
}
