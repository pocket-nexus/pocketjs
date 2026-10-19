// bun run widget [app] [flags…] — build + launch a Pocket Stage desktop widget
// (the first bundled stage is the PSP asset; docs/WIDGET.md).
//
//   bun run widget                # the hero demo inside the widget
//   bun run widget im             # any demo (name resolves to <name>-main)
//   bun run widget --stage ipod   # iPod nano Hero + authored nano profile
//   bun run widget -- --focus     # extra flags pass through to the binary
//   bun run widget im --auto-quit 5
//   bun run widget --proof        # headless acceptance: a scripted D-pad
//                                 # tap + a real ray-picked CIRCLE click
//                                 # drive hero to "Count: 1"
//
// The windowed run stays attached to your terminal — quit with Esc (or
// Ctrl-C). On exit the shell prints its governor receipt:
// "pocket-widget: N ticks, M frames rendered" — a settled app should show
// M ≪ N.
import { $ } from "bun";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { demoManifestFor } from "./demo-identity.ts";
import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";

const root = new URL("..", import.meta.url).pathname;

/** Transitional embedded target shared by the bundled PSP and iPod stages. */
export const STAGE_TARGET_ID = "macos-embedded";
// Same current desktop HostOps wire generation as macos-widget; form and
// capabilities differ even though the native UI surface implementation is shared.
export const STAGE_HOST_ABI = 3;
export type WidgetStage = "psp" | "ipod";

export interface StageDisplayFacts {
  readonly logicalSize: readonly [number, number];
  readonly rasterDensity: number;
}

export interface WidgetStageConfig {
  readonly defaultApp: string;
  readonly profile: string;
  readonly display: StageDisplayFacts;
}

/** Every bundled stage is one registry entry pointing at an authored model
 * package; the launcher owns no model facts of its own. Adding a stage means
 * adding a line here, nothing else. */
const STAGE_REGISTRY: Record<WidgetStage, { defaultApp: string; profile: string }> = {
  psp: {
    defaultApp: "hero-main",
    profile: resolvePath(root, "engine/pocket3d/examples/handheld/assets/dibad-psp/profile.json"),
  },
  ipod: {
    defaultApp: "ipodnano-hero-main",
    profile: resolvePath(root, "engine/pocket3d/examples/handheld/assets/ipod-nano-2/profile.json"),
  },
};

function isWidgetStage(value: string): value is WidgetStage {
  return Object.hasOwn(STAGE_REGISTRY, value);
}

const STAGE_CHOICES = Object.keys(STAGE_REGISTRY).join(" or ");

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/** Validate the display facts shared by build admission and the native host. */
export function stageDisplayFacts(
  input: unknown,
  label = "stage profile",
): StageDisplayFacts {
  const profile = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as {
    display?: { logical_size?: unknown; raster_density?: unknown };
  };
  const logical = profile.display?.logical_size;
  const density = profile.display?.raster_density;
  if (
    !Array.isArray(logical) ||
    logical.length !== 2 ||
    !positiveInteger(logical[0]) ||
    !positiveInteger(logical[1]) ||
    !positiveInteger(density) ||
    density > 4
  ) {
    throw new Error(
      `pocket-stage: ${label} has invalid display.logical_size/raster_density`,
    );
  }
  return {
    logicalSize: [logical[0], logical[1]],
    rasterDensity: density,
  };
}

/** Read only the display facts the launcher owns from an authored stage profile. */
function displayFromProfile(profilePath: string): StageDisplayFacts {
  return stageDisplayFacts(JSON.parse(readFileSync(profilePath, "utf8")), profilePath);
}

/** Resolve wrapper-owned defaults without leaking the model choice into Rust code. */
export function widgetStageConfig(stage: WidgetStage): WidgetStageConfig {
  const entry = STAGE_REGISTRY[stage];
  return { ...entry, display: displayFromProfile(entry.profile) };
}

export function stagePlatformContracts(display: StageDisplayFacts) {
  const [width, height] = display.logicalSize;
  const density = display.rasterDensity;
  return definePlatformContractRegistry(
    POCKET_CAPABILITIES,
    defineTargetRegistry({
      [STAGE_TARGET_ID]: {
        hostAbi: STAGE_HOST_ABI,
        platform: "macos",
        form: "embedded",
        display: {
          physicalViewport: [width * density, height * density],
          logicalViewports: [[width, height]],
          presentations: ["native", "integer-fit"],
          rasterDensity: density,
        },
        capabilities: [
          "input.analog.left",
          "input.buttons",
          "input.cursor",
          "text.glyphs.baked",
        ],
      },
    }),
  );
}

/** The bundled PSP stage's display facts anchor the historical exports. */
const PSP_STAGE_DISPLAY = widgetStageConfig("psp").display;

/** Backwards-compatible PSP contracts for existing imports and callers. */
export const STAGE_PLATFORM_CONTRACTS = stagePlatformContracts(PSP_STAGE_DISPLAY);

export function resolveStageBuildPlan(
  input: unknown,
  display: StageDisplayFacts = PSP_STAGE_DISPLAY,
): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: STAGE_TARGET_ID },
    stagePlatformContracts(display),
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket-stage: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}

export interface WidgetArgs {
  stage: WidgetStage;
  app: string;
  proof: boolean;
  pass: string[];
}

