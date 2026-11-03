import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const crate = (directory: string) => [`${directory}/Cargo.toml`, `${directory}/src`];

// Only source directories and build descriptions belong here: Cargo targets,
// generated application payloads and signed bundles are build outputs.
const runtime = [
  "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "contracts/generated",
  ...["spec", "drivers", "core", "raster", "package", "modules/media", "runtime", "render"]
    .flatMap(name => crate(`engine/${name}`)),
];
const native = [
  ...runtime, ...crate("programs/sdk/archive"), ...crate("programs/native/runtime"), ...crate("engine/physics"),
  "platforms/linux/offload", "engine/modules/offload/include", "programs/native/runtime/include", "platforms/posix/svc-wire/include",
  "programs/native/quickjs", "engine/guest-quickjs/src", "engine/guest-quickjs/include",
  ...["pocket-gles", "pocket-gles1", "pocket-gles2"].flatMap(name => crate(`devices/gles/${name}`)),
];
const apple = [
  ...runtime, ...crate("programs/sdk/archive"), ...crate("engine/guest-rquickjs"),
  ...crate("platforms/apple"), "platforms/apple/include", "platforms/apple/uikit",
];

/** Absolute paths also work when a program imports a shared recipe. */
export function nativeSources(kind: "native" | "apple" | "pocketbook", ...paths: string[]): string[] {
  const sources = kind === "native" ? native : kind === "apple" ? apple : [
    ...runtime, ...crate("engine/guest-rquickjs"), ...crate("engine/mod"),
    ...crate("engine/ui-surface"), ...crate("engine/physics"),
  ];
  return [...new Set([...sources, ...paths])].map(path => resolve(root, path));
}
