import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/ipodtouch4.ts";

export default defineHostConfig({ host: "../../hosts/ipodtouch4-dev/pocket.host.json", build });
