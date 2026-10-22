import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/ios-dev.ts";
import { build } from "../../tools/build/programs/ios-simulator.ts";

export default defineRuntimeConfig({ profile, build });
