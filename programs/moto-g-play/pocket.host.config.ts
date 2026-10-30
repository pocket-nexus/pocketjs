import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/moto-g-play.ts";

export default defineHostConfig({ host: "../../hosts/moto-g-play-dev/pocket.host.json", build });
