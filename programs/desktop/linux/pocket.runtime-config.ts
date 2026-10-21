import { defineRuntimeConfig } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/linux-app.ts";
import { linuxBuild as build } from "../../../tools/build/programs/desktop.ts";
export default defineRuntimeConfig({ profile, build });
