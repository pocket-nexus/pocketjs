import { resolve } from "node:path";

/** One cargo target directory for every generated AOT crate and lab check.
 * The generated crates differ only in their leaf package; `microts` and
 * `serde_json` compile once per checkout instead of once per test file. */
export const AOT_CARGO_TARGET_DIR = resolve(import.meta.dir, "../../.pocket-build/validation/aot/target");
