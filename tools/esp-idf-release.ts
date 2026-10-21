export { stageEspIdfComponents } from "./packaging/esp-idf/stage.ts";
import { stageEspIdfMain } from "./packaging/esp-idf/stage.ts";
if (import.meta.main) await stageEspIdfMain();
