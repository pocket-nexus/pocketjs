/** Script binding generation shared by every program and software profile.
 * Values 1..11 were target identifiers and must not be accepted as generations.
 * Change this only when the generated guest/native binding contract changes;
 * profile hashes, package formats, C record prefixes and DrawList versions are
 * independent compatibility checks. */
export const POCKET_BINDING_GENERATION = 12 as const;
