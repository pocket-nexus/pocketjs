import { defineRuntimeConfig } from "../../framework/src/runtime-config.ts";
import profile from "../../profiles/moto-g-play-dev.ts";
import { build } from "../../tools/build/programs/moto-g-play.ts";

export default defineRuntimeConfig({ profile, build });
