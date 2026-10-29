// Device admission: whether a host provides what a package variant was
// compiled to use. engine/package/src/admission.rs is the device
// implementation; this module applies the same rules for tools that pick a
// variant for a device, and both read engine/package/tests/fixtures/admission.
//
//   bindingGeneration  variant.hostAbi equals the host's binding generation
//   rasterDensity      plan.viewport.rasterDensity equals the host's density
//   animation          plan.animation equals the host's animation class
//   rate               plan.profile.tickHz (1..240) is a whole multiple, at
//                      most 60, of one of the host's cadences
//   viewport           plan.viewport.logical is listed by the host or lies in
//                      its dynamic range
//   presentation       plan.viewport.presentation is listed by the host
//   capability         every `features.<name>: true` is a host capability
//   auxiliary          plan.surfaces.auxiliary.logical is a host auxiliary
//                      size at the host's density; skipped when absent
//
// Names compare as strings; order and extra host entries do not matter. A
// host without an animation class or a presentation list is not compared on
// them. The profile hash, id, platform, form and physical panel size do not
// participate. Variants whose profile hash equals the host's are tried first,
// then the rest in file order; the first admitted variant wins. Otherwise the
// variant with the fewest failed items is reported.
import type { Viewport } from "./platform-types.ts";
import { POCKET_SECTION, type PocketPackage, type PocketPackageVariant } from "./pocket-package.ts";

export const ADMISSION_ITEMS = [
  "bindingGeneration", "plan", "rasterDensity", "animation", "rate", "viewport", "presentation", "capability", "auxiliary",
] as const;
export type AdmissionItem = (typeof ADMISSION_ITEMS)[number];

/** The core's largest tick rate; manifests cap an application at 60. */
export const MAX_TICK_HZ = 240;
/** The most core ticks one presented frame advances. */
export const MAX_CORE_TICKS_PER_FRAME = 60;

export interface AdmissionHost {
  readonly bindingGeneration: number;
  /** Provenance only: `sha256:` hex of the host profile. */
  readonly profileHash: string;
  readonly rasterDensity: number;
  readonly animation?: string;
  readonly cadences: readonly number[];
  readonly logicalViewports: readonly Viewport[];
  readonly dynamicViewport?: { readonly min: Viewport; readonly max: Viewport };
  readonly presentations?: readonly string[];
  readonly capabilities: readonly string[];
  readonly auxiliaryLogical?: readonly Viewport[];
}

export interface AdmissionTiming {
  readonly tickHz: number;
  readonly cadenceHz: number;
}

export type PlanAdmission =
  | { readonly ok: true; readonly timing: AdmissionTiming }
  | { readonly ok: false; readonly items: readonly AdmissionItem[]; readonly capability?: string };

