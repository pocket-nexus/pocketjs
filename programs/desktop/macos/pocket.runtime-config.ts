import { defineRuntimeConfig } from "../../../framework/src/runtime-config.ts";
import profile from "../../../profiles/macos-app.ts";
import { macosBuild as build } from "../../../tools/build/programs/desktop.ts";
export default defineRuntimeConfig({ profile, build });
