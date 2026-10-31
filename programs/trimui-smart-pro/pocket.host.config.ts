import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { cargo, defineHostConfig } from "../../framework/src/host-config.ts";
import profile from "./pocket.host.json" with { type: "json" };

/** Services this program composes: the gamepad as buttons, baked glyphs, and
 * glyphs rasterized from the firmware's CJK font on first sight. */
export const TRIMUI_PROGRAM_CAPABILITIES: readonly string[] = ["input.buttons", "text.glyphs.baked", "text.glyphs.runtime"];

const absent = profile.capabilities.filter((capability) => !TRIMUI_PROGRAM_CAPABILITIES.includes(capability));
if (absent.length) throw new Error(`${profile.id}: profile promises capabilities absent from this program: ${absent.join(", ")}`);

export default defineHostConfig({
  host: "./pocket.host.json",
  build: {
    hosts: ["darwin-arm64", "linux-arm64", "linux-x64"],
    steps: cargo({ manifest: "../../Cargo.toml", package: "pocket-trimui-smart-pro", targetDirectory: "{outdir}/cargo", release: true }),
    sourceInputs: ["Cargo.toml", "build.rs", "src", "agent", "pocket.host.json", "../../Cargo.toml", "../../Cargo.lock", "../../rust-toolchain.toml", "../../engine/arcade"],
    artifact: "{outdir}/runtime",
    run(context) {
      const directory = resolve(context.outdir, "runtime"); mkdirSync(directory, { recursive: true });
      copyFileSync(resolve(context.outdir, "cargo/release/pocket-trimui-smart-pro"), resolve(directory, "pocket-trimui-smart-pro"));
    },
  },
});
