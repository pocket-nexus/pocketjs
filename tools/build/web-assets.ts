import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");

/** Program realms and browser providers keep their source-relative module URLs. */
export function webAssetSources(): string[] {
  const groups: readonly [string, RegExp][] = [
    ["platforms/web", /\.js$/],
    ["engine/guest-web/src", /\.js$/],
    ["programs/web", /^(?:app-instance|system-engine)\.(?:js|html)$/],
  ];
  return groups.flatMap(([directory, pattern]) => {
    const root = resolve(repository, directory);
    return readdirSync(root).filter(name => pattern.test(name) && statSync(resolve(root, name)).isFile())
      .map(name => resolve(root, name));
  });
}

/** Returns paths relative to outdir. Omitting textWasm leaves the text provider unbuilt. */
export function stageWebAssets(outdir: string, options: { wasm: string; textWasm?: string }): string[] {
  const files: [string, string][] = webAssetSources().map(source => [source, relative(repository, source)]);
  files.push([options.wasm, "platforms/web/pocketjs.wasm"]);
  if (options.textWasm) files.push([options.textWasm, "platforms/web/pocket_text.wasm"]);
  for (const [source, destination] of files) {
    mkdirSync(dirname(resolve(outdir, destination)), { recursive: true });
    copyFileSync(source, resolve(outdir, destination));
  }
  return files.map(([, destination]) => destination);
}
