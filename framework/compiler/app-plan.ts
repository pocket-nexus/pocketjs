// Resolve the `app` section of a host config into the build plan for one
// host: the viewport and auxiliary surface the host presents, which of the
// application's features the host provides, the worker domain, the tick
// rate and the artifact name. The plan (./plan.ts) is the compiler's input.
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveWorkerChannels, WORKER_LIMITS, workerCapabilities, type WorkerResourceKind } from "../../contracts/spec/worker.ts";
import { isHostExtension, type HostExtension } from "./host-extension.ts";
import { hashPocketProfile } from "../src/profile.ts";
import { compiledProfile, profileChannels } from "../../contracts/spec/profile.ts";
import { profileDocument } from "../../hosts/contract.ts";
import { DYNAMIC_FORMS, TARGET_FORMS } from "../../contracts/spec/platforms.ts";
import { deriveModality } from "../../contracts/spec/modality.ts";
import { validateAppConfig, APP_OUTPUT_PATTERN, type AppConfig } from "../../contracts/spec/app-config.ts";
import type { AnimationTheme } from "../../contracts/spec/animation-theme.ts";
import type { ContractDiagnostic } from "../../contracts/spec/json-schema.ts";
import type { AppViewport, FixedViewportSpec } from "../../contracts/spec/viewport.ts";
import {
  POCKET_PLATFORM_CONTRACTS,
  type FixedDisplayProfile,
  type PlatformContractRegistry,
  type PresentationMode,
  type TargetProfile,
  type Viewport,
} from "../../contracts/spec/platforms.ts";
import {
  finalizeBuildPlan,
  type ResolvedBuildPlan,
  type ResolvedBuildPlanContent,
} from "./plan.ts";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { cadenceFor } from "../../contracts/spec/admission.ts";

/** The package rate when the application states none (`app.tickHz`). */
export const DEFAULT_TICK_HZ = 60;
/** The application version when the config states none. */
export const DEFAULT_APP_VERSION = "0.1.0";
const AUXILIARY_DISPLAY = "display.auxiliary";
const AUXILIARY_TOUCH = "input.touch.auxiliary";

export interface ResolveAppRequest {
  readonly target: string;
  /** Artifact selected by the caller. Omitted retains JavaScript guest plans. */
  readonly executionClass?: "guest" | "aot";
  /** Versioned adapter input, interpreted only by its owner. */
  readonly hostExtension?: HostExtension;
  /** The directory `app.entry`, `app.worker.entry` and `app.icon` are
   *  relative to: the config file's. Defaults to `projectRoot`. */
  readonly configDirectory?: string;
  /** The directory the plan's entries are relative to: the `--project-root`
   *  of `tools/build.ts --plan`. Defaults to `configDirectory`. */
  readonly projectRoot?: string;
}

export type ResolutionResult =
  | { readonly ok: true; readonly plan: ResolvedBuildPlan }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

/** The identity a device packager stamps: the config's, or the defaults
 *  derived from the output name. */
export function appIdentity(app: Pick<AppConfig, "id" | "title" | "version">, output: string): { id: string; title: string; version: string } {
  return { id: app.id ?? `local.${output}`, title: app.title ?? output, version: app.version ?? DEFAULT_APP_VERSION };
}

/** The artifact name: `app.output`, or the entry's file name without its
 *  extension. */
export function appOutput(app: Pick<AppConfig, "entry" | "output">): string {
  return app.output ?? app.entry.split("/").pop()!.replace(/\.tsx?$/, "");
}

function sameViewport(left: Viewport, right: Viewport): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

/**
 * Native presentation fills the panel: one logical px = rasterDensity
 * physical px, with no letterbox. A panel is the same panel turned a quarter
 * turn, so a logical viewport that fills it in the transposed orientation
 * fills it too — that is how a portrait handheld hosts a landscape app. The
 * returned physical viewport is the panel as the app sees it (transposed
 * when the fit was transposed); `logicalViewports` stays the gate that says
 * which orientations a target's host can actually present.
 */
function nativeFill(logical: Viewport, rasterDensity: number, panel: Viewport): Viewport | null {
  const scaled: Viewport = [logical[0] * rasterDensity, logical[1] * rasterDensity];
  if (sameViewport(scaled, panel)) return [panel[0], panel[1]];
  if (sameViewport(scaled, [panel[1], panel[0]])) return [panel[1], panel[0]];
  return null;
}

