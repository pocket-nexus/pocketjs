import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { cargo, defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "./profile.ts";

/** Services this program composes: evdev buttons and baked glyphs on the panel. */
export const ZERO_PROGRAM_CAPABILITIES: readonly string[] = ["input.buttons", "text.glyphs.baked"];

const absent = profile.capabilities.filter((capability) => !ZERO_PROGRAM_CAPABILITIES.includes(capability));
if (absent.length) throw new Error(`${profile.id}: profile promises capabilities absent from this program: ${absent.join(", ")}`);

export default defineRuntimeConfig({
  profile,
  build: {
    hosts: ["darwin-arm64", "linux-arm64", "linux-x64"],
    steps: cargo({ manifest: "../../Cargo.toml", package: "pocket-cardputer-zero", targetDirectory: "{outdir}/cargo", release: true }),
    sourceInputs: ["Cargo.toml", "build.rs", "src", "profile.ts", "../../Cargo.toml", "../../Cargo.lock", "../../rust-toolchain.toml",
      ...["hooks", "fbdev", "evdev"].flatMap(name => [`../../platforms/linux/${name}/Cargo.toml`, `../../platforms/linux/${name}/src`]),
      ...["spec", "drivers", "core", "raster", "present", "package", "runtime", "guest-rquickjs", "profile-build", "render/draw-ops", "render/glyph-pages", "render/tri-batch", "render/tex-cache"].flatMap(name => [`../../engine/${name}/Cargo.toml`, `../../engine/${name}/src`]),
    ],
    artifact: "{outdir}/runtime",
    run(context) {
      const directory = resolve(context.outdir, "runtime"); mkdirSync(directory, { recursive: true });
      copyFileSync(resolve(context.outdir, "cargo/release/pocket-cardputer-zero"), resolve(directory, "pocket-cardputer-zero"));
    },
  },
});
