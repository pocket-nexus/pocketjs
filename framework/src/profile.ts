import { createHash } from "node:crypto";
import { canonicalProfileJson, pocketProfileSchema, type PocketProfile } from "../../contracts/spec/profile.ts";
import { DYNAMIC_FORMS, POCKET_CAPABILITIES, type Viewport } from "../../contracts/spec/platform-types.ts";
import { validateSchema, type ContractDiagnostic, type ValidationResult } from "./manifest/schema.ts";
import { BUILTIN_PROFILE_IDS, PROFILE_COMMAND_WORDS } from "../../profiles/ids.ts";

export { canonicalProfileJson, profileHashProjection, type PocketProfile } from "../../contracts/spec/profile.ts";

/** Validate the software promises independently of a compiler or build target. */
export function validatePocketProfile(input: unknown, options: { builtin?: boolean } = {}): ValidationResult<PocketProfile> {
  const diagnostics: ContractDiagnostic[] = [];
  // The canonical serializer rejects cycles, non-JSON values and lone
  // surrogates before the recursive schema validator visits the data.
  try { canonicalProfileJson(input as PocketProfile); }
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
  if (!options.builtin && BUILTIN_PROFILE_IDS.includes(profile.id)) problem("reservedId", "/id", "profile id conflicts with a built-in profile; import that profile instead");
  if (profile.platform.includes("\0")) problem("platform", "/platform", "platform must not contain NUL");
  const known = new Set<string>(POCKET_CAPABILITIES);
  const capabilities = new Set(profile.capabilities);
  for (const [index, capability] of profile.capabilities.entries()) {
    if (!known.has(capability)) problem("unknownCapability", `/capabilities/${index}`, `unregistered capability ${JSON.stringify(capability)}`);
  }
  for (const [role, values] of Object.entries(profile.roleCapabilities ?? {})) {
    for (const [index, capability] of values.entries()) {
      if (!known.has(capability)) problem("unknownCapability", `/roleCapabilities/${role}/${index}`, `unregistered capability ${JSON.stringify(capability)}`);
      if (capabilities.has(capability)) problem("duplicateCapability", `/roleCapabilities/${role}/${index}`, "role capability is already available to applications");
    }
  }
  const dynamic = profile.display.dynamicViewport;
  const dynamicForm = DYNAMIC_FORMS.includes(profile.form);
  if (dynamicForm !== Boolean(dynamic)) problem("dynamicViewport", "/display/dynamicViewport", "window and widget forms require a dynamic viewport; other forms have fixed viewports");
  if (Boolean(dynamic) !== capabilities.has("display.viewport.live")) problem("liveViewport", "/capabilities", "display.viewport.live and dynamicViewport must be declared together");
  const within = (size: Viewport, min: Viewport, max: Viewport) => size.every((value, axis) => value >= min[axis] && value <= max[axis]);
  if (dynamic) {
    if (!within(dynamic.min, [1, 1], dynamic.max)) problem("viewportRange", "/display/dynamicViewport", "dynamic viewport minimum must not exceed maximum");
    profile.display.logicalViewports.forEach((size, index) => {
      if (!within(size, dynamic.min, dynamic.max)) problem("viewportRange", `/display/logicalViewports/${index}`, "default viewport must lie inside the dynamic range");
    });
    if (!profile.display.presentations.includes("native")) problem("dynamicPresentation", "/display/presentations", "dynamic viewport requires native presentation");
  }
  const auxiliary = profile.display.auxiliary;
  if (Boolean(auxiliary) !== capabilities.has("display.auxiliary")) problem("auxiliaryDisplay", "/display/auxiliary", "display.auxiliary capability and geometry must be declared together");
  if (auxiliary && auxiliary.rasterDensity !== profile.display.rasterDensity) problem("auxiliaryDensity", "/display/auxiliary/rasterDensity", "auxiliary and primary raster density must match");
  if (capabilities.has("input.touch.auxiliary") && !auxiliary) problem("auxiliaryTouch", "/capabilities", "input.touch.auxiliary requires an auxiliary display");
  // The shared encoder preserves the 9-bit wire and uses its existing 10-bit
  // extension above coordinate 511. No wire generation changes here.
  const checkTouch = (viewports: readonly Viewport[], path: string) => viewports.forEach((size, index) => {
    if (size.some(value => value > 1024)) problem("touchViewport", `${path}/${index}`, "touch coordinates must fit the 10-bit frame encoding");
  });
  if (capabilities.has("input.touch")) checkTouch(dynamic ? [...profile.display.logicalViewports, dynamic.max] : profile.display.logicalViewports, "/display/logicalViewports");
  if (auxiliary && capabilities.has("input.touch.auxiliary")) checkTouch(auxiliary.logicalViewports, "/display/auxiliary/logicalViewports");
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: profile };
}

/** The identity omits metadata and includes all seven software contract fields. */
export function hashPocketProfile(profile: PocketProfile): string {
  return `sha256:${createHash("sha256").update(canonicalProfileJson(profile), "utf8").digest("hex")}`;
}

/** Define a tree-external software profile. Import built-ins from /profiles. */
export function defineProfile<const P extends PocketProfile>(profile: P): P {
  const result = validatePocketProfile(profile);
  if (!result.ok) throw new TypeError(result.diagnostics.map(item => `${item.path || "/"}: ${item.message}`).join("; "));
  return freezeProfile(profile);
}

/** Preserve identity after definition, including nested arrays and metadata. */
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

/** @internal Entry for the built-in modules shipped with this distribution. */
export function defineBuiltinProfile<const P extends PocketProfile>(profile: P): P {
  const result = validatePocketProfile(profile, { builtin: true });
  if (!result.ok) throw new TypeError(result.diagnostics.map(item => `${item.path || "/"}: ${item.message}`).join("; "));
  if (!BUILTIN_PROFILE_IDS.includes(profile.id)) throw new TypeError(`unregistered built-in profile ${profile.id}`);
  return freezeProfile(profile);
}