function resolveFixedDisplay(
  requested: { logical: Viewport; presentation: PresentationMode },
  provided: FixedDisplayProfile,
  path: string,
  diagnostics?: ContractDiagnostic[],
): {
  logical: Viewport;
  physical: Viewport;
  presentation: PresentationMode;
  rasterDensity: number;
} | null {
  const { logical, presentation } = requested;
  let ok = true;
  if (!provided.logicalViewports.some((supported) => sameViewport(supported, logical))) {
    diagnostics?.push({
      code: "surface.logicalUnsupported",
      path: `${path}/logical`,
      message: `target does not support auxiliary logical viewport ${logical[0]}x${logical[1]}`,
    });
    ok = false;
  }
  if (!provided.presentations.includes(presentation)) {
    diagnostics?.push({
      code: "surface.presentationUnsupported",
      path: `${path}/presentation`,
      message: `target does not support ${JSON.stringify(presentation)} auxiliary presentation`,
    });
    ok = false;
  }
  let physical: Viewport = [provided.physicalViewport[0], provided.physicalViewport[1]];
  if (presentation === "native") {
    const fill = nativeFill(logical, provided.rasterDensity, provided.physicalViewport);
    if (fill === null) {
      diagnostics?.push({
        code: "surface.nativeMismatch",
        path,
        message: "native auxiliary presentation requires the logical viewport to fill the panel",
      });
      ok = false;
    } else {
      physical = fill;
    }
  }
  if (presentation === "integer-fit") {
    const x = provided.physicalViewport[0] / logical[0];
    const y = provided.physicalViewport[1] / logical[1];
    if (!Number.isInteger(x) || x < 1 || x !== y) {
      diagnostics?.push({
        code: "surface.integerFitMismatch",
        path,
        message: "integer-fit auxiliary presentation requires one positive integer scale on both axes",
      });
      ok = false;
    }
  }
  return ok
    ? {
        logical: [logical[0], logical[1]],
        physical,
        presentation,
        rasterDensity: provided.rasterDensity,
      }
    : null;
}

/** An adaptive auxiliary surface takes the first size the target offers
 *  inside its range, presented natively. */
function resolveAdaptiveDisplay(
  requested: { min: Viewport; max: Viewport },
  provided: FixedDisplayProfile,
  path: string,
  diagnostics?: ContractDiagnostic[],
): ReturnType<typeof resolveFixedDisplay> {
  const logical = provided.logicalViewports.find((size) => within(size, requested.min, requested.max));
  if (!logical) {
    diagnostics?.push({
      code: "surface.logicalUnsupported",
      path,
      message:
        `target offers no auxiliary logical viewport from ${requested.min[0]}x${requested.min[1]} ` +
        `through ${requested.max[0]}x${requested.max[1]}`,
    });
    return null;
  }
  return resolveFixedDisplay({ logical, presentation: "native" }, provided, path, diagnostics);
}

/** The app's viewport intent, normalized: the bare `{logical, presentation}`
 *  spelling is shorthand for `{fixed: ...}`. */
function normalizeViewport(viewport: AppViewport): {
  fixed?: FixedViewportSpec;
  dynamic?: { default: Viewport; min?: Viewport; max?: Viewport };
} {
  if ("logical" in viewport) {
    return { fixed: { logical: viewport.logical, presentation: viewport.presentation } };
  }
  return { fixed: viewport.fixed as never, dynamic: viewport.dynamic as never };
}

const within = (v: Viewport, min: Viewport, max: Viewport): boolean =>
  v[0] >= min[0] && v[1] >= min[1] && v[0] <= max[0] && v[1] <= max[1];

/** The sizes a fixed declaration offers a target, in preference order: one
 *  size, the listed sizes, or the target's own sizes inside the range. */
function fixedCandidates(logical: FixedViewportSpec["logical"], targetSizes: readonly Viewport[]): Viewport[] {
  if ("min" in logical) return targetSizes.filter(size => within(size, logical.min, logical.max));
  return isViewport(logical) ? [logical] : [...logical];
}

function isViewport(value: FixedViewportSpec["logical"]): value is Viewport {
  return Array.isArray(value) && typeof value[0] === "number";
}

