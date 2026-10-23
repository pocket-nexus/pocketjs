import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { PocketProfile } from "../../contracts/spec/profile.ts";
import { cargo, defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "./profile.ts";

/** Services this program composes: evdev buttons, pointer and touch, and baked
 * glyphs on one fixed display. */
export const LINUX_PROGRAM_CAPABILITIES: readonly string[] = ["input.buttons", "input.pointer", "input.touch", "text.glyphs.baked"];

/** A profile promising other services, role capabilities or a dynamic or
 * auxiliary display fails when this config loads, before export or build. The
 * compiled program checks the display and input facts again at startup. */
export function linuxProgramProfile<const P extends PocketProfile>(selected: P): P {
  const absent = [...selected.capabilities.filter(capability => !LINUX_PROGRAM_CAPABILITIES.includes(capability)),
    ...Object.values(selected.roleCapabilities ?? {}).flat()];
  if (absent.length || selected.display.dynamicViewport || selected.display.auxiliary) {
    throw new Error(`${selected.id}: profile promises capabilities absent from this Linux program${absent.length ? `: ${absent.join(", ")}` : ""}`);
  }
  return selected;
}

export default defineRuntimeConfig({
  profile: linuxProgramProfile(profile),
  build: {
    hosts: ["linux-arm64", "linux-x64"],
    steps: cargo({ manifest: "../../Cargo.toml", package: "pocket-linux-kms", targetDirectory: "{outdir}/cargo", release: true }),
    sourceInputs: ["Cargo.toml", "build.rs", "src", "profile.ts", "../../Cargo.toml", "../../Cargo.lock", "../../rust-toolchain.toml",
      ...["hooks", "drm", "fbdev", "evdev"].flatMap(name => [`../../platforms/linux/${name}/Cargo.toml`, `../../platforms/linux/${name}/src`]),
      ...["spec", "drivers", "core", "raster", "present", "package", "modules/media", "runtime", "guest-rquickjs", "profile-build", "render/draw-ops", "render/glyph-pages", "render/tri-batch", "render/tex-cache"].flatMap(name => [`../../engine/${name}/Cargo.toml`, `../../engine/${name}/src`]),
    ],
    artifact: "{outdir}/runtime",
    run(context) {
      const directory = resolve(context.outdir, "runtime"); mkdirSync(directory, { recursive: true });
      copyFileSync(resolve(context.outdir, "cargo/release/pocket-linux-kms"), resolve(directory, "pocket-linux-kms"));
    },
  },
});
