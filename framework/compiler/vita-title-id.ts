import { createHash } from "node:crypto";

/**
 * Encode Pocket's reverse-DNS application id as a Vita title id.
 *
 * Vita limits title ids to nine alphanumeric characters. The application id
 * stays in the build plan and this one function derives the Vita form, so
 * applications carry no per-target id. The leading P also satisfies
 * cargo-vita's alphabetic-prefix rule; the remaining eight uppercase hex
 * characters are stable for the lifetime of the application id.
 */
export function vitaTitleId(applicationId: string): string {
  const digest = createHash("sha256").update(applicationId).digest("hex");
  return `P${digest.slice(0, 8).toUpperCase()}`;
}
