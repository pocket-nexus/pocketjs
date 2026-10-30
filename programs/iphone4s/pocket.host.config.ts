import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/iphone4s.ts";

export default defineHostConfig({ host: "../../hosts/iphone4s-dev/pocket.host.json", build });
