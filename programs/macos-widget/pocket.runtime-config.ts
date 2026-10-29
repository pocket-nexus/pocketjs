import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { widgetBuild as build } from "../../tools/build/programs/desktop.ts";
export default defineRuntimeConfig({ profile: "../../profiles/macos-widget.json", build });
