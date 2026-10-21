import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/gba.ts";
import { gbaBuild as build } from "../../tools/build/programs/aot.ts";
export default defineRuntimeConfig({ profile, build });
