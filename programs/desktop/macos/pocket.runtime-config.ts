import { defineRuntimeConfig } from "../../../framework/src/runtime-config.ts";
import { macosBuild as build } from "../../../tools/build/programs/desktop.ts";
export default defineRuntimeConfig({ profile: "../../../profiles/macos-app.json", build });
