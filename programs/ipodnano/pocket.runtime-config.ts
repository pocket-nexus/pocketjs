import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/ipodnano.ts";
import { ipodNanoBuild as build } from "../../tools/build/programs/aot.ts";
export default defineRuntimeConfig({ profile, build });
