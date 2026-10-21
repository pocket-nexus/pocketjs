import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exportSdk, parseSdkExport, verifySdk } from "./archive.ts";
import { exportReleasedSdk } from "./fetch.ts";
import { releaseVersion } from "./manifest.ts";

export const SDK_USAGE = "pocket sdk export --triple <rust-target> --out <directory> [--version <version>]\npocket sdk export --cargo --out <program-directory>\npocket sdk build --triple <rust-target> --out <directory> [--toolchain <compiler>] [--cargo <path>] [--cargo-arg <flag>]\npocket sdk verify --dir <directory>";
function take(args: string[], name: string): string | undefined {
  const index = args.findIndex(arg => arg === "--" + name || arg.startsWith("--" + name + "="));
  if (index < 0) return;
  const item = args[index]!, attached = item.indexOf("=");
  const value = attached < 0 ? args[index + 1] : item.slice(attached + 1);
  if (!value || value.startsWith("--")) throw new Error("--" + name + " requires a value");
  args.splice(index, attached < 0 ? 2 : 1); return value;
}
function cargoTemplate(out: string): void {
  if (existsSync(out)) throw new Error("program output already exists: " + out);
  mkdirSync(join(out, "src"), { recursive: true });
  writeFileSync(join(out, "Cargo.toml"), '[package]\nname = "pocket-program"\nversion = "0.1.0"\nedition = "2021"\nlicense = "MIT"\n\n[lib]\ncrate-type = ["staticlib"]\n\n[dependencies]\npocket-runtime-cabi = { version = "0.1.0", default-features = false }\n\n[profile.release]\npanic = "abort"\n');
  writeFileSync(join(out, "src/lib.rs"), "#![no_std]\n// Add Rust drivers here; this crate produces the program's only Rust archive.\npub use pocket_runtime_cabi::*;\n");
}
export async function sdkCommand(input: string[]): Promise<number> {
  const args = [...input];
  try {
    if (!args.length || args.includes("--help")) { console.log(SDK_USAGE); return 0; }
    const action = args.shift();
    if (action === "verify") {
      const directory = take(args, "dir");
      if (!directory || args.length) throw new Error("sdk verify requires --dir <directory>");
      const manifest = verifySdk(resolve(directory));
      console.log("Pocket SDK verified: " + manifest.build.triple + " (" + manifest.status + ")");
    } else if (action === "build") {
      const options = parseSdkExport(args), manifest = await exportSdk(options);
      console.log("Pocket SDK candidate built: " + options.out + "\n" + manifest.build.archive);
    } else if (action === "export") {
      const cargo = args.indexOf("--cargo");
      if (cargo >= 0) args.splice(cargo, 1);
      const out = take(args, "out"), triple = take(args, "triple"), version = take(args, "version"), manifestUrl = take(args, "manifest-url");
      if (!out || args.length) throw new Error("sdk export requires --out and accepts release download options only; use sdk build for source compilation");
      if (cargo >= 0) {
        if (triple || version || manifestUrl) throw new Error("Cargo template export accepts only --cargo and --out");
        cargoTemplate(resolve(out));
      } else {
        if (!triple) throw new Error("sdk export requires --triple");
        await exportReleasedSdk(triple, resolve(out), { version: releaseVersion(version), manifestUrl });
      }
      console.log("Pocket SDK exported: " + resolve(out));
    } else throw new Error("unknown sdk command: " + action);
    return 0;
  } catch (error) { console.error("Pocket SDK: " + (error instanceof Error ? error.message : String(error)) + "\n" + SDK_USAGE); return 1; }
}
