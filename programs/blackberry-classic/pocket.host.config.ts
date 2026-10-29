import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/blackberry-classic.ts";

export default defineHostConfig({ host: "../../hosts/blackberry-qnx-dev/pocket.host.json", build });
