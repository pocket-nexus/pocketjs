import { resolve } from "node:path";

/** One cargo target directory for every generated AOT crate and lab check.
 * The generated crates differ only in their leaf package; `microts` and
 * `serde_json` compile once per checkout instead of once per test file.
 * It lives under .pocket-build/cache, the directory the release job caches
 * beside `target`, so a CI run with a warm cache skips those builds too. */
export const AOT_CARGO_TARGET_DIR = resolve(import.meta.dir, "../../.pocket-build/cache/aot-target");

/** Environment for every cargo invocation on a generated AOT crate. Each
 * crate builds once, so incremental compilation only writes state (about
 * 800 MB per suite run) that no later build reads. */
export const AOT_CARGO_ENV = { CARGO_TARGET_DIR: AOT_CARGO_TARGET_DIR, CARGO_INCREMENTAL: "0" } as const;
