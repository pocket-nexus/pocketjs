import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/ios-simulator.ts";

export default defineHostConfig({ host: "../../hosts/ios-dev/pocket.host.json", build });
