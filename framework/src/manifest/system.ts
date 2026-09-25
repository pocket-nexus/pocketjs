import type { HostExtension } from "./host-extension.ts";
import {
  pocketSystemV1Schema,
  type BackgroundExecutionPolicy,
  type PocketSystemPackageV1,
  type PocketSystemV1,
} from "../../../contracts/spec/pocket-system.ts";
import {
  POCKET_PLATFORM_CONTRACTS,
  type PlatformContractRegistry,
} from "../../../contracts/spec/platforms.ts";
import { canonicalJson, type ResolvedBuildPlan } from "./plan.ts";
import { resolveBuildPlan } from "./resolve.ts";
import {
  validatePocketManifest,
  validateSchema,
  type ContractDiagnostic,
  type ValidationResult,
} from "./validate.ts";
import { createHash } from "node:crypto";

const APP_SURFACE_CAPABILITY = "ui.compositor-surfaces";

export interface SystemPackageInput {
  /** Must exactly match an applications.catalog[].manifest value. */
  readonly source: string;
  readonly manifest: unknown;
  readonly hostExtension?: HostExtension;
}

export interface ResolveSystemRequest {
  readonly target: string;
  readonly packages: readonly SystemPackageInput[];
}

export interface ResolvedSystemPackage {
  readonly package: string;
  readonly source: string;
  readonly required: boolean;
  readonly presentation?: PocketSystemPackageV1["presentation"];
  /** Complete per-package plan. Native hosts consume it without projecting
   *  identity, viewport, feature or companion fields into another format. */
  readonly plan: ResolvedBuildPlan;
}

export interface ResolvedSystemPlanContent {
  readonly system: Pick<PocketSystemV1, "id" | "name" | "title" | "version">;
  readonly target: {
    readonly id: string;
    readonly hostAbi: number;
  };
  readonly roles: {
    readonly systemUI: string;
  };
  readonly lifecycle: {
    readonly backgroundExecution: BackgroundExecutionPolicy;
  };
  /** Current installed-package ids. Catalog and install policy stay on the
   *  product side of the resolver boundary. */
  readonly installation: PocketSystemV1["installation"];
  /** Required package that renders the System shell. */
  readonly systemUI: ResolvedSystemPackage;
  /** Installed application packages, excluding the System UI. */
  readonly applications: readonly ResolvedSystemPackage[];
}

export interface ResolvedSystemPlan extends ResolvedSystemPlanContent {
  readonly planHash: string;
}

export type SystemResolutionResult =
  | { readonly ok: true; readonly plan: ResolvedSystemPlan }
  | { readonly ok: false; readonly diagnostics: readonly ContractDiagnostic[] };

export function validatePocketSystem(
  input: unknown,
): ValidationResult<PocketSystemV1> {
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(input, pocketSystemV1Schema, "", diagnostics);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: input as PocketSystemV1 };
}

function finalizeSystemPlan(
  content: ResolvedSystemPlanContent,
): ResolvedSystemPlan {
  const digest = createHash("sha256")
    .update(canonicalJson(content))
    .digest("hex");
  return { ...content, planHash: `sha256:${digest}` };
}

