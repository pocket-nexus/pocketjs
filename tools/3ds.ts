// Compatibility entry for the complete 3DS product (Link, recovery and launcher).
export * from "../products/3ds/build.ts";
import { build3ds } from "../products/3ds/build.ts";
if (import.meta.main) {
  try { await build3ds(Bun.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
