import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { cargo, defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "./profile.ts";
export default defineRuntimeConfig({
  profile,
  build: {
    hosts: ["linux-arm64", "linux-x64"],
    steps: cargo({ manifest: "../../Cargo.toml", package: "pocket-linux-kms", targetDirectory: "{outdir}/cargo", release: true }),
    sourceInputs: ["Cargo.toml", "src", "profile.ts", "../../Cargo.toml", "../../Cargo.lock", "../../rust-toolchain.toml",
      ...["hooks", "drm", "fbdev", "evdev"].flatMap(name => [`../../platforms/linux/${name}/Cargo.toml`, `../../platforms/linux/${name}/src`]),
      ...["spec", "drivers", "core", "raster", "present", "package", "modules/media", "runtime", "guest-rquickjs", "render/draw-ops", "render/glyph-pages", "render/tri-batch", "render/tex-cache"].flatMap(name => [`../../engine/${name}/Cargo.toml`, `../../engine/${name}/src`]),
    ],
    artifact: "{outdir}/runtime",
    run(context) {
      const directory = resolve(context.outdir, "runtime"); mkdirSync(directory, { recursive: true });
      copyFileSync(resolve(context.outdir, "cargo/release/pocket-linux-kms"), resolve(directory, "pocket-linux-kms"));
      copyFileSync(resolve(context.outdir, "pocket-profile.json"), resolve(directory, "pocket-profile.json"));
    },
  },
});
