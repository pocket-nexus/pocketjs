// apps/manga/library.ts — pure ordering and filtering for the library list.
//
// The catalog arrives in pack order. The library view re-orders it by reading
// recency (default), title, or unread first, and narrows it by a title query.
// Both are pure so the view and the tests share one definition.

import type { SeriesSummary } from "./model.ts";
import type { Progress } from "./progress.ts";

export type SortMode = "recent" | "title" | "unread";

export function filterSeries(list: readonly SeriesSummary[], query: string): SeriesSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return list.slice();
  return list.filter((series) => series.title.toLowerCase().includes(needle));
}

export function orderSeries(
  list: readonly SeriesSummary[],
  mode: SortMode,
  progress: Progress,
): SeriesSummary[] {
  const out = list.slice();
  const byTitle = (a: SeriesSummary, b: SeriesSummary) => a.title.localeCompare(b.title);
  const updated = (series: SeriesSummary) => progress.series[series.slug]?.updated ?? -1;
  if (mode === "title") out.sort(byTitle);
  else if (mode === "unread")
    out.sort((a, b) => Number(updated(a) >= 0) - Number(updated(b) >= 0) || byTitle(a, b));
  else out.sort((a, b) => updated(b) - updated(a) || byTitle(a, b));
  return out;
}
