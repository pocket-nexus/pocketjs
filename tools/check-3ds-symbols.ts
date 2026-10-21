import { readFileSync } from "node:fs";
const productPrefixes = ["pocket_package_open", "devserver_", "launcher_", "camera_", "agent_", "link_", "stage_", "runtime_slot"];
/** Inspect arm-none-eabi-nm --defined-only output from the actual linked ELFs. */
export function check3dsSymbols(minimal: string, product: string): void {
  const names = (text: string) => text.split(/\r?\n/).map(line => line.trim().split(/\s+/).at(-1) ?? "");
  const small = names(minimal), full = names(product);
  for (const prefix of productPrefixes) {
    if (small.some(name => name.startsWith(prefix))) throw new Error(`minimal program contains product symbol ${prefix}`);
    if (!full.some(name => name.startsWith(prefix))) throw new Error(`product lost ${prefix} symbols`);
  }
  for (const symbol of ["pocket_runtime_create", "pocket_runtime_boot", "pocket_runtime_tick", "pocket_runtime_destroy", "pocket_guest_quickjs_create", "pocket_3ds_file_source_open"])
    if (!small.includes(symbol)) throw new Error(`minimal program lacks ${symbol}`);
  console.log("3DS ELFs: minimal Runtime/file/guest present; eight product symbol groups excluded and retained by product");
}
if (import.meta.main) {
  if (process.argv.length !== 4) throw new Error("usage: check-3ds-symbols.ts minimal.nm product.nm");
  check3dsSymbols(readFileSync(process.argv[2]!, "utf8"), readFileSync(process.argv[3]!, "utf8"));
}
