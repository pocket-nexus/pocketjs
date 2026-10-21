import { defineRuntimeConfig } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/3ds-runtime.ts";
import { genericBuild as build } from "../../../tools/build/programs/3ds.ts";
export default defineRuntimeConfig({ profile, build });
