import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/ipodtouch6.ts";

export default defineHostConfig({ host: "../../hosts/ipodtouch-dev/pocket.host.json", build });
