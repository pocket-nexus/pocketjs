// PSP launcher inputs are explicit registry entries, never an entire dist tree.
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RuntimeSourceContext } from "../../../framework/src/host-config.ts";

/** Resolve the same flags and registry order consumed by the PSP build script.
 * Paths in CLI flags follow the invocation directory, as nativeArguments does. */
export function launcherSourceInputs(context: Pick<RuntimeSourceContext, "args" | "invocationDirectory" | "output">): string[] {
  let registry: string | undefined, packages: string | undefined;
  for (const arg of context.args) {
    const match = /^(--launcher-(?:registry|packages))(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    if (!match[2]) throw new Error(`${match[1]} requires =<path>`);
    const path = resolve(context.invocationDirectory, match[2]);
    if (match[1] === "--launcher-registry") registry = path;
    else packages = path;
  }
  if (!registry) {
    if (packages) throw new Error("--launcher-packages requires --launcher-registry");
    return [];
  }
  const file = (path: string) => {
    if (!lstatSync(path).isFile()) throw new Error(`PSP launcher input is not a regular file: ${path}`);
    return path;
  };
  file(registry);
  packages ??= resolve(dirname(registry), "packages");
  if (!lstatSync(packages).isDirectory()) throw new Error(`PSP launcher packages is not a directory: ${packages}`);
  const inputs = [registry];
  const outputs = new Set([context.output]);
  // Rust String::from_utf8 retains a BOM, so keep it for the same output check.
  const tsv = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(registry));
  for (const [index, line] of tsv.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const [output, id, title] = line.split("\t");
    if (output === undefined || id === undefined || title === undefined)
      throw new Error(`${registry}:${index + 1}: expected output\\tid\\ttitle`);
    if (!/^[A-Za-z0-9_.-]+$/.test(output) || output === "." || output === "..")
      throw new Error(`invalid launcher output: ${output}`);
    if (outputs.has(output)) throw new Error(`launcher registry duplicates output: ${output}`);
    outputs.add(output);
    inputs.push(file(resolve(packages, `${output}.pocket`)));
  }
  if (inputs.length === 1) throw new Error("launcher registry contains no guest applications");
  return inputs;
}
