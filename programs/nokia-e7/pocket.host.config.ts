import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/nokia-e7.ts";

export default defineHostConfig({ host: "../../hosts/symbian-e7-dev/pocket.host.json", build });
