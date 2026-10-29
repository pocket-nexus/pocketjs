import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { ipodNanoBuild as build } from "../../tools/build/programs/aot.ts";
export default defineRuntimeConfig({ profile: "../../profiles/ipodnano.json", build });
