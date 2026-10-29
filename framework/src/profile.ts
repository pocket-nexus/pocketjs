import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  canonicalJsonText, canonicalProfileJson, pocketProfileSchema, POCKET_PROFILE_FORMAT,
  type PocketProfile, type ProfileHashProjection,
} from "../../contracts/spec/profile.ts";
import { DYNAMIC_FORMS, type Viewport } from "../../contracts/spec/platform-types.ts";
import { WORKER_RESOURCES, type WorkerResourceKind } from "../../contracts/spec/worker.ts";
import { POCKET_BINDING_GENERATION } from "../../contracts/spec/binding-generation.ts";
import { validateSchema, type ContractDiagnostic, type ValidationResult } from "./manifest/schema.ts";
import { BUILTIN_PROFILE_IDS, PROFILE_COMMAND_WORDS } from "../../hosts/ids.ts";

export {
  canonicalProfileJson, profileHashProjection, POCKET_PROFILE_FILE, POCKET_PROFILE_FORMAT, pocketProfileSchema,
  type PocketProfile, type ProfileHashProjection,
} from "../../contracts/spec/profile.ts";

/** Check a pocket-host/2 document: its data shape, then the relations
 * between fields. Capability names the framework does not register are
 * allowed; an application cannot require them. */
export function validatePocketProfile(input: unknown, options: { builtin?: boolean } = {}): ValidationResult<PocketProfile> {
  const diagnostics: ContractDiagnostic[] = [];
  // The canonical serializer rejects cycles, non-JSON values and lone
  // surrogates before the recursive schema validator visits the data.
  try { canonicalJsonText(input); }
  catch (error) {
    return { ok: false, diagnostics: [{ code: "profile.json", path: "", message: String(error) }] };
  }
  validateSchema(input, pocketProfileSchema, "", diagnostics);
  if (diagnostics.length) return { ok: false, diagnostics };
  const profile = input as PocketProfile;
  const problem = (code: string, path: string, message: string) => diagnostics.push({ code: `profile.${code}`, path, message });
  const idLength = new TextEncoder().encode(profile.id).length;
  if (!idLength || idLength > 65535 || profile.id.includes("\0")) problem("id", "/id", "profile id must contain 1..65535 UTF-8 bytes without NUL");
  if (PROFILE_COMMAND_WORDS.includes(profile.id) && !(options.builtin && BUILTIN_PROFILE_IDS.includes(profile.id))) problem("reservedId", "/id", "profile id conflicts with a pocket command");
  if (profile.platform.includes("\0")) problem("platform", "/platform", "platform must not contain NUL");
  if (profile.hostAbi !== undefined && profile.hostAbi !== POCKET_BINDING_GENERATION) {
    problem("bindingGeneration", "/hostAbi", `profile was released for binding generation ${profile.hostAbi}; this framework uses ${POCKET_BINDING_GENERATION}`);
  }
  const capabilities = new Set(profile.capabilities);
  for (const [role, values] of Object.entries(profile.roleCapabilities ?? {})) {
    for (const [index, capability] of values.entries()) {
      if (capabilities.has(capability)) problem("duplicateCapability", `/roleCapabilities/${role}/${index}`, "role capability is already available to applications");
    }
  }
  const { display, panel } = profile;
  const dynamic = display.dynamicViewport;
  const dynamicForm = DYNAMIC_FORMS.includes(profile.form);
  if (dynamicForm !== Boolean(dynamic)) problem("dynamicViewport", "/display/dynamicViewport", "window and widget forms require a dynamic viewport; other forms have fixed viewports");
  if (Boolean(dynamic) !== capabilities.has("display.viewport.live")) problem("liveViewport", "/capabilities", "display.viewport.live and dynamicViewport must be declared together");
  const within = (size: Viewport, min: Viewport, max: Viewport) => size.every((value, axis) => value >= min[axis] && value <= max[axis]);
  if (dynamic) {
    if (!within(dynamic.min, [1, 1], dynamic.max)) problem("viewportRange", "/display/dynamicViewport", "dynamic viewport minimum must not exceed maximum");
    display.logicalViewports.forEach((size, index) => {
      if (!within(size, dynamic.min, dynamic.max)) problem("viewportRange", `/display/logicalViewports/${index}`, "default viewport must lie inside the dynamic range");
    });
    if (!display.presentations.includes("native")) problem("dynamicPresentation", "/display/presentations", "dynamic viewport requires native presentation");
  }
  const auxiliary = display.auxiliary;
  if (Boolean(auxiliary) !== capabilities.has("display.auxiliary")) problem("auxiliaryDisplay", "/display/auxiliary", "display.auxiliary capability and geometry must be declared together");
  if (Boolean(auxiliary) !== Boolean(panel.auxiliary)) problem("auxiliaryPanel", "/panel/auxiliary", "an auxiliary display and its panel must be declared together");
  if (auxiliary && auxiliary.rasterDensity !== display.rasterDensity) problem("auxiliaryDensity", "/display/auxiliary/rasterDensity", "auxiliary and primary raster density must match");
  if (capabilities.has("input.touch.auxiliary") && !auxiliary) problem("auxiliaryTouch", "/capabilities", "input.touch.auxiliary requires an auxiliary display");
  // The input wire encodes 9-bit coordinates with a 10-bit extension.
  const coordinateLimit = 2 ** (profile.input?.coordinateBits ?? 10);
  const checkTouch = (viewports: readonly Viewport[], path: string) => viewports.forEach((size, index) => {
    if (size.some(value => value > coordinateLimit)) problem("touchViewport", `${path}/${index}`, `touch coordinates must fit the ${Math.log2(coordinateLimit)}-bit frame encoding`);
  });
  if (capabilities.has("input.touch")) checkTouch(dynamic ? [...display.logicalViewports, dynamic.max] : display.logicalViewports, "/display/logicalViewports");
  if (auxiliary && capabilities.has("input.touch.auxiliary")) checkTouch(auxiliary.logicalViewports, "/display/auxiliary/logicalViewports");
  for (const [kind, count] of Object.entries(profile.worker?.nodes ?? {}) as [WorkerResourceKind, number][]) {
    if (!count) continue;
    if (!capabilities.has("runtime.worker")) problem("workerCapability", `/worker/nodes/${kind}`, "worker nodes require runtime.worker");
    const capability = WORKER_RESOURCES[kind].capability;
    if (!capabilities.has(capability)) problem("workerCapability", `/worker/nodes/${kind}`, `${kind} nodes require ${capability}`);
  }
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: profile };
}

