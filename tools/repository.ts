import { resolve } from "node:path";

/** Source root shared by program builders in this checkout. */
export const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
export const repositoryPath = (...parts: string[]): string => resolve(REPOSITORY_ROOT, ...parts);
