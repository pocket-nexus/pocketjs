/** Compiler used for every explicit Cargo build-std invocation. */
export const BUILD_STD_NIGHTLY = "nightly-2026-07-02";
/** Fixed stable compiler for mechanisms and the desktop default workspace. */
export const STABLE_RUST_TOOLCHAIN = "1.98.1";

/** Program compilers share one pinned identity. */
export const RUST_TOOLCHAINS = {
  psp: BUILD_STD_NIGHTLY,
  vita: BUILD_STD_NIGHTLY,
  threeDs: BUILD_STD_NIGHTLY,
  gba: BUILD_STD_NIGHTLY,
  ipodNano: BUILD_STD_NIGHTLY,
  idfDataSmoke: BUILD_STD_NIGHTLY,
} as const;
