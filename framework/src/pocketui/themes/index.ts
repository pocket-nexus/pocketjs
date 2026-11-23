// PocketUI themes — the themes PocketUI ships. An application lists the ones
// it offers; any object that meets the Theme contract (core/theme.ts) is one.
import type { Theme } from "../core/theme.ts";
import { AQUA_THEME } from "./aqua.ts";
import { CLASSIC_THEME } from "./classic.ts";
import { LUNA_THEME } from "./luna.ts";
import { POCKET_THEME } from "./pocket.ts";

export { AQUA_THEME } from "./aqua.ts";
export { CLASSIC_THEME } from "./classic.ts";
export { LUNA_THEME } from "./luna.ts";
export { COMPACT_METRICS, DARK, POCKET_THEME, REGULAR_METRICS } from "./pocket.ts";

export const DEFAULT_THEME: Theme = POCKET_THEME;
export const THEMES: readonly Theme[] = [POCKET_THEME, CLASSIC_THEME, LUNA_THEME, AQUA_THEME];

export function themeById(id: string | undefined): Theme {
  return THEMES.find((theme) => theme.id === id) ?? DEFAULT_THEME;
}
