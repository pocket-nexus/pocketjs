import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Bundle receipts enumerate regular files, including nested application data. */
export function ipodBundleFiles(directory: string): string[] {
  if (!lstatSync(directory).isDirectory())
    throw new Error("pocket ipodtouch4: assets must be a directory");
  const files: string[] = [],
    names = new Set<string>();
  function walk(dir: string, prefix: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (
        !/^[A-Za-z0-9@._-]+$/.test(entry.name) ||
        names.has(name.toLowerCase())
      )
        throw new Error(
          `pocket ipodtouch4: invalid or duplicate bundle path ${name}`,
        );
      names.add(name.toLowerCase());
      if (entry.isDirectory()) walk(join(dir, entry.name), name + "/");
      else if (entry.isFile()) files.push(name);
      else
        throw new Error(
          `pocket ipodtouch4: bundle resources must be regular files: ${name}`,
        );
    }
  }
  walk(directory, "");
  return files.sort();
}

export function stageIPodAssets(
  source: string,
  bundle: string,
  executable: string,
): void {
  const files = ipodBundleFiles(source);
  const reserved = new Set(
    [
      executable,
      "Info.plist",
      "PkgInfo",
      "_CodeSignature",
      "CodeResources",
    ].map((n) => n.toLowerCase()),
  );
  const existing = new Set(ipodBundleFiles(bundle).map((n) => n.toLowerCase()));
  for (const name of files) {
    if (
      reserved.has(name.split("/")[0]!.toLowerCase()) ||
      existing.has(name.toLowerCase()) ||
      existsSync(join(bundle, name))
    )
      throw new Error(
        `pocket ipodtouch4: asset would replace generated bundle content: ${name}`,
      );
  }
  for (const name of files) {
    const to = join(bundle, name);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(source, name), to);
  }
}
