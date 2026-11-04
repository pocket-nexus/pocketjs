import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parsePocketProfile } from "../../framework/src/profile.ts";
import { cargo, defineHostConfig } from "../../framework/src/host-config.ts";
import profile from "./pocket.host.json" with { type: "json" };

/** Services this program composes: both panels on the GPU, evdev buttons and
 * touch on the lower panel, baked glyphs. */
export const RG_DS_PLUS_CAPABILITIES: readonly string[] = [
  "input.buttons", "input.touch.auxiliary", "display.auxiliary", "text.glyphs.baked",
];

const selected = parsePocketProfile(profile);
const absent = selected.capabilities.filter((capability) => !RG_DS_PLUS_CAPABILITIES.includes(capability));
if (absent.length) throw new Error(`${selected.id}: host contract promises capabilities absent from this program: ${absent.join(", ")}`);

export default defineHostConfig({
  host: "./pocket.host.json",
  build: {
    hosts: ["darwin-arm64", "linux-arm64", "linux-x64"],
    steps: cargo({ manifest: "../../Cargo.toml", package: "pocket-rg-ds-plus", targetDirectory: "{outdir}/cargo", release: true }),
    sourceInputs: ["Cargo.toml", "build.rs", "src", "pocket.host.json", "../../Cargo.toml", "../../Cargo.lock", "../../rust-toolchain.toml",
      ...["hooks", "drm", "evdev"].flatMap(name => [`../../platforms/linux/${name}/Cargo.toml`, `../../platforms/linux/${name}/src`]),
      ...["pocket-gles", "pocket-gles2"].flatMap(name => [`../../devices/gles/${name}/Cargo.toml`, `../../devices/gles/${name}/src`]),
      ...["spec", "drivers", "core", "raster", "package", "runtime", "guest-rquickjs", "profile-build", "render"].flatMap(name => [`../../engine/${name}/Cargo.toml`, `../../engine/${name}/src`]),
    ],
    artifact: "{outdir}/runtime",
    run(context) {
      const directory = resolve(context.outdir, "runtime"); mkdirSync(directory, { recursive: true });
      copyFileSync(resolve(context.outdir, "cargo/release/pocket-rg-ds-plus"), resolve(directory, "pocket-rg-ds-plus"));
    },
  },
});
