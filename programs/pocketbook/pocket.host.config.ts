import { defineHostConfig } from "../../framework/src/host-config.ts";
import { build } from "../../tools/build/programs/pocketbook.ts";

export default defineHostConfig({ host: "../../hosts/pocketbook/pocket.host.json", build });
