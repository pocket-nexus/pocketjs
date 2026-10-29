import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/iphone2g.ts";

export default defineHostConfig({ host: "../../hosts/iphone2g-dev/pocket.host.json", build });
