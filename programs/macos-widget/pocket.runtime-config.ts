import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/macos-widget.ts";
import { widgetBuild as build } from "../../tools/build/programs/desktop.ts";
export default defineRuntimeConfig({ profile, build });