/** The largest host cadence `tickHz` is a whole multiple of, at most 60. */
export function cadenceFor(tickHz: number, cadences: readonly number[]): number | null {
  if (!Number.isInteger(tickHz) || tickHz < 1 || tickHz > MAX_TICK_HZ) return null;
  const admitted = cadences.filter(cadence =>
    Number.isInteger(cadence) && cadence > 0 && tickHz % cadence === 0 && tickHz / cadence <= MAX_CORE_TICKS_PER_FRAME);
  return admitted.length ? Math.max(...admitted) : null;
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const integer = (value: unknown, min: number, max: number): number | undefined =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : undefined;
function surface(value: unknown): { logical: Viewport; rasterDensity: number } | undefined {
  const record = object(value);
  const logical = record?.logical;
  if (!Array.isArray(logical) || logical.length !== 2) return undefined;
  const width = integer(logical[0], 1, 4096), height = integer(logical[1], 1, 4096);
  const rasterDensity = integer(record?.rasterDensity, 1, 255);
  return width && height && rasterDensity ? { logical: [width, height], rasterDensity } : undefined;
}
const within = (size: Viewport, min: Viewport, max: Viewport) =>
  size[0] >= min[0] && size[1] >= min[1] && size[0] <= max[0] && size[1] <= max[1];
const sameSize = (left: Viewport, right: Viewport) => left[0] === right[0] && left[1] === right[1];

/** Check one variant's plan (bytes or parsed JSON) against the host. */
export function admitPlan(host: AdmissionHost, variantHostAbi: number, plan: Uint8Array | unknown): PlanAdmission {
  const items = new Set<AdmissionItem>();
  if (variantHostAbi !== host.bindingGeneration) items.add("bindingGeneration");
  let parsed: unknown = plan;
  if (plan instanceof Uint8Array) {
    try { parsed = plan.length ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plan)) : undefined; }
    catch { parsed = undefined; }
  }
  const record = object(parsed);
  const viewport = surface(record?.viewport);
  const auxiliaryValue = object(record?.surfaces)?.auxiliary;
  const auxiliary = auxiliaryValue === undefined ? undefined : surface(auxiliaryValue);
  if (!record || !viewport || (auxiliaryValue !== undefined && !auxiliary)) {
    return { ok: false, items: ADMISSION_ITEMS.filter(item => items.has(item) || item === "plan") };
  }
  if (viewport.rasterDensity !== host.rasterDensity) items.add("rasterDensity");
  if (host.animation !== undefined && record.animation !== host.animation) items.add("animation");
  const tickHz = object(record.profile)?.tickHz;
  const cadenceHz = typeof tickHz === "number" ? cadenceFor(tickHz, host.cadences) : null;
  if (cadenceHz === null) items.add("rate");
  const dynamic = host.dynamicViewport;
  if (!(dynamic ? within(viewport.logical, dynamic.min, dynamic.max)
    : host.logicalViewports.some(size => sameSize(size, viewport.logical)))) items.add("viewport");
  const presentation = object(record.viewport)?.presentation;
  if (host.presentations !== undefined && !(typeof presentation === "string" && host.presentations.includes(presentation))) {
    items.add("presentation");
  }
  const capabilities = new Set(host.capabilities);
  const missing = Object.entries(object(record.features) ?? {})
    .find(([name, value]) => value === true && !capabilities.has(name))?.[0];
  if (missing !== undefined) items.add("capability");
  if (auxiliary && (auxiliary.rasterDensity !== host.rasterDensity ||
      !(host.auxiliaryLogical ?? []).some(size => sameSize(size, auxiliary.logical)))) items.add("auxiliary");
  if (items.size === 0 && cadenceHz !== null) return { ok: true, timing: { tickHz: tickHz as number, cadenceHz } };
  return { ok: false, items: ADMISSION_ITEMS.filter(item => items.has(item)), ...(missing === undefined ? {} : { capability: missing }) };
}

export type VariantSelection =
  | { readonly ok: true; readonly index: number; readonly variant: PocketPackageVariant; readonly timing: AdmissionTiming }
  | { readonly ok: false; readonly index: number; readonly items: readonly AdmissionItem[]; readonly capability?: string };

/** Select the variant a host admits, or report the closest one. */
export function selectVariant(pkg: PocketPackage, host: AdmissionHost): VariantSelection {
  if (!pkg.variants.length) throw new Error("pocket package: no variants");
  let closest: { index: number; items: readonly AdmissionItem[]; capability?: string } | undefined;
  for (const preferred of [true, false]) {
    for (const [index, variant] of pkg.variants.entries()) {
      if ((variant.profileHash === host.profileHash) !== preferred) continue;
      const plan = variant.sections.find(section => section.kind === POCKET_SECTION.plan)?.bytes ?? new Uint8Array();
      const result = admitPlan(host, variant.hostAbi, plan);
      if (result.ok) return { ok: true, index, variant, timing: result.timing };
      if (!closest || result.items.length < closest.items.length) {
        closest = { index, items: result.items, ...(result.capability === undefined ? {} : { capability: result.capability }) };
      }
    }
  }
  return { ok: false, ...closest! };
}

/** One line naming what the closest variant lacks. */
export function describeRejection(selection: Extract<VariantSelection, { ok: false }>): string {
  return `variant ${selection.index} is not admitted: ` +
    selection.items.map(item => item === "capability" && selection.capability ? `capability ${selection.capability}` : item).join(", ");
}
