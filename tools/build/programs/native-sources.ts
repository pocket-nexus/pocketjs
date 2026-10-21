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
  ...runtime, ...crate("engine/runtime-cabi"), ...crate("programs/native/cabi"),
  "programs/native/cabi/include",
  "programs/native/quickjs", "engine/guest-quickjs/src", "engine/guest-quickjs/include",
  ...["pocket-gles", "pocket-gles1", "pocket-gles2"].flatMap(name => crate(`devices/gles/${name}`)),
];
const apple = [
  ...runtime, ...crate("engine/runtime-cabi"), ...crate("engine/guest-rquickjs"),
  ...crate("engine/ios"), "engine/ios/include", "engine/ios/uikit",
];

/** Absolute paths also work when an external program imports a Museum recipe. */
export function nativeSources(kind: "cabi" | "apple" | "pocketbook", ...paths: string[]): string[] {
  const sources = kind === "cabi" ? cabi : kind === "apple" ? apple : [
    ...runtime, ...crate("engine/guest-rquickjs"), ...crate("engine/crates/pocket-mod"),
    ...crate("engine/crates/pocket-ui-surface"),
  ];
  return [...new Set([...sources, ...paths])].map(path => resolve(root, path));
}
