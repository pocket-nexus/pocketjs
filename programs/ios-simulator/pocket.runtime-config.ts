import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build } from "../../tools/build/programs/ios-simulator.ts";

export default defineRuntimeConfig({ profile: "../../profiles/ios-dev.json", build });
