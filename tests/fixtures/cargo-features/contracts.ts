/** Reviewed feature surface; never derive expectations from Cargo metadata. */
export const FEATURE_CONTRACTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "pocket-spec": {}, "pocket-drivers": {}, "pocket-package": {},
  "pocket-runtime": {}, "pocket-present": {}, "pocket-raster": {}, "pocket-driver-kit": {},
  "pocket-profile-build": {},
  "pocket-draw-ops": {}, "pocket-tri-batch": {}, "pocket-glyph-pages": {}, "pocket-tex-cache": {},
  "pocket-media": {},
  "pocketjs-core": { default: [], counters: [] },
  "pocket-runtime-cabi": {
    default: ["std"], std: [], "external-runtime": [],
    "legacy-ui": ["dep:pocket-gles", "dep:pocket-gles1", "dep:pocket-gles2"],
    "standalone-extension-provider": [], gles1: [], "gl-frame-validation": [],
    "software-only": [], "harness-access": [], "boot-stage": [],
  },
  "pocket-guest-rquickjs": {}, "pocket-apple": {},
  "pocket-gles": {}, "pocket-gles1": {}, "pocket-gles2": {},
  "pocket-psp-ge": {}, "pocket-psp-render": {}, "pocket-vita-render": {},
  "pocket-vita-gxm": { default: [], "runtime-compiler": [] },
  "pocket-web-render": {}, "pocket-web-wgpu": {},
  "pocket-render-esp-ppa": { default: [], cabi: ["dep:pocket-runtime-cabi"] },
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
  "pocket-db": { default: ["mount"], mount: ["dep:pocket-mod", "dep:anyhow"] },
  "pocket-fs": { default: ["mount"], mount: ["dep:pocket-mod", "dep:anyhow"] },
  "pocket-net": { default: ["mount"], mount: ["dep:pocket-mod", "dep:anyhow"] },
  "pocket-mod": {}, "pocket-sim": {}, "pocket-text": {},
};

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
