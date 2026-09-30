// apps/nexus-touch — app-local Pocket config: the baked idle motion
// (apps/nexus/motion.ts) at the wordmark size the homepage chose.

import { definePocketConfig } from "@pocketjs/framework/config";
import { FS } from "./art.ts";
import { nexusMotion } from "../nexus/motion.ts";

export default definePocketConfig({ theme: nexusMotion(FS) });
