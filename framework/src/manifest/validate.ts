import { pocketManifestV2Schema, type PocketManifestV2 } from "../../../contracts/spec/pocket-manifest.ts";
import { validateSchema, type ContractDiagnostic, type ValidationResult } from "./schema.ts";
export { validateSchema, type ContractDiagnostic, type ValidationResult } from "./schema.ts";

export function validatePocketManifest(input: unknown): ValidationResult<PocketManifestV2> {
  const diagnostics: ContractDiagnostic[] = [];
  validateSchema(input, pocketManifestV2Schema, "", diagnostics);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: input as PocketManifestV2 };
}
