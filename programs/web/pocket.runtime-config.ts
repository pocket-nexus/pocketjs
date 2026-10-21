import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/web-app.ts";
import { build as build } from "../../tools/build/programs/web.ts";
export default defineRuntimeConfig({ profile, build });
