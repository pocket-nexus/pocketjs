import { createHash } from "node:crypto";

/**
 * Encode Pocket's stable, reverse-DNS application id as a Vita title id.
 *
 * Vita limits title ids to nine alphanumeric characters. Keeping the full
 * application id in pocket.app.json and deriving this target representation in
 * one backend-owned function avoids per-demo tables and target conditionals in
 * applications. The leading P also satisfies cargo-vita's alphabetic-prefix
 * rule; the remaining eight uppercase hex characters are stable for the
 * lifetime of the manifest id.
 */
export function vitaTitleId(applicationId: string): string {
  const digest = createHash("sha256").update(applicationId).digest("hex");
  return `P${digest.slice(0, 8).toUpperCase()}`;
}
