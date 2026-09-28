// Compatibility entry point for earlier Pocket Manga installations.
export { exportLibrary } from "./companion.ts";
import { main } from "./companion.ts";
if (import.meta.main) await main();
