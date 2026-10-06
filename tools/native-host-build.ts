import { createHash } from "node:crypto";
import { mustRunCommand } from "./native-source.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  extractHostBuildInputs,
  type HostBuildInputs,
} from "../framework/src/manifest/host-build-inputs.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";

/**
 * Build steps shared by native host tools that embed a PocketJS guest next to
 * the QuickJS bridge: process helpers, the pinned QuickJS checkout, the guest
 * bundle built from a resolved plan, and the platform package identity derived
 * from that plan. Used by the BlackBerry Classic tools today.
 */

export {
  runCommand, mustRunCommand, quickJsCheckout, quickJsCheckoutStatus,
  ensureQuickJsCheckout,
  type CommandResult, type QuickJsPin, type QuickJsCheckout,
} from "./native-source.ts";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function printCheck(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "[ok]" : "[missing]"} ${label}: ${detail}`);
  return ok;
}

export interface GuestBundle {
  readonly plan: ResolvedBuildPlan;
  readonly inputs: HostBuildInputs;
  readonly javaScript: string;
  readonly pack: string;
}

export interface GuestBundleRequest {
  readonly label: string;
  readonly repository: string;
  /** The private target id the manifest must resolve against. */
  readonly target: string;
  /** Resolves the manifest to the plan for `target` (a profile module's resolver). */
  readonly resolvePlan: (manifest: unknown) => ResolvedBuildPlan;
  readonly manifestPath: string;
  /** Where the resolved plan is written for `tools/build.ts --plan`. */
  readonly planPath: string;
  readonly outputDirectory: string;
}

function locateGuestBundle(
  request: GuestBundleRequest,
  plan: ResolvedBuildPlan,
): GuestBundle {
  const inputs = extractHostBuildInputs(plan, { expectedTarget: request.target });
  return {
    plan,
    inputs,
    javaScript: join(request.outputDirectory, `${inputs.appOutput}.js`),
    pack: join(request.outputDirectory, `${inputs.appOutput}.pak`),
  };
}

export function currentGuestPlan(request: GuestBundleRequest): ResolvedBuildPlan {
  return request.resolvePlan(JSON.parse(readFileSync(request.manifestPath, "utf8")));
}

/** Resolves the manifest for the target and compiles app.js + app.pak. */
export function buildGuestBundle(request: GuestBundleRequest): GuestBundle {
  const plan = currentGuestPlan(request);
  mkdirSync(dirname(request.planPath), { recursive: true });
  rmSync(request.outputDirectory, { recursive: true, force: true });
  mkdirSync(request.outputDirectory, { recursive: true });
  writeFileSync(request.planPath, `${JSON.stringify(plan, null, 2)}\n`);
  mustRunCommand(
    request.label,
    process.execPath,
    [
      join(request.repository, "tools/build.ts"),
      `--plan=${request.planPath}`,
      `--project-root=${request.repository}`,
      `--outdir=${request.outputDirectory}`,
    ],
    request.repository,
  );
  const bundle = locateGuestBundle(request, plan);
  if (!existsSync(bundle.javaScript) || !existsSync(bundle.pack)) {
    throw new Error(`${request.label}: guest build did not emit app.js and app.pak`);
  }
  console.log(`${request.label}: guest bundle -> ${request.outputDirectory}`);
  return bundle;
}

export interface PlanBundleRequest {
  readonly label: string;
  readonly repository: string;
  /** The target id the plan must have been resolved for. */
  readonly target: string;
  /** A resolved plan on disk, as a product repository's own resolver wrote it. */
  readonly planPath: string;
  /** The directory the plan's entry is relative to. */
  readonly projectRoot: string;
  readonly outputDirectory: string;
}

/**
 * Compiles app.js + app.pak from a plan that is already resolved, so a
 * product repository builds its own app with this repository's host. The
 * plan's checksum and target are verified before the compiler runs.
 */
export function buildGuestBundleFromPlan(request: PlanBundleRequest): GuestBundle {
  if (!existsSync(request.planPath)) {
    throw new Error(`${request.label}: no plan at ${request.planPath}`);
  }
  const plan = JSON.parse(readFileSync(request.planPath, "utf8")) as ResolvedBuildPlan;
  const inputs = extractHostBuildInputs(plan, { expectedTarget: request.target });
  rmSync(request.outputDirectory, { recursive: true, force: true });
  mkdirSync(request.outputDirectory, { recursive: true });
  mustRunCommand(
    request.label,
    process.execPath,
    [
      join(request.repository, "tools/build.ts"),
      `--plan=${request.planPath}`,
      `--project-root=${request.projectRoot}`,
      `--outdir=${request.outputDirectory}`,
    ],
    request.projectRoot,
  );
  const bundle: GuestBundle = {
    plan,
    inputs,
    javaScript: join(request.outputDirectory, `${inputs.appOutput}.js`),
    pack: join(request.outputDirectory, `${inputs.appOutput}.pak`),
  };
  if (!existsSync(bundle.javaScript) || !existsSync(bundle.pack)) {
    throw new Error(`${request.label}: guest build did not emit app.js and app.pak`);
  }
  console.log(`${request.label}: guest bundle -> ${request.outputDirectory}`);
  return bundle;
}

/** Reads a previously built bundle and rejects it when the manifest moved on. */
export function readGuestBundle(request: GuestBundleRequest): GuestBundle {
  if (!existsSync(request.planPath)) {
    throw new Error(`${request.label}: resolved plan is absent; run build-demo first`);
  }
  const stored = JSON.parse(readFileSync(request.planPath, "utf8")) as ResolvedBuildPlan;
  if (stored.planHash !== currentGuestPlan(request).planHash) {
    throw new Error(`${request.label}: resolved plan is stale; rerun build-demo`);
  }
  const bundle = locateGuestBundle(request, stored);
  if (!existsSync(bundle.javaScript) || !existsSync(bundle.pack)) {
    throw new Error(
      `${request.label}: guest JavaScript or pack is absent; rerun build-demo`,
    );
  }
  return bundle;
}

/**
 * Platform package identity derived from the plan's manifest identity, so a
 * host never carries a second hand-written copy of the app id or version.
 */
export interface PackageIdentity {
  /** The manifest id with `-` replaced by `_` — a valid Android package name
   *  and BAR id; every other character must already be a legal segment. */
  readonly packageId: string;
  /** The manifest version verbatim (Android versionName, BAR versionNumber). */
  readonly version: string;
  /** `major * 1_000_000 + minor * 1_000 + patch` — a monotonic integer for
   *  Android versionCode and the BAR buildId, derived from the same version. */
  readonly versionCode: number;
  readonly title: string;
}

export function packageIdentity(app: HostBuildInputs["app"]): PackageIdentity {
  const packageId = app.id.replace(/-/g, "_");
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(packageId)) {
    throw new Error(
      `native host build: app id ${app.id} does not map onto a platform package name`,
    );
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(app.version);
  if (!match) {
    throw new Error(`native host build: app version ${app.version} is not major.minor.patch`);
  }
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (minor >= 1000 || patch >= 1000 || major >= 2000) {
    throw new Error(
      `native host build: app version ${app.version} exceeds the numeric version code range`,
    );
  }
  return {
    packageId,
    version: app.version,
    versionCode: major * 1_000_000 + minor * 1_000 + patch,
    title: app.title,
  };
}

/**
 * Fills `@POCKET_NAME@` placeholders in a platform descriptor template and
 * rejects a template whose placeholders are not all known.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  const rendered = template.replace(/@POCKET_([A-Z_]+)@/g, (token, name: string) => {
    if (!(name in values)) throw new Error(`native host build: template has no value for ${token}`);
    return String(values[name]);
  });
  return rendered;
}

/** XML attribute/text escaping for values rendered into descriptors. */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
