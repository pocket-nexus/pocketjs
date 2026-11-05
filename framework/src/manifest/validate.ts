import { loadedManifestSchema, type PocketManifestV2 } from "../../../contracts/spec/pocket-manifest.ts";
import { validateSchema, type ContractDiagnostic, type ValidationResult } from "./schema.ts";
export { validateSchema, type ContractDiagnostic, type ValidationResult } from "./schema.ts";

/** Validate a manifest as written or as `readPocketManifest` loads it: the
 *  loaded form carries `app.theme` content in place of the path. */
export function validatePocketManifest(input: unknown): ValidationResult<PocketManifestV2> {
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(input, loadedManifestSchema, "", diagnostics);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: input as PocketManifestV2 };
}
