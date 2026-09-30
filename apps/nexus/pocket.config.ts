// apps/nexus — app-local Pocket config: the baked idle motion (motion.ts).

import { definePocketConfig } from "@pocketjs/framework/config";
import { FS } from "./scene.ts";
import { nexusMotion } from "./motion.ts";

export default definePocketConfig({ theme: nexusMotion(FS) });
