import { readFileSync } from "node:fs";
/** The minimal program composes through the QuickJS facade: the native
 *  program creates and boots the Runtime, the program ticks it, and the
 *  guest reads its bundle from a file source. */
const requiredSymbols = ["pocket_qjs_program_create_host", "pocket_qjs_program_boot_source", "pocket_native_program_create_source", "pocket_native_program_boot", "pocket_runtime_tick", "pocket_qjs_program_destroy", "pocket_guest_quickjs_attach", "pocket_3ds_file_source_open"];
/** Inspect arm-none-eabi-nm --defined-only output from the linked ELF of programs/3ds. */
export function check3dsSymbols(minimal: string): void {
  const names = minimal.split(/\r?\n/).map(line => line.trim().split(/\s+/).at(-1) ?? "");
  for (const symbol of requiredSymbols)
    if (!names.includes(symbol)) throw new Error(`minimal program lacks ${symbol}`);
  console.log(`3DS ELF: facade/Runtime/file/guest present (${requiredSymbols.length} symbols)`);
}
if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("usage: check-3ds-symbols.ts minimal.nm");
  check3dsSymbols(readFileSync(process.argv[2]!, "utf8"));
}