function describeFixed(logical: FixedViewportSpec["logical"]): string {
  if ("min" in logical) return `${logical.min[0]}x${logical.min[1]} through ${logical.max[0]}x${logical.max[1]}`;
  return (isViewport(logical) ? [logical] : logical).map(size => `${size[0]}x${size[1]}`).join(", ");
}

/**
 * Pick and validate the viewport variant the target's FORM calls for.
 * Window/widget forms take the app's `dynamic` variant (or its `fixed` one
 * size-locked, when the target opts in via acceptsFixed); every other form
 * requires `fixed`. Returns the resolved plan viewport, or null after
 * pushing diagnostics.
 */
function resolveViewport(
  declared: AppViewport,
  viewportPath: string,
  profile: TargetProfile,
  diagnostics: ContractDiagnostic[],
): {
  logical: Viewport;
  presentation: PresentationMode;
  physical: Viewport;
  policy: "fixed" | "dynamic";
} | null {
  const viewport = normalizeViewport(declared);
  const { physicalViewport, logicalViewports, dynamicViewport, presentations, rasterDensity } =
    profile.display;
  const dynamicTarget = DYNAMIC_FORMS.includes(profile.form);

  if (dynamicTarget) {
    // Registry validation already records the actionable diagnostic. Do not
    // dereference malformed framework-owned data and turn it into a runtime
    // TypeError before the caller can receive that diagnostic.
    if (!dynamicViewport) return null;
    const range = dynamicViewport;
    if (viewport.dynamic) {
      const size = viewport.dynamic.default;
      if (!within(size, range.min, range.max)) {
        diagnostics.push({
          code: "viewport.logicalUnsupported",
          path: `${viewportPath}/dynamic/default`,
          message: `target admits ${range.min[0]}x${range.min[1]} through ${range.max[0]}x${range.max[1]}, not ${size[0]}x${size[1]}`,
        });
        return null;
      }
      return {
        logical: size,
        presentation: "native",
        physical: [size[0] * rasterDensity, size[1] * rasterDensity],
        policy: "dynamic",
      };
    }
    if (viewport.fixed) {
      if (!range.acceptsFixed) {
        diagnostics.push({
          code: "viewport.fixedUnhosted",
          path: viewportPath,
          message: `${profile.form}-form target does not host fixed-viewport apps — declare a dynamic viewport variant`,
        });
        return null;
      }
      const declaredFixed = viewport.fixed.logical;
      const size = fixedCandidates(declaredFixed, logicalViewports).find(candidate => within(candidate, range.min, range.max));
      if (!size) {
        diagnostics.push({
          code: "viewport.logicalUnsupported",
          path: `${viewportPath}/fixed/logical`,
          message: `target admits ${range.min[0]}x${range.min[1]} through ${range.max[0]}x${range.max[1]}, not ${describeFixed(declaredFixed)}`,
        });
        return null;
      }
      // Size-locked window: presented 1 logical px = density physical px.
      return {
        logical: size,
        presentation: "native",
        physical: [size[0] * rasterDensity, size[1] * rasterDensity],
        policy: "fixed",
      };
    }
    diagnostics.push({
      code: "viewport.dynamicRequired",
      path: viewportPath,
      message: "target has a dynamic window — declare a dynamic viewport variant",
    });
    return null;
  }

  if (!viewport.fixed) {
    diagnostics.push({
      code: "viewport.fixedRequired",
      path: viewportPath,
      message: "target has a fixed screen — declare a fixed viewport variant",
    });
    return null;
  }
  const { presentation } = viewport.fixed;
  const declaredFixed = viewport.fixed.logical;
  const fixedPath = "logical" in declared ? viewportPath : `${viewportPath}/fixed`;
  let ok = true;
  const candidates = fixedCandidates(declaredFixed, logicalViewports);
  let logical = candidates.find(candidate => logicalViewports.some(supported => sameViewport(supported, candidate)));
  if (!logical) {
    diagnostics.push({
      code: "viewport.logicalUnsupported",
      path: `${fixedPath}/logical`,
      message: isViewport(declaredFixed)
        ? `target does not support logical viewport ${declaredFixed[0]}x${declaredFixed[1]}`
        : `target supports none of the logical viewports ${describeFixed(declaredFixed)}`,
    });
    ok = false;
    // The remaining checks report against the first declared size.
    logical = candidates[0];
    if (!logical) return null;
  }
  if (!presentations.includes(presentation)) {
    diagnostics.push({
      code: "viewport.presentationUnsupported",
      path: `${fixedPath}/presentation`,
      message: `target does not support ${JSON.stringify(presentation)} presentation`,
    });
    ok = false;
  }
  // Native presentation: one logical px maps to rasterDensity physical px,
  // in either orientation of the panel (nativeFill).
  let physical: Viewport = [physicalViewport[0], physicalViewport[1]];
  if (presentation === "native") {
    const fill = nativeFill(logical, rasterDensity, physicalViewport);
    if (fill === null) {
      diagnostics.push({
        code: "viewport.nativeMismatch",
        path: fixedPath,
        message: "native presentation requires the logical viewport to fill the panel",
      });
      ok = false;
    } else {
      physical = fill;
    }
  }
  if (presentation === "integer-fit") {
    const x = physicalViewport[0] / logical[0];
    const y = physicalViewport[1] / logical[1];
    if (!Number.isInteger(x) || x < 1 || x !== y) {
      diagnostics.push({
        code: "viewport.integerFitMismatch",
        path: fixedPath,
        message: "integer-fit requires one positive integer scale on both axes",
      });
      ok = false;
    }
  }
  return ok
    ? {
        logical,
        presentation,
        physical,
        policy: "fixed",
      }
    : null;
}

