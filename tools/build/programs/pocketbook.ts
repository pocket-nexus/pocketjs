import { nativeSources } from "./native-sources.ts";
import { compilerOnly, type RuntimeBuild } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/pocketbook.ts";
import { requireProgramProfile, requireApplication } from "./application.ts";
import { buildPocketBook } from "./pocketbook-native.ts";

export const build: RuntimeBuild = {
  hosts: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"],
  sourceInputs: nativeSources("pocketbook",
    "hosts/pocketbook/Cargo.toml",
    "hosts/pocketbook/build.rs",
    "hosts/pocketbook/src",
  ),
  steps: compilerOnly(),
  input: "package",
  artifact: "{outdir}/application",
  async run(context) {
    requireProgramProfile(context, profile);
    await buildPocketBook(context);
  },
};
