/** Existing compiler pins, grouped here without changing their target assignments.
 * The single-nightly migration requires cross-target validation before these
 * assignments can be merged. Directory rust-toolchain.toml entrypoints are
 * checked against these values by the toolchain definitions test.
 */
export const RUST_TOOLCHAINS = {
  psp: "nightly-2026-05-28",
  vita: "nightly-2026-05-28",
  threeDs: "nightly-2026-07-02",
  uiCabi: "nightly-2026-07-02",
  gba: "nightly-2026-07-01",
  ipodNano: "nightly-2026-07-01",
  idfDataSmoke: "nightly-2026-05-01",
} as const;
