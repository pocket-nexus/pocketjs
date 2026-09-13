import { isHostExtension, type HostExtension } from "./host-extension.ts";
import { DYNAMIC_FORMS, PACKAGE_ROLES, TARGET_FORMS } from "../../../contracts/spec/platforms.ts";
import type { PocketManifestV2 } from "../../../contracts/spec/pocket-manifest.ts";
import {
  POCKET_PLATFORM_CONTRACTS,
  type FixedDisplayProfile,
  type PlatformContractRegistry,
  type PresentationMode,
  type TargetProfile,
  type Viewport,
} from "../../../contracts/spec/platforms.ts";
import {
  finalizeBuildPlan,
  type ResolvedBuildPlan,
  type ResolvedBuildPlanContent,
} from "./plan.ts";
import { validatePocketManifest, type ContractDiagnostic } from "./validate.ts";

const AUXILIARY_DISPLAY = "display.auxiliary";
const AUXILIARY_TOUCH = "input.touch.auxiliary";

export interface ResolveBuildRequest {
  readonly target: string;
  /** Defaults to an ordinary application. System resolution assigns the
   *  System UI role before capability admission. */
  readonly role?: "application" | "systemUI";
  /** Versioned adapter input, interpreted only by its owner. */
  readonly hostExtension?: HostExtension;
}

export type ResolutionResult =
  | { readonly ok: true; readonly plan: ResolvedBuildPlan }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

function capabilityPath(kind: "enhances" | "requires", index: number): string {
  return `/engine/capabilities/${kind}/${index}`;
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

/** The app's viewport intent, normalized: the bare `{logical, presentation}`
 *  spelling is shorthand for `{fixed: ...}`. */
function normalizeViewport(viewport: PocketManifestV2["app"]["viewport"]): {
  fixed?: { logical: Viewport; presentation: PresentationMode };
  dynamic?: { default: Viewport; min?: Viewport; max?: Viewport };
} {
  if ("logical" in viewport) {
    return { fixed: { logical: viewport.logical, presentation: viewport.presentation } };
  }
  return { fixed: viewport.fixed as never, dynamic: viewport.dynamic as never };
}

const within = (v: Viewport, min: Viewport, max: Viewport): boolean =>
  v[0] >= min[0] && v[1] >= min[1] && v[0] <= max[0] && v[1] <= max[1];

/**
 * Pick and validate the viewport variant the target's FORM calls for.
 * Window/widget forms take the app's `dynamic` variant (or its `fixed` one
 * size-locked, when the target opts in via acceptsFixed); every other form
 * requires `fixed`. Returns the resolved plan viewport, or null after
 * pushing diagnostics.
 */
function resolveViewport(
  manifest: PocketManifestV2,
  profile: TargetProfile,
  diagnostics: ContractDiagnostic[],
): {
  logical: Viewport;
  presentation: PresentationMode;
  physical: Viewport;
  policy: "fixed" | "dynamic";
} | null {
  const viewport = normalizeViewport(manifest.app.viewport);
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
          path: "/app/viewport/dynamic/default",
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
          path: "/app/viewport",
          message: `${profile.form}-form target does not host fixed-viewport apps — declare a dynamic viewport variant`,
        });
        return null;
      }
      const size = viewport.fixed.logical;
      if (!within(size, range.min, range.max)) {
        diagnostics.push({
          code: "viewport.logicalUnsupported",
          path: "/app/viewport/fixed/logical",
          message: `target admits ${range.min[0]}x${range.min[1]} through ${range.max[0]}x${range.max[1]}, not ${size[0]}x${size[1]}`,
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
      path: "/app/viewport",
      message: "target has a dynamic window — declare a dynamic viewport variant",
    });
    return null;
  }

  if (!viewport.fixed) {
    diagnostics.push({
      code: "viewport.fixedRequired",
      path: "/app/viewport",
      message: "target has a fixed screen — declare a fixed viewport variant",
    });
    return null;
  }
  const { logical, presentation } = viewport.fixed;
  const fixedPath = "logical" in manifest.app.viewport ? "/app/viewport" : "/app/viewport/fixed";
  let ok = true;
  if (!logicalViewports.some((supported) => sameViewport(supported, logical))) {
    diagnostics.push({
      code: "viewport.logicalUnsupported",
      path: `${fixedPath}/logical`,
      message: `target does not support logical viewport ${logical[0]}x${logical[1]}`,
    });
    ok = false;
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

/** Validate framework-owned registry data before trusting it in resolution. */
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
      if (!known.has(capability)) {
        diagnostics.push({
          code: "registry.unknownCapability",
          path,
          message: `target provides unregistered capability ${JSON.stringify(capability)}`,
        });
      }
      if (provided.has(capability)) {
        diagnostics.push({
          code: "registry.duplicateCapability",
          path,
          message: `target provides capability ${JSON.stringify(capability)} more than once`,
        });
      }
      provided.add(capability);
    });
    for (const [role, capabilities] of Object.entries(target.roleCapabilities ?? {})) {
      const rolePath = `/targets/${targetId}/roleCapabilities/${role}`;
      if (!PACKAGE_ROLES.includes(role as (typeof PACKAGE_ROLES)[number])) {
        diagnostics.push({
          code: "registry.unknownPackageRole",
          path: rolePath,
          message: `target declares unknown package role ${JSON.stringify(role)}`,
        });
      }
      const roleProvided = new Set(provided);
      capabilities?.forEach((capability, index) => {
        const path = `${rolePath}/${index}`;
        if (!known.has(capability)) {
          diagnostics.push({
            code: "registry.unknownCapability",
            path,
            message: `target provides unregistered capability ${JSON.stringify(capability)}`,
          });
        }
        if (roleProvided.has(capability)) {
          diagnostics.push({
            code: "registry.duplicateCapability",
            path,
            message: `target provides capability ${JSON.stringify(capability)} more than once for ${role}`,
          });
        }
        roleProvided.add(capability);
      });
    }
  }
  return diagnostics;
}

