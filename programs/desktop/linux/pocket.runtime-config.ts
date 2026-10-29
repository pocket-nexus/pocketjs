import { defineRuntimeConfig } from "../../../framework/src/runtime-config.ts";
import { linuxBuild as build } from "../../../tools/build/programs/desktop.ts";
export default defineRuntimeConfig({ profile: "../../../profiles/linux-app.json", build });