/** Validate framework-owned registry data before trusting it in resolution.
 *  A target's capability or role capability outside the registry is one the
 *  host defines; it is not a diagnostic. */
export function validatePlatformContractRegistry(
  registry: PlatformContractRegistry,
): readonly ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = [];
  const known = new Set<string>();
  registry.capabilities.forEach((capability, index) => {
    if (known.has(capability)) {
      diagnostics.push({
        code: "registry.duplicateCapability",
        path: `/capabilities/${index}`,
        message: `capability ${JSON.stringify(capability)} is registered more than once`,
      });
    }
    known.add(capability);
  });

  for (const [targetId, target] of Object.entries(registry.targets)) {
    if (target.hostAbi !== POCKET_BINDING_GENERATION) {
      diagnostics.push({ code: "registry.bindingGeneration", path: `/targets/${targetId}/hostAbi`,
        message: `target must use binding generation ${POCKET_BINDING_GENERATION}` });
    }
    if (!target.cadences.length || target.cadences.some(cadence => !Number.isInteger(cadence) || cadence < 1 || cadence > 240)) {
      diagnostics.push({ code: "registry.invalidCadences", path: `/targets/${targetId}/cadences`,
        message: "target cadences must be integers from 1 through 240" });
    }
    if (
      !Number.isInteger(target.display.rasterDensity) ||
      target.display.rasterDensity < 1 ||
      target.display.rasterDensity > 255
    ) {
      diagnostics.push({
        code: "registry.invalidRasterDensity",
        path: `/targets/${targetId}/display/rasterDensity`,
        message: "target rasterDensity must be an integer from 1 through 255",
      });
    }
    const targetCapabilities = new Set<string>(target.capabilities);
    const auxiliary = target.display.auxiliary;
    if (targetCapabilities.has(AUXILIARY_DISPLAY) !== Boolean(auxiliary)) {
      diagnostics.push({
        code: "registry.auxiliaryDisplayMismatch",
        path: `/targets/${targetId}/display/auxiliary`,
        message: "display.auxiliary capability and display.auxiliary facts must be declared together",
      });
    }
    if (auxiliary && auxiliary.rasterDensity !== target.display.rasterDensity) {
      diagnostics.push({
        code: "registry.auxiliaryRasterDensityMismatch",
        path: `/targets/${targetId}/display/auxiliary/rasterDensity`,
        message: "auxiliary rasterDensity must match the primary display",
      });
    }
    if (
      targetCapabilities.has(AUXILIARY_TOUCH) &&
      !targetCapabilities.has(AUXILIARY_DISPLAY)
    ) {
      diagnostics.push({
        code: "registry.auxiliaryTouchWithoutDisplay",
        path: `/targets/${targetId}/capabilities`,
        message: "input.touch.auxiliary requires display.auxiliary",
      });
    }
    if (!TARGET_FORMS.includes(target.form)) {
      diagnostics.push({
        code: "registry.invalidForm",
        path: `/targets/${targetId}/form`,
        message: `target form must be one of ${TARGET_FORMS.join(", ")}`,
      });
    }
    const dynamicForm = DYNAMIC_FORMS.includes(target.form);
    if (dynamicForm && !target.display.dynamicViewport) {
      diagnostics.push({
        code: "registry.dynamicViewportMissing",
        path: `/targets/${targetId}/display`,
        message: `${target.form}-form targets must declare display.dynamicViewport`,
      });
    }
    if (!dynamicForm && target.display.dynamicViewport) {
      diagnostics.push({
        code: "registry.dynamicViewportForbidden",
        path: `/targets/${targetId}/display/dynamicViewport`,
        message: `${target.form}-form targets have a fixed screen — remove dynamicViewport`,
      });
    }
    const provided = new Set<string>();
    target.capabilities.forEach((capability, index) => {
      const path = `/targets/${targetId}/capabilities/${index}`;
      if (provided.has(capability)) {
        diagnostics.push({
          code: "registry.duplicateCapability",
          path,
          message: `target provides capability ${JSON.stringify(capability)} more than once`,
        });
      }
      provided.add(capability);
    });
  }
  return diagnostics;
}


