import { defineRuntimeConfig } from "../../../framework/src/runtime-config.ts";
import { genericBuild as build } from "../../../tools/build/programs/psp.ts";
export default defineRuntimeConfig({ profile: "../../../profiles/psp-runtime.json", build });
