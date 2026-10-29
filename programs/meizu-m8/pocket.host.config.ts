import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/meizu-m8.ts";

export default defineHostConfig({ host: "../../hosts/meizu-m8-dev/pocket.host.json", build });
