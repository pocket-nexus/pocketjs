#!/usr/bin/env bun
// rust-psp owns the PSP C memory/math exports. The SDK supplies remaining C
// functions after Rust archives have resolved those exports.
import { readFileSync } from "node:fs";

const sdkLibraries = new Set(["-lc", "-lm", "-lpthread-psp", "-lcglue"]);

/** Expand GNU response files emitted by rustc without invoking a shell. */
export function responseWords(source: string): string[] {
  const words: string[] = [];
  let word = "", quote = "", active = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\\") {
      if (++i === source.length) throw new Error("incomplete PSP linker response escape");
      word += source[i]; active = true;
    } else if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
      active = true;
    } else if (ch === "\"" || ch === "'") {
      quote = ch; active = true;
    } else if (/\s/.test(ch)) {
      if (active) words.push(word);
      word = ""; active = false;
    } else {
      word += ch; active = true;
    }
  }
  if (quote) throw new Error("unterminated PSP linker response quote");
  if (active) words.push(word);
  return words;
}

export function pspLinkArguments(args: readonly string[]): string[] {
  const libraries = args.filter(arg => sdkLibraries.has(arg));
  if (!libraries.length) return [...args];
  const result = args.filter(arg => !sdkLibraries.has(arg));
  const lastRust = result.findLastIndex(arg => arg.endsWith(".rlib"));
  if (lastRust < 0) throw new Error("PSP link has SDK libraries without Rust archives");
  // Re-establish the original static mode for the relocated SDK libraries.
  // Rust emits its final -Bdynamic after this point; no flags are discarded.
  result.splice(lastRust + 1, 0, "-Bstatic", ...libraries);
  return result;
}

if (import.meta.main) {
  const linker = process.env.POCKET_PSP_LLD;
  if (!linker) throw new Error("POCKET_PSP_LLD must name the selected Rust toolchain's rust-lld");
  const expand = (args: string[], depth = 0): string[] => {
    if (depth > 8) throw new Error("recursive PSP linker response files");
    return args.flatMap(arg => arg.startsWith("@") ? expand(responseWords(readFileSync(arg.slice(1), "utf8")), depth + 1) : [arg]);
  };
  // /usr/bin/env removes DYLD_* before starting this shebang script on macOS.
  // Pass the selected compiler's library directory to the child itself.
  const env = { ...process.env };
  if (process.platform === "darwin" && env.POCKET_PSP_LLVM_LIB) {
    env.DYLD_LIBRARY_PATH = [env.POCKET_PSP_LLVM_LIB, env.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  const result = Bun.spawnSync([linker, ...pspLinkArguments(expand(process.argv.slice(2)))], { env, stdout: "inherit", stderr: "inherit" });
  process.exit(result.success ? 0 : result.exitCode || 1);
}
