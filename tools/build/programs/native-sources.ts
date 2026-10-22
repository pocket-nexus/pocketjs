import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const crate = (directory: string) => [`${directory}/Cargo.toml`, `${directory}/src`];

// Only source directories and build descriptions belong here: Cargo targets,
// generated application payloads and signed bundles are build outputs.
const runtime = [
  "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "contracts/generated",
  ...["spec", "drivers", "core", "raster", "present", "package", "modules/media", "runtime",
    "render/draw-ops", "render/glyph-pages", "render/tri-batch", "render/tex-cache"]
    .flatMap(name => crate(`engine/${name}`)),
];
const cabi = [
  ...runtime, "engine/runtime/compat", "engine/runtime/include", ...crate("engine/runtime-cabi"), ...crate("programs/native/cabi"),
  "platforms/linux/offload", "engine/modules/offload/include", "programs/native/cabi/include", "platforms/posix/svc-wire/include",
  "programs/native/quickjs", "engine/guest-quickjs/src", "engine/guest-quickjs/include",
  ...["pocket-gles", "pocket-gles1", "pocket-gles2"].flatMap(name => crate(`devices/gles/${name}`)),
];
const apple = [
  ...runtime, "engine/runtime/compat", "engine/runtime/include", ...crate("engine/runtime-cabi"), ...crate("engine/guest-rquickjs"),
  ...crate("engine/ios"), "engine/ios/include", "engine/ios/uikit",
];

/** Absolute paths also work when a program imports a shared recipe. */
export function nativeSources(kind: "cabi" | "android" | "apple" | "pocketbook", ...paths: string[]): string[] {
  const sources = kind === "android" ? [...cabi, "platforms/android/CMakeLists.txt", "platforms/android/include", "platforms/android/src", "assets/brand/pocketjs-avatar-dark.svg"] : kind === "cabi" ? cabi : kind === "apple" ? apple : [
    ...runtime, ...crate("engine/guest-rquickjs"), ...crate("engine/crates/pocket-mod"),
    ...crate("engine/crates/pocket-ui-surface"),
  ];
  return [...new Set([...sources, ...paths])].map(path => resolve(root, path));
}
