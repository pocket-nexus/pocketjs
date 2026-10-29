import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/redmi-1s.ts";

export default defineHostConfig({ host: "../../hosts/redmi-1s-dev/pocket.host.json", build });
