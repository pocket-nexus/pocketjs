import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/3ds-dev.ts";
import { build } from "./recipe.ts";
export default defineRuntimeConfig({ profile, build });