const LAUNCHER_OWNED_RUNTIME_FLAGS = ["--app", "--js", "--pak", "--profile"] as const;

export function validateWidgetArgs(args: WidgetArgs): void {
  const runtimeOverride = args.pass.find((arg) =>
    LAUNCHER_OWNED_RUNTIME_FLAGS.some(
      (flag) => arg === flag || arg.startsWith(`${flag}=`),
    ),
  );
  if (runtimeOverride) {
    throw new Error(
      `${runtimeOverride} is launcher-owned; choose the verified model package with --stage`,
    );
  }
  if (args.proof && args.stage !== "psp") {
    throw new Error("--proof uses the bundled PSP stage");
  }
  if (args.proof && args.app !== "hero-main") {
    throw new Error("--proof uses the bundled hero-main acceptance app");
  }
  if (args.proof && args.pass.length > 0) {
    throw new Error(
      "--proof is a fixed bundled-stage acceptance and cannot be combined with stage flags",
    );
  }
}

/**
 * Parse wrapper arguments without guessing which tokens are flag values.
 * Only argv[0], when positional, names the app. Everything after it keeps
 * its original order for the Rust binary, except the wrapper-only --proof.
 */
export function parseWidgetArgs(rawArgs: readonly string[]): WidgetArgs {
  // `bun run widget -- ...` may leave the option separator in argv. It is a
  // wrapper delimiter, not an argument understood by the pocket-stage binary.
  const input = rawArgs.filter((arg) => arg !== "--");
  const args: string[] = [];
  let stage: WidgetStage = "psp";
  let sawStage = false;
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (arg === "--stage" || arg.startsWith("--stage=")) {
      if (sawStage) throw new Error("--stage may only be specified once");
      const value = arg === "--stage" ? input[++i] : arg.slice("--stage=".length);
      if (value === undefined || !isWidgetStage(value)) {
        throw new Error(`--stage wants ${STAGE_CHOICES}`);
      }
      stage = value;
      sawStage = true;
      continue;
    }
    args.push(arg);
  }

  const stageConfig = widgetStageConfig(stage);
  const first = args[0];
  const hasApp = first !== undefined && !first.startsWith("--");
  const name = hasApp ? first : stageConfig.defaultApp;
  const rest = hasApp ? args.slice(1) : args;

  // Demo names resolve to their mounted -main entry (apps/<name>/main.tsx);
  // the bare name would build the side-effect-free component module.
  const app = name.includes("/") || name.endsWith("-main") ? name : `${name}-main`;
  return {
    stage,
    app,
    proof: rest.includes("--proof"),
    pass: rest.filter((arg) => arg !== "--proof"),
  };
}

/** Keep concurrent stage/app admissions from overwriting one shared plan. */
export function stagePlanPath(stage: WidgetStage, app: string): string {
  const appSlug = app.replace(/[^A-Za-z0-9._-]/g, "_") || "app";
  return resolvePath(root, ".pocket", STAGE_TARGET_ID, `${stage}-${appSlug}.plan.json`);
}

async function main(): Promise<void> {
  const parsed = parseWidgetArgs(process.argv.slice(2));
  validateWidgetArgs(parsed);
  const { stage, app, proof, pass } = parsed;
  const stageConfig = widgetStageConfig(stage);

  // Stock demos own their committed pocket.json. Legacy demos without one
  // inherit the root template through demoManifestFor; either way the build
  // is admitted once against the embedded Stage profile and every later
  // compiler input comes from the serialized plan.
  const demo = app.replace(/-main$/, "");
  const manifest = demoManifestFor(root, demo);
  const plan = resolveStageBuildPlan(manifest, stageConfig.display);
  const planPath = stagePlanPath(stage, app);
  mkdirSync(resolvePath(planPath, ".."), { recursive: true });
  await Bun.write(planPath, JSON.stringify(plan, null, 2) + "\n");

  // Bundles are stage-flavored (a 480x272 PSP build of an app is not its
  // 176x132 iPod build), so each stage owns a dist directory. Concurrent
  // stage launches of the same app can no longer clobber one another, and
  // target-flavored bundles in dist/ proper are never picked up by mistake.
  const stageDist = resolvePath(root, "dist", `stage-${stage}`);
  await $`bun tools/build.ts --plan=${planPath} --project-root=${root} --outdir=${stageDist}`.cwd(root);
  await $`cargo build --release -p pocket-stage`.cwd(`${root}engine`);

  const bin = `${root}engine/target/release/pocket-stage`;
  const env = {
    ...process.env,
    RUST_LOG: process.env.RUST_LOG ?? "info",
    POCKETJS_DIST: stageDist,
  };

  if (proof) {
    const shot = `${root}dist/pocket-stage-proof.png`;
    await $`${bin} --app ${plan.app.output} --profile ${stageConfig.profile} --screenshot ${shot} --frames 90 --tap down@10 --click 869,255 --expect-hit btn_circle --expect-ui-hash 0xc34a21cff1f13b06`.env(env);
    console.log(
      "\nproof: the binary asserted both the 3D CIRCLE ray hit and" +
        '\nthe final PocketJS DrawList — the screen reads "Count: 1".' +
        `\n${shot}`,
    );
    await $`open ${shot}`.nothrow();
  } else {
    await $`${bin} --app ${plan.app.output} --profile ${stageConfig.profile} ${pass}`.env(env);
  }
}

if (import.meta.main) {
  await main();
}
