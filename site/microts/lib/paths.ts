import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../../.."); // repo root
export const SITE = join(ROOT, "site/microts");
export const OUT = join(SITE, "dist");
/** Gitignored scratch space: the pinned pocket-retro checkout and the files generated from it. */
export const CACHE = join(SITE, ".cache");
/** Generated from pocket-retro: sdk/, games/<id>/game.ts, catalog.json and public/ (assets, posters). */
export const RETRO_OUT = join(CACHE, "retro");