function sameViewport(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

/**
 * Resolve a Pocket System into its required System UI plan and the complete
 * plans of currently installed applications. Available catalog packages stay
 * out of the installation snapshot and do not become AppInstances until
 * installed and resolved again.
 */
export function resolveSystemPlan(
  system: PocketSystemV1,
  request: ResolveSystemRequest,
  registry: PlatformContractRegistry = POCKET_PLATFORM_CONTRACTS,
): SystemResolutionResult {
  const diagnostics: ContractDiagnostic[] = [];
  const profile = registry.targets[request.target];
  if (!profile) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "target.unknown",
          path: "/target",
          message: `unknown target ${JSON.stringify(request.target)}`,
        },
      ],
    };
  }

  const bySource = new Map(
    request.packages.map((item) => [item.source, item.manifest]),
  );
  const seenPackages = new Set<string>();
  const seenSources = new Set<string>();
  const outputs = new Map<string, string>();
  const installed = new Set(system.installation.installedPackages);
  const applications: ResolvedSystemPackage[] = [];
  let systemUI: ResolvedSystemPackage | undefined;
  let systemUIEntry: PocketSystemPackageV1 | undefined;
  let systemUIRequiresSurface = false;

  system.applications.catalog.forEach((entry, index) => {
    const path = `/applications/catalog/${index}`;
    if (seenPackages.has(entry.package)) {
      diagnostics.push({
        code: "system.duplicatePackage",
        path: `${path}/package`,
        message: `package ${JSON.stringify(entry.package)} appears more than once`,
      });
    }
    seenPackages.add(entry.package);
    if (seenSources.has(entry.manifest)) {
      diagnostics.push({
        code: "system.duplicateManifest",
        path: `${path}/manifest`,
        message: `manifest ${JSON.stringify(entry.manifest)} appears more than once`,
      });
    }
    seenSources.add(entry.manifest);

    const isSystemUI = entry.package === system.roles.systemUI;
    if (isSystemUI) systemUIEntry = entry;
    if (entry.required && !installed.has(entry.package)) {
      diagnostics.push({
        code: "system.requiredPackageNotInstalled",
        path: "/installation/installedPackages",
        message: `required package ${entry.package} is absent from the installation snapshot`,
      });
    }
    if (!installed.has(entry.package)) return;

    const input = bySource.get(entry.manifest);
    if (input === undefined) {
      diagnostics.push({
        code: "system.manifestMissing",
        path: `${path}/manifest`,
        message: `no package manifest input was supplied for ${JSON.stringify(entry.manifest)}`,
      });
      return;
    }
    const manifestValidation = validatePocketManifest(input);
    if (!manifestValidation.ok) {
      for (const diagnostic of manifestValidation.diagnostics) {
        diagnostics.push({
          ...diagnostic,
          path: `${path}/resolved${diagnostic.path}`,
        });
      }
      return;
    }
    const manifest = manifestValidation.value;
    if (manifest.id !== entry.package) {
      diagnostics.push({
        code: "system.packageMismatch",
        path: `${path}/package`,
        message: `entry names ${entry.package}, manifest declares ${manifest.id}`,
      });
      return;
    }

    const output =
      manifest.app.output ??
      manifest.app.entry
        .split("/")
        .pop()!
        .replace(/\.tsx?$/, "");
    const previousOutput = outputs.get(output);
    if (previousOutput !== undefined && previousOutput !== entry.package) {
      diagnostics.push({
        code: "system.duplicateOutput",
        path: `${path}/resolved/app/output`,
        message:
          `artifact output ${JSON.stringify(output)} is already owned by ` +
          `${previousOutput}`,
      });
    } else {
      outputs.set(output, entry.package);
    }

    if (isSystemUI) {
      systemUIRequiresSurface = manifest.engine.capabilities.requires.includes(
        APP_SURFACE_CAPABILITY,
      );
    } else if ((manifest.app.companions?.length ?? 0) > 0) {
      diagnostics.push({
        code: "system.childCompanionUnsupported",
        path: `${path}/resolved/app/companions`,
        message:
          `application ${entry.package} declares companions, but this System target ` +
          "has no per-AppInstance companion adapter",
      });
    }

    const packageResolution = resolveBuildPlan(
      manifest,
      {
        target: request.target,
        role: isSystemUI ? "systemUI" : "application",
        hostExtension: request.packages.find(item => item.source === entry.manifest)?.hostExtension,
      },
      registry,
    );
    if (!packageResolution.ok) {
      for (const diagnostic of packageResolution.diagnostics) {
        diagnostics.push({
          ...diagnostic,
          path: `${path}/resolved${diagnostic.path}`,
        });
      }
      return;
    }
    if (
      entry.presentation &&
      !sameViewport(
        entry.presentation.viewport,
        packageResolution.plan.viewport.logical,
      )
    ) {
      diagnostics.push({
        code: "system.presentationViewportMismatch",
        path: `${path}/presentation/viewport`,
        message:
          `System requests ${entry.presentation.viewport[0]}x${entry.presentation.viewport[1]}, ` +
          `package plan resolves ${packageResolution.plan.viewport.logical[0]}x${packageResolution.plan.viewport.logical[1]}`,
      });
    }
    const resolved: ResolvedSystemPackage = {
      package: entry.package,
      source: entry.manifest,
      required: entry.required,
      ...(entry.presentation ? { presentation: entry.presentation } : {}),
      plan: packageResolution.plan,
    };
    if (isSystemUI) systemUI = resolved;
    else applications.push(resolved);
  });

  if (!systemUIEntry) {
    diagnostics.push({
      code: "system.systemUIMissing",
      path: "/roles/systemUI",
      message: "roles.systemUI must name one applications.catalog entry",
    });
  } else if (!systemUIEntry.required) {
    diagnostics.push({
      code: "system.systemUIRemovable",
      path: "/roles/systemUI",
      message: "the System UI package must be required by install policy",
    });
  }
  for (const packageId of installed) {
    if (!seenPackages.has(packageId)) {
      diagnostics.push({
        code: "system.installedPackageUnknown",
        path: "/installation/installedPackages",
        message: `installed package ${packageId} is absent from the application catalog`,
      });
    }
  }
  if (
    systemUIEntry &&
    installed.has(systemUIEntry.package) &&
    !systemUIRequiresSurface
  ) {
    diagnostics.push({
      code: "system.systemUICapabilityMissing",
      path: "/roles/systemUI",
      message: `the System UI package must require ${APP_SURFACE_CAPABILITY}`,
    });
  }
  if (diagnostics.length > 0 || !systemUI) return { ok: false, diagnostics };

  return {
    ok: true,
    plan: finalizeSystemPlan({
      system: {
        id: system.id,
        name: system.name,
        title: system.title,
        version: system.version,
      },
      target: { id: request.target, hostAbi: profile.hostAbi },
      roles: { systemUI: system.roles.systemUI },
      lifecycle: {
        backgroundExecution: system.applications.backgroundExecution,
      },
      installation: {
        installedPackages: system.installation.installedPackages,
      },
      systemUI,
      applications,
    }),
  };
}

export function validateAndResolveSystemPlan(
  input: unknown,
  request: ResolveSystemRequest,
  registry: PlatformContractRegistry = POCKET_PLATFORM_CONTRACTS,
): SystemResolutionResult {
  const validated = validatePocketSystem(input);
  if (!validated.ok) return validated;
  return resolveSystemPlan(validated.value, request, registry);
}
