import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import { build as build } from "../../tools/build/programs/web.ts";
export default defineRuntimeConfig({ profile: "../../profiles/web-app.json", build });