export function resolveBuildPlan(
  manifest: PocketManifestV2,
  request: ResolveBuildRequest,
  registry: PlatformContractRegistry = POCKET_PLATFORM_CONTRACTS,
): ResolutionResult {
  const diagnostics: ContractDiagnostic[] = [...validatePlatformContractRegistry(registry)];
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

  // This resolver only produces guest-class plans. AOT-class packages are
  // admitted at compile time by their compiler family (see vapor/BOARDS.md);
  // a manifest that ships no guest artifact has nothing for us to build.
  const executionClasses = manifest.execution?.classes ?? ["guest"];
  if (!executionClasses.includes("guest")) {
    diagnostics.push({
      code: "execution.guestExcluded",
      path: "/execution/classes",
      message: "manifest declares no guest execution class; this resolver only builds guest plans",
    });
  }

  const resolvedViewport = resolveViewport(manifest, profile, diagnostics);

  const known = new Set<string>(registry.capabilities);
  const role = request.role ?? "application";
  const provided = new Set<string>([
    ...profile.capabilities,
    ...(role === "systemUI" ? (profile.roleCapabilities?.systemUI ?? []) : []),
  ]);
  const seen = new Map<string, string>();
  const featureAvailability = new Map<string, boolean>();

  for (const [kind, capabilities] of [
    ["requires", manifest.engine.capabilities.requires],
    ["enhances", manifest.engine.capabilities.enhances ?? []],
  ] as const) {
    capabilities.forEach((capability, index) => {
      const path = capabilityPath(kind, index);
      const previous = seen.get(capability);
      if (previous) {
        diagnostics.push({
          code: "capability.duplicate",
          path,
          message: `capability was already declared at ${previous}`,
        });
        return;
      }
      seen.set(capability, path);

      if (!known.has(capability)) {
        diagnostics.push({
          code: "capability.unknown",
          path,
          message: `unknown capability ${JSON.stringify(capability)}`,
        });
        return;
      }

      const available = provided.has(capability);
      const required = kind === "requires";
      if (required && !available) {
        diagnostics.push({
          code: "capability.unavailable",
          path,
          message: `target ${request.target} does not provide ${capability} to role ${role}`,
        });
        return;
      }
      featureAvailability.set(capability, required || available);
    });
  }

  const requires = new Set(manifest.engine.capabilities.requires);
  const enhances = new Set(manifest.engine.capabilities.enhances ?? []);
  if (requires.has("text.layout.offload") && !requires.has("io.offload") ||
      enhances.has("text.layout.offload") && !requires.has("io.offload") && !enhances.has("io.offload")) {
    diagnostics.push({code:"capability.offloadDependency",path:"/engine/capabilities",message:"text.layout.offload requires a matching io.offload declaration"});
  }
  const auxiliaryDeclared = requires.has(AUXILIARY_DISPLAY) || enhances.has(AUXILIARY_DISPLAY);
  const auxiliaryTouchDeclared = requires.has(AUXILIARY_TOUCH) || enhances.has(AUXILIARY_TOUCH);
  if (Boolean(manifest.app.surfaces?.auxiliary) !== auxiliaryDeclared) {
    diagnostics.push({
      code: "surface.auxiliaryDeclarationMismatch",
      path: "/app/surfaces",
      message: "app.surfaces.auxiliary and the display.auxiliary capability must be declared together",
    });
  }
  if (auxiliaryTouchDeclared && !auxiliaryDeclared) {
    diagnostics.push({
      code: "capability.dependency",
      path: seen.get(AUXILIARY_TOUCH) ?? "/engine/capabilities",
      message: "input.touch.auxiliary requires the application to declare display.auxiliary",
    });
  }
  if (requires.has(AUXILIARY_TOUCH) && !requires.has(AUXILIARY_DISPLAY)) {
    diagnostics.push({
      code: "capability.dependency",
      path: seen.get(AUXILIARY_TOUCH) ?? "/engine/capabilities/requires",
      message: "required input.touch.auxiliary requires display.auxiliary in requires",
    });
  }

  let resolvedAuxiliary:
    | NonNullable<ResolvedBuildPlanContent["surfaces"]>["auxiliary"]
    | undefined;
  if (
    featureAvailability.get(AUXILIARY_DISPLAY) === true &&
    manifest.app.surfaces?.auxiliary &&
    profile.display.auxiliary
  ) {
    resolvedAuxiliary = resolveFixedDisplay(
      manifest.app.surfaces.auxiliary.fixed,
      profile.display.auxiliary,
      "/app/surfaces/auxiliary/fixed",
      requires.has(AUXILIARY_DISPLAY) ? diagnostics : undefined,
    ) ?? undefined;
    if (!resolvedAuxiliary) {
      featureAvailability.set(AUXILIARY_DISPLAY, false);
      featureAvailability.set(AUXILIARY_TOUCH, false);
    }
  }

  // A derived output must satisfy the same artifact-name contract an explicit
  // one is validated against — an entry like "app/Main.tsx" or "app/.tsx"
  // would otherwise smuggle an invalid name past the schema and fail much
  // later, inside a backend, blaming a plan the resolver itself produced.
  const OUTPUT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  const output = manifest.app.output ?? manifest.app.entry.split("/").pop()!.replace(/\.tsx?$/, "");
  if (!OUTPUT_NAME.test(output)) {
    diagnostics.push({
      code: "app.outputUnderivable",
      path: manifest.app.output !== undefined ? "/app/output" : "/app/entry",
      message: `derived output ${JSON.stringify(output)} is not a valid artifact name — set app.output explicitly`,
    });
  }

  if (diagnostics.length > 0 || !resolvedViewport) return { ok: false, diagnostics };

  const logical: Viewport = [resolvedViewport.logical[0], resolvedViewport.logical[1]];
  const physical: Viewport = [resolvedViewport.physical[0], resolvedViewport.physical[1]];
  // Plain codepoint sort — the same ordering canonicalJson uses for the plan
  // hash, so the pretty plan.json never depends on ICU collation.
  const features = Object.fromEntries(
    [...featureAvailability.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );

  const content: ResolvedBuildPlanContent = {
    app: {
      id: manifest.id,
      title: manifest.title,
      version: manifest.version,
      entry: manifest.app.entry,
      output,
      framework: manifest.app.framework,
    },
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
    features,
    companions: manifest.app.companions ?? [],
    ...(request.hostExtension ? { hostExtension: request.hostExtension } : {}),
  };
  return { ok: true, plan: finalizeBuildPlan(content) };
}

export function validateAndResolveBuildPlan(
  input: unknown,
  request: ResolveBuildRequest,
  registry: PlatformContractRegistry = POCKET_PLATFORM_CONTRACTS,
): ResolutionResult {
  const validated = validatePocketManifest(input);
  if (!validated.ok) return validated;
  return resolveBuildPlan(validated.value, request, registry);
}