/** The provenance hash: SHA-256 of the canonical hash projection. */
export function hashPocketProfile(profile: ProfileHashProjection): string {
  return `sha256:${createHash("sha256").update(canonicalProfileJson(profile), "utf8").digest("hex")}`;
}

/** Freeze a document and every nested value. */
function freezeProfile<P extends PocketProfile>(profile: P): P {
  const seen = new Set<object>();
  const freeze = (value: unknown) => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(profile);
  return profile;
}

/** A validated, frozen copy of a parsed document; throws with every
 * diagnostic otherwise. `source` names the document in the message. */
export function parsePocketProfile(value: unknown, options: { builtin?: boolean; source?: string } = {}): PocketProfile {
  const result = validatePocketProfile(value, options);
  if (!result.ok) {
    const where = options.source ? `${options.source}: ` : "";
    throw new TypeError(where + result.diagnostics.map(item => `${item.path || "/"}: ${item.message}`).join("; "));
  }
  return freezeProfile(structuredClone(result.value) as PocketProfile);
}

/** Read and check a pocket-host/2 file. */
export function readPocketProfile(path: string, options: { builtin?: boolean } = {}): PocketProfile {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new TypeError(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  const format = (value as { format?: unknown } | null)?.format;
  if (format !== POCKET_PROFILE_FORMAT) throw new TypeError(`${path}: expected format ${POCKET_PROFILE_FORMAT}, found ${JSON.stringify(format)}`);
  return parsePocketProfile(value, { ...options, source: path });
}

/** @internal The built-in documents shipped with this distribution. */
export function builtinProfile(value: unknown): PocketProfile {
  const profile = parsePocketProfile(value, { builtin: true });
  if (!BUILTIN_PROFILE_IDS.includes(profile.id)) throw new TypeError(`unregistered built-in profile ${profile.id}`);
  return profile;
}
