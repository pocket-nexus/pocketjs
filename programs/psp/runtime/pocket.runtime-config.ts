import { defineRuntimeConfig } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/psp-runtime.ts";
import { genericBuild as build } from "../../../tools/build/programs/psp.ts";
export default defineRuntimeConfig({ profile, build });