/** A path relative to `from`, rebased onto `to`, with `/` separators; null
 *  when it leaves `to`. */
function rebase(path: string, from: string, to: string): string | null {
  const rebased = relative(to, resolve(from, path));
  if (!rebased || isAbsolute(rebased) || rebased === ".." || rebased.startsWith(`..${sep}`)) return null;
  return rebased.split(sep).join("/");
}

/** Validate an `app` section and resolve it for one host. */
export function resolveAppPlan(
  input: AppConfig | unknown,
  request: ResolveAppRequest,
  registry: PlatformContractRegistry = POCKET_PLATFORM_CONTRACTS,
): ResolutionResult {
  const diagnostics: ContractDiagnostic[] = [...validatePlatformContractRegistry(registry)];
  const shape = validateAppConfig(input);
  if (shape.length > 0) return { ok: false, diagnostics: [...diagnostics, ...shape] };
  // The section came from a module; the plan holds its JSON form.
  const app = JSON.parse(JSON.stringify(input)) as AppConfig;
  if (request.hostExtension !== undefined && !isHostExtension(request.hostExtension)) {
    diagnostics.push({ code: "hostExtension.invalid", path: "/hostExtension",
      message: "host extension must carry a versioned, content-verified JSON payload" });
  }
  const profile = registry.targets[request.target];
  if (!profile) {
    diagnostics.push({
      code: "target.unknown",
      path: "/target",
      message: `unknown target ${JSON.stringify(request.target)}; available: ${Object.keys(registry.targets).sort().join(", ")}`,
    });
    return { ok: false, diagnostics };
  }

  const executionClass = request.executionClass ?? "guest";
  if (executionClass === "aot" && app.aot !== true) {
    diagnostics.push({ code: "execution.aotDisabled", path: "/app/aot", message: "AOT compilation requires app.aot to be true" });
  }

  // Entries are relative to the config file; the plan's are relative to the
  // project root the compiler runs in.
  const configDirectory = request.configDirectory ?? request.projectRoot;
  const projectRoot = request.projectRoot ?? request.configDirectory;
  const planPath = (path: string, at: string): string => {
    if (configDirectory === undefined || projectRoot === undefined) return path;
    const rebased = rebase(path, configDirectory, projectRoot);
    if (rebased === null) {
      diagnostics.push({ code: "app.entryOutsideProject", path: at, message: `${path} lies outside the project root ${projectRoot}` });
      return path;
    }
    return rebased;
  };
  const entry = planPath(app.entry, "/app/entry");
  const modality = deriveModality(profile);
  const presentation = { id: "default", entry };
  const resolvedViewport = resolveViewport(app.viewport, "/app/viewport", profile, diagnostics);

  // A feature the host provides is on; one it lacks is off. Both are
  // compile-time facts the bundle reads (`__POCKET_FEATURES__`). An id is
  // known when the registry or this host defines it: a host defines the ids
  // it lists that the registry does not know.
  const provided = new Set<string>(profile.capabilities);
  const known = new Set<string>([...registry.capabilities, ...provided]);
  const features = new Set(app.features ?? []);
  const featureAvailability = new Map<string, boolean>();
  (app.features ?? []).forEach((capability, index) => {
    if (!known.has(capability)) {
      diagnostics.push({
        code: "capability.unknown",
        path: `/app/features/${index}`,
        message: `unknown capability ${JSON.stringify(capability)}: neither the registry nor host ${request.target} defines it`,
      });
      return;
    }
    featureAvailability.set(capability, provided.has(capability));
  });

  // A worker runs only where the host provides the second runtime and each
  // node kind's capability; the application does not list them again.
  const worker = app.worker && { ...app.worker, entry: planPath(app.worker.entry, "/app/worker/entry") };
  for (const capability of worker ? workerCapabilities(worker) : []) {
    if (!provided.has(capability)) {
      diagnostics.push({
        code: "capability.unavailable",
        path: "/app/worker",
        message: `target ${request.target} does not provide ${capability}, which the worker declaration requires`,
      });
      continue;
    }
    featureAvailability.set(capability, true);
  }

  for (const streamed of ["text.glyphs.streamed", "text.layout.offload"]) {
    if (features.has(streamed) && !features.has("io.offload")) {
      diagnostics.push({ code: "capability.offloadDependency", path: "/app/features", message: `${streamed} requires the io.offload feature` });
    }
  }
  if (Boolean(app.surfaces?.auxiliary) !== features.has(AUXILIARY_DISPLAY)) {
    diagnostics.push({
      code: "surface.auxiliaryDeclarationMismatch",
      path: "/app/surfaces",
      message: "surfaces.auxiliary and the display.auxiliary feature must be declared together",
    });
  }
  if (features.has(AUXILIARY_TOUCH) && !features.has(AUXILIARY_DISPLAY)) {
    diagnostics.push({
      code: "capability.dependency",
      path: `/app/features/${app.features!.indexOf(AUXILIARY_TOUCH)}`,
      message: "input.touch.auxiliary requires the display.auxiliary feature",
    });
  }
  if (app.surfaces && !app.surfaces.auxiliary.fixed === !app.surfaces.auxiliary.adaptive) {
    diagnostics.push({
      code: "surface.auxiliaryPolicy",
      path: "/app/surfaces/auxiliary",
      message: "surfaces.auxiliary declares exactly one of fixed and adaptive",
    });
  }
  // An auxiliary surface the host cannot present turns the feature off.
  let resolvedAuxiliary:
    | NonNullable<ResolvedBuildPlanContent["surfaces"]>["auxiliary"]
    | undefined;
  if (featureAvailability.get(AUXILIARY_DISPLAY) === true && app.surfaces?.auxiliary && profile.display.auxiliary) {
    const { fixed, adaptive } = app.surfaces.auxiliary;
    resolvedAuxiliary = (adaptive
      ? resolveAdaptiveDisplay(adaptive, profile.display.auxiliary, "/app/surfaces/auxiliary/adaptive")
      : resolveFixedDisplay(fixed!, profile.display.auxiliary, "/app/surfaces/auxiliary/fixed")) ?? undefined;
    if (!resolvedAuxiliary) {
      featureAvailability.set(AUXILIARY_DISPLAY, false);
      featureAvailability.set(AUXILIARY_TOUCH, false);
    }
  }

  // A derived output must satisfy the same artifact-name rule an explicit
  // one is validated against: an entry like "app/Main.tsx" would otherwise
  // reach a backend with an invalid name.
  const output = appOutput(app);
  if (!new RegExp(APP_OUTPUT_PATTERN).test(output)) {
    diagnostics.push({
      code: "app.outputUnderivable",
      path: "/app/entry",
      message: `derived output ${JSON.stringify(output)} is not a valid artifact name — set app.output`,
    });
  }

  if (features.has("runtime.worker") && !worker) diagnostics.push({ code: "worker.entry", path: "/app/worker", message: "runtime.worker requires a worker entry" });
  if (worker) {
    if (app.aot) diagnostics.push({ code: "worker.execution", path: "/app/worker", message: "Worker entries require the guest execution class" });
    for (const field of ["nodes", "channels"] as const) {
      const names = new Set<string>();
      for (const [index, value] of (worker[field] ?? []).entries()) {
        if (names.has(value.name)) diagnostics.push({ code: "worker.duplicate", path: `/app/worker/${field}/${index}/name`, message: `Duplicate worker ${field} name: ${value.name}` });
        names.add(value.name);
      }
    }
    // Counts are host facts: the profile's worker table bounds each node
    // kind, and the worker protocol bounds resources and channels.
    const table = profile.source?.worker?.nodes;
    const counts = new Map<WorkerResourceKind, number>();
    for (const node of worker.nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    for (const [kind, count] of table ? counts : []) {
      const limit = table![kind] ?? 0;
      if (count > limit) {
        diagnostics.push({ code: "worker.nodeLimit", path: "/app/worker/nodes", message: `target ${request.target} hosts at most ${limit} ${kind} worker node${limit === 1 ? "" : "s"}; the application declares ${count}` });
      }
    }
    if (worker.nodes.length > WORKER_LIMITS.resources) {
      diagnostics.push({ code: "worker.nodeLimit", path: "/app/worker/nodes", message: `a worker owns at most ${WORKER_LIMITS.resources} nodes; the application declares ${worker.nodes.length}` });
    }
    if ((worker.channels ?? []).length > WORKER_LIMITS.channels) {
      diagnostics.push({ code: "worker.channelLimit", path: "/app/worker/channels", message: `a worker has at most ${WORKER_LIMITS.channels} channels; the application declares ${worker.channels!.length}` });
    }
    // A channel's sizes are host facts too: a stated size fits the host's
    // channel, and "host" takes it (resolveWorkerChannels below).
    const channelTable = profileChannels(profile.source ?? {});
    for (const [index, channel] of (worker.channels ?? []).entries()) {
      for (const field of ["recordBytes", "capacity"] as const) {
        const size = channel[field];
        if (size !== "host" && size > channelTable[field]) {
          diagnostics.push({ code: "worker.channelSize", path: `/app/worker/channels/${index}/${field}`, message: `target ${request.target} holds channels of at most ${channelTable[field]} ${field === "recordBytes" ? "bytes a record" : "records"}; channel ${channel.name} declares ${size}` });
        }
      }
    }
  }

  // The package rate is the application's; the target must present it at a
  // cadence the rate is a whole multiple of.
  const tickHz = app.tickHz ?? DEFAULT_TICK_HZ;
  if (cadenceFor(tickHz, profile.cadences) === null) {
    diagnostics.push({
      code: "app.tickHz",
      path: "/app/tickHz",
      message: `app.tickHz ${tickHz} is not a whole multiple of a ${request.target} cadence (${profile.cadences.join(", ")} Hz)`,
    });
  }

  if (diagnostics.length > 0 || !resolvedViewport) return { ok: false, diagnostics };

  const logical: Viewport = [resolvedViewport.logical[0], resolvedViewport.logical[1]];
  const physical: Viewport = [resolvedViewport.physical[0], resolvedViewport.physical[1]];
  // Plain codepoint sort — the same ordering canonicalJson uses for the plan
  // hash, so the pretty plan.json never depends on ICU collation.
  const featureTable = Object.fromEntries(
    [...featureAvailability.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  const identity = appIdentity(app, output);
  const theme: AnimationTheme | undefined = app.theme;

  // The plan records the profile with the rate the package is compiled at.
  const document = profileDocument(request.target, profile);
  const content: ResolvedBuildPlanContent = {
    profile: { ...compiledProfile(document), tickHz },
    profileHash: hashPocketProfile(document),
    app: {
      id: identity.id,
      title: identity.title,
      version: identity.version,
      entry,
      output,
      framework: app.framework,
      ...(theme !== undefined ? { theme } : {}),
      ...(app.aot !== undefined ? { aot: app.aot } : {}),
      ...(app.model !== undefined ? { model: app.model } : {}),
      ...(app.recursionLimit !== undefined ? { recursionLimit: app.recursionLimit } : {}),
    },
    ...(worker ? { domains: { worker: resolveWorkerChannels(worker, profileChannels(profile.source ?? {})) } } : {}),
    presentation,
    target: {
      id: request.target,
      hostAbi: profile.hostAbi,
    },
    viewport: {
      logical,
      physical,
      presentation: resolvedViewport.presentation,
      rasterDensity: profile.display.rasterDensity,
      policy: resolvedViewport.policy,
    },
    ...(resolvedAuxiliary ? { surfaces: { auxiliary: resolvedAuxiliary } } : {}),
    modality,
    animation: profile.display.animation,
    features: featureTable,
    companions: app.companions ?? [],
    ...(request.hostExtension ? { hostExtension: request.hostExtension } : {}),
  };
  return { ok: true, plan: finalizeBuildPlan(content) };
}
