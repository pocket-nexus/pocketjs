import { readFileSync } from "node:fs";
/** Symbol groups of a product host (package parser, link client, launcher,
 *  camera, agent, recovery slots): the file-loaded program defines none. */
const excludedPrefixes = ["pocket_package_open", "devstats_", "link2_", "launcher_", "camera_", "agent_", "link_", "stage_", "runtime_slot"];
/** Inspect arm-none-eabi-nm --defined-only output from the linked ELF of programs/3ds. */
export function check3dsSymbols(minimal: string): void {
  const names = minimal.split(/\r?\n/).map(line => line.trim().split(/\s+/).at(-1) ?? "");
  for (const prefix of excludedPrefixes) {
    if (names.some(name => name.startsWith(prefix))) throw new Error(`minimal program contains product symbol ${prefix}`);
  }
  // The minimal program composes through the QuickJS facade: the native
  // program creates and boots the Runtime, the program ticks it.
  for (const symbol of ["pocket_qjs_program_create_host", "pocket_qjs_program_boot_source", "pocket_native_program_create_source", "pocket_native_program_boot", "pocket_runtime_tick", "pocket_qjs_program_destroy", "pocket_guest_quickjs_attach", "pocket_3ds_file_source_open"])
    if (!names.includes(symbol)) throw new Error(`minimal program lacks ${symbol}`);
  console.log(`3DS ELF: facade/Runtime/file/guest present; ${excludedPrefixes.length} product symbol groups absent`);
}
if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error("usage: check-3ds-symbols.ts minimal.nm");
  check3dsSymbols(readFileSync(process.argv[2]!, "utf8"));
}
