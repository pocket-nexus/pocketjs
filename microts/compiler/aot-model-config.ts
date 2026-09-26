import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function modelConfiguration(file: string): { mode: "rust" | "compiled"; recursionLimit: number; aot?: boolean; directory?: string; framework?: string; entry?: string } {
  for (let directory = dirname(resolve(file)); ; directory = dirname(directory)) {
    const path = resolve(directory, "pocket.json");
    if (existsSync(path)) {
      const app = JSON.parse(readFileSync(path, "utf8")).app ?? {};
      const mode = app.model ?? "rust", recursionLimit = app.recursionLimit ?? 256;
      if (mode !== "rust" && mode !== "compiled") throw new Error(`${path}: app.model must be rust or compiled`);
      if (!Number.isInteger(recursionLimit) || recursionLimit < 1) throw new Error(`${path}: app.recursionLimit must be a positive integer`);
      if (mode === "compiled" && app.aot !== true) throw new Error(`${path}: app.model = compiled requires app.aot = true`);
      return { mode, recursionLimit, aot: app.aot === true, directory, framework: app.framework, entry: app.entry };
    }
    if (dirname(directory) === directory) return { mode: "rust", recursionLimit: 256 };
  }
}
