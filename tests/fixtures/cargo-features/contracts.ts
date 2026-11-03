/** Reviewed feature surface; never derive expectations from Cargo metadata. */
export const FEATURE_CONTRACTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "pocket-spec": {}, "pocket-drivers": {}, "pocket-package": {},
  "pocket-runtime": {}, "pocket-present": {}, "pocket-raster": {}, "pocket-driver-kit": {},
  "pocket-profile-build": {},
  "pocket-render": {}, "pocket-draw-ops": {}, "pocket-glyph-pages": {}, "pocket-tex-cache": {},
  "pocket-media": {},
  "pocketjs-core": { default: [], counters: [] },
  "pocket-archive": {
    default: ["std"], std: [], "external-runtime": [],
    "software-renderer": ["dep:pocket-raster"],
  },
  "pocket-guest-rquickjs": {}, "pocket-apple": {},
  "pocket-gles": { default: [], "mock-gl": [] }, "pocket-gles1": {}, "pocket-gles2": {},
  "pocket-psp-ge": {}, "pocket-psp-render": {}, "pocket-vita-render": {},
  "pocket-vita-gxm": { default: [], "runtime-compiler": [] },
  "pocket-web-render": {}, "pocket-web-wgpu": {},
  "pocket-render-esp-ppa": { default: [], cabi: [] },
  "pocket-render-sifli-epic": { default: [], cabi: [] },
  "pocket-gba-video": {}, "pocket-posix-svc-wire": {}, "pocket-rockbox-input": {},
  "pocket-psp-alloc": {}, "pocket-psp-quickjs-alloc": {}, "pocket-psp-audio": {},
  "pocket-psp-display": {}, "pocket-psp-system": {}, "pocket-psp-input": {}, "pocket-psp-io": {},
  "pocket-vita-audio": {}, "pocket-vita-input": {}, "pocket-vita-net": {},
  "pocket-vita-system": {}, "pocket-vita-io": {},
  "pocket-linux-alsa": {}, "pocket-linux-drm": {}, "pocket-linux-evdev": {},
  "pocket-linux-fbdev": {}, "pocket-linux-hooks": {},
  microts: {
    default: [], runtime: ["dep:pocket-runtime"], counters: ["pocketjs-core/counters"],
    "model-trace": [], "critical-section": ["portable-atomic/critical-section"],
  },
  "pocket3d-packs": { default: [], std: [], cabi: [] },
  "pocket3d": {}, "pocket3d-anim": {}, "pocket3d-mesh": {},
  "pocket3d-title": {}, "pocket3d-world": {}, "pocket-vrm": {},
  "pocket-ui-gpui": {}, "pocket-ui-surface": {}, "pocket-ui-wgpu": {}, "pocket-widget": {},
  "pocket-mod": {}, "pocket-sim": {}, "pocket-text": {},
};

/**
 * The pocket-archive features each archive root resolves in its own build:
 * the Cargo selection its build command uses, and the features cargo tree
 * reports for pocket-archive under it. Composition features (software
 * renderer) select what pocket_runtime_create registers; std and
 * external-runtime select the allocator, panic handler and hooks. `raster`
 * states whether pocket-raster is in the root's normal dependency graph.
 */
export const ARCHIVE_ROOT_FEATURES: readonly { root: string; build: readonly string[]; features: readonly string[]; raster: boolean }[] = [
  // tools/release/archive.ts and the host contract runners: runtime-cabi,
  // pica-driver's driver.c, 3ds-minimal and the programs/3ds build.
  { root: "SDK and host contract runners", build: ["-p", "pocket-archive", "--no-default-features", "--features", "software-renderer"], features: ["software-renderer"], raster: true },
  { root: "products/3ds/core", build: ["-p", "pocketjs-3ds-core", "--no-default-features"], features: [], raster: false },
  { root: "programs/esp-idf/archive", build: ["-p", "pocket-idf-runtime", "--no-default-features"], features: ["software-renderer"], raster: true },
  { root: "programs/sifli/archive", build: ["-p", "pocket-sifli-runtime", "--no-default-features"], features: ["software-renderer"], raster: true },
  { root: "pocket-native-program std,software-only", build: ["-p", "pocket-native-program", "--no-default-features", "--features", "std,software-only"], features: ["std"], raster: true },
  { root: "pocket-native-program standalone-extension-provider", build: ["-p", "pocket-native-program", "--no-default-features", "--features", "standalone-extension-provider"], features: [], raster: false },
  { root: "pocket-native-program standalone-extension-provider,gles1", build: ["-p", "pocket-native-program", "--no-default-features", "--features", "standalone-extension-provider,gles1"], features: [], raster: false },
  { root: "programs/psp", build: ["-p", "pocketjs-psp"], features: ["external-runtime"], raster: false },
  { root: "programs/vita", build: ["-p", "pocketjs-vita"], features: ["default", "std"], raster: true },
];

/** Validate both feature edges and resolved active features from cargo tree. */
export function checkFeatureTree(tree: string): void {
  for (const line of tree.split("\n")) {
    const edge = /^(\S+) feature "([^"]+)"/.exec(line);
    const pkg = /^(\S+) v[^|]+\|([^ ]*)/.exec(line);
    const name = (edge ?? pkg)?.[1];
    if (!name || !(name in FEATURE_CONTRACTS)) continue;
    const allowed = FEATURE_CONTRACTS[name]!;
    const features = edge ? [edge[2]!] : pkg![2]!.split(",").filter(Boolean);
    for (const feature of features) {
      // Cargo emits a default edge even for crates without a [features] table.
      if (feature !== "default" && !(feature in allowed)) {
        throw new Error(`${name}: undocumented public feature ${feature}`);
      }
    }
  }
}
