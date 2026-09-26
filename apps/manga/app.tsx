// Pocket Manga terminal: companion catalog + persistent local renditions.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { AuxiliarySurface, Screen, Text, View } from "@pocketjs/framework/components";
import { ResourceImage } from "@pocketjs/framework/resource";
import { createResourceRuntime, createResourceView } from "@pocketjs/framework/resource-view";
import { createPackedImageCollection, resourcePacks } from "./pack-client.ts";
import { createMangaConnection } from "./client.ts";
import { mangaTransport } from "./transport.ts";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { createGesture } from "@pocketjs/framework/gesture";
import { createOsk, Osk } from "@pocketjs/framework/osk";
import { BTN } from "@pocketjs/framework/input";
import {
  chapterAt,
  COVER,
  INDEX_PACK,
  packOf,
  SERIES_ENTRY_COVER,
  SERIES_ENTRY_META,
  seriesPackName,
  TILE,
  type LibraryIndex,
  type ChapterMeta,
  type SeriesMeta,
  type SeriesSummary,
  type TileAddress,
} from "./model.ts";
import { PageViewer, type ViewerDemand, type ViewMode } from "./viewer.ts";
import {
  emptyProgress,
  isBookmarked,
  isChapterRead,
  markChapterRead,
  resumePage,
  toggleBookmark,
  withPage,
  type Progress,
} from "./progress.ts";
import { filterSeries, orderSeries, type SortMode } from "./library.ts";
import { loadProgress, saveProgress, stateAvailable, deviceIdentity } from "./state.ts";

const VIEW_W = 400;
const VIEW_H = 240;
/** The lower touch screen. Gesture coordinates and the grid layout use it. */
const AUX_W = 320;
const AUX_H = 240;
/** Library cover grid: 3 columns x 2 rows per page. */
const GRID_COLS = 3;
const GRID_ROWS = 2;
const GRID_SIZE = GRID_COLS * GRID_ROWS;
/** Chapter rows visible on the lower screen at once. */
const CH_ROWS = 6;
/** Header strip (title / screen label) height on the lower screen. */
const AUX_HEADER = 28;

type ScreenName = "library" | "series" | "reader";
type ThemeName = "night" | "paper";
const VIEW_MODES: readonly ViewMode[] = ["width", "page", "native"];
const SORT_MODES: readonly SortMode[] = ["recent", "title", "unread"];

export default function Manga() {
  const packs = resourcePacks();
  const transport = mangaTransport();
  const [online, setOnline] = createSignal(false);
  const [cacheError, setCacheError] = createSignal("");
  const [downloadLabel, setDownloadLabel] = createSignal("");
  const [removeArmed, setRemoveArmed] = createSignal(false);
  const [downloading, setDownloading] = createSignal(false);
  const [savedPacks, setSavedPacks] = createSignal<Record<string, boolean>>({});
  const [metaError, setMetaError] = createSignal("");
  const connection = createMangaConnection({ local: packs, remote: transport.remote, cache: transport.cache, onCacheError: setCacheError });
  const [index, setIndex] = createSignal<LibraryIndex>();
  const [indexError, setIndexError] = createSignal<string>();
  const [screen, setScreen] = createSignal<ScreenName>("library");
  const [activeSummary, setActiveSummary] = createSignal<SeriesSummary>();
  const [selected, setSelected] = createSignal(0);
  const [pageStatus, setPageStatus] = createSignal("");
  const [page, setPage] = createSignal(0);
  const [chapterSel, setChapterSel] = createSignal(0);
  const [progress, setProgress] = createSignal<Progress>(emptyProgress());
  // Bumped on every series open; the chapter default waits for the full meta.
  const [openToken, setOpenToken] = createSignal(0);
  // M3e: reading framing, library order, title search and palette.
  const [viewMode, setViewMode] = createSignal<ViewMode>("width");
  const [sortMode, setSortMode] = createSignal<SortMode>("recent");
  const [query, setQuery] = createSignal("");
  const [searchDraft, setSearchDraft] = createSignal("");
  const [theme, setTheme] = createSignal<ThemeName>("night");
  const osk = createOsk({
    value: searchDraft,
    setValue: setSearchDraft,
    onCommit: (text) => setQuery(text.trim()),
    onClose: () => setSearchDraft(query()),
  });

  // The viewer publishes its per-frame tile demand here; the collection's
  // planner reads it on its own frame hook.
  let readerDemand: ViewerDemand[] = [];
  // A monotonic tick for `updated`, and the throttled save bookkeeping.
  let frameClock = 0;
  let progressDirty = false;
  let saveCountdown = 0;

  let indexLoading = false, observedSession = 0;
  async function refreshIndex(origin: "local" | "remote") {
    if (indexLoading) return;
    indexLoading = true;
    try {
      const result = await connection.index(origin);
      const slug = untrack(current)?.slug;
      setIndex(result); setIndexError(undefined);
      if (slug) { const next = series().findIndex(s => s.slug === slug); if (next >= 0) setSelected(next); }
    } catch (error) {
      setIndexError(origin === "local" ? "No saved library. Start Pocket Manga companion to import and sync." : `Refresh failed: ${String(error)}. SELECT to retry.`);
    } finally { indexLoading = false; }
  }
  function flushProgress() {
    if (!progressDirty) return;
    if (saveProgress(progress())) { progressDirty = false; setCacheError(""); }
    else if (stateAvailable()) setCacheError("Progress save failed. Check SD space.");
  }
  onMount(() => {
    const saved = loadProgress(); setProgress(saved);
    frameClock = Math.max(Date.now(), ...Object.values(saved.series).map(p => p.updated));
    void refreshIndex("local");
  });
  onCleanup(() => { flushProgress(); connection.dispose(); transport.close(); });

  // One shared budget for library covers and page tiles. maxCollections is 2.
  const runtime = createResourceRuntime({
    maxConcurrent: 4,
    startsPerFrame: 1,
    completionsPerFrame: 1,
    maxCollections: 2,
  });
  const covers = createPackedImageCollection(runtime, {
    key: (t: TileAddress) => `${t.pack}/${t.entry}`,
    pack: (t: TileAddress) => ({ name: t.pack, entry: t.entry }),
    width: COVER,
    height: COVER,
    fallback: connection.imageClient ? { client: connection.imageClient, method: "manga.image", payload: (t: TileAddress) => `${t.pack}/${t.entry}` } : undefined,
    maxEntries: 16,
    maxViews: 1,
    maxDemandsPerView: 16,
  });
  const pages = createPackedImageCollection(runtime, {
    key: (t: TileAddress) => `${t.pack}/${t.entry}`,
    pack: (t: TileAddress) => ({ name: t.pack, entry: t.entry }),
    width: TILE,
    height: TILE,
    fallback: connection.imageClient ? { client: connection.imageClient, method: "manga.image", payload: (t: TileAddress) => `${t.pack}/${t.entry}` } : undefined,
    maxEntries: 28,
    maxViews: 1,
    maxDemandsPerView: 64,
  });

  // The catalog is filtered by the title query, then ordered: recently read
  // first (default), by title, or unread first. Progress drives "read".
  const series = createMemo<SeriesSummary[]>(() =>
    orderSeries(filterSeries(index()?.series ?? [], query()), sortMode(), progress()),
  );
  const current = createMemo<SeriesSummary | undefined>(() => screen() === "library" ? series()[selected()] : activeSummary());

  // Filtering can shrink the list under the cursor; keep it in range.
  createEffect(() => {
    if (selected() >= series().length) setSelected(Math.max(0, series().length - 1));
  });

  // The index is only the catalog; the full per-series record (geometry +
  // metadata) lives at entry 0 of the series pack and is read on open.
  const [metas, setMetas] = createSignal<Record<string, SeriesMeta>>({});
  const inflight = new Set<string>();
  function loadMeta(summary: SeriesSummary) {
    const key = packOf(summary);
    if (metas()[key] || inflight.has(key)) return;
    inflight.add(key); setMetaError("");
    void connection.meta(summary).then(meta => setMetas(all => {
      const keep = Object.entries(all).filter(([name]) => name !== key).slice(-3);
      return { ...Object.fromEntries(keep), [key]: meta };
    }))
      .catch(error => { if (current() && packOf(current()!) === key) setMetaError(String(error)); }).finally(() => inflight.delete(key));
    void connection.downloaded(summary).then(saved => setSavedPacks(all => ({ ...all, [key]: saved })));
  }
  async function downloadCurrent() {
    if (downloading()) { connection.cancelDownload(); setDownloadLabel("Cancelling download..."); return; }
    const summary = current(); if (!summary) return;
    setDownloading(true); setCacheError("");
    try {
      await connection.download(summary, (done, total) => setDownloadLabel(`SAVING OFFLINE ${Math.floor(done * 100 / total)}%`));
      setSavedPacks(all => ({ ...all, [packOf(summary)]: true })); setDownloadLabel("SAVED FOR OFFLINE");
    } catch (error) { setDownloadLabel(String(error)); }
    finally { setDownloading(false); }
  }
  const fullMeta = createMemo<SeriesMeta | undefined>(() => {
    const summary = current();
    return summary ? metas()[packOf(summary)] : undefined;
  });

  const gridStart = createMemo(() => Math.floor(selected() / GRID_SIZE) * GRID_SIZE);
  const chapterWindowStart = createMemo(() => {
    const chapters = fullMeta()?.chapters;
    if (!chapters) return 0;
    return Math.min(
      Math.max(0, chapterSel() - Math.floor(CH_ROWS / 2)),
      Math.max(0, chapters.length - CH_ROWS),
    );
  });

  const coverInputs = createMemo<TileAddress[]>(() => {
    if (screen() === "reader") return [];
    if (screen() === "series" && activeSummary()) return [{ pack: packOf(activeSummary()!), entry: SERIES_ENTRY_COVER }];
    const list = series();
    const seen = new Set<number>();
    const out: TileAddress[] = [];
    const push = (i: number) => {
      if (i < 0 || i >= list.length || seen.has(i)) return;
      seen.add(i);
      out.push({ pack: packOf(list[i]!), entry: SERIES_ENTRY_COVER });
    };
    const center = Math.min(selected(), Math.max(0, list.length - 1));
    for (let i = Math.max(0, center - 3); i <= Math.min(list.length - 1, center + 3); i++) push(i);
    if (screen() === "library") for (let i = gridStart(); i < gridStart() + GRID_SIZE; i++) push(i);
    return out;
  });

  const coverView = createResourceView(covers, {
    demand: () => coverInputs().map((input) => ({ input, priority: 0 })),
  });
  const pageView = createResourceView(pages, {
    demand: () => readerDemand,
  });

  const gridCells = createMemo(() => {
    const list = series();
    const start = gridStart();
    const out: { index: number; summary: SeriesSummary }[] = [];
    for (let i = start; i < Math.min(list.length, start + GRID_SIZE); i++) {
      out.push({ index: i, summary: list[i]! });
    }
    return out;
  });
  const chapterRows = createMemo(() => {
    const chapters = fullMeta()?.chapters;
    if (!chapters) return [];
    const start = chapterWindowStart();
    const out: { index: number; chapter: ChapterMeta }[] = [];
    for (let i = start; i < Math.min(chapters.length, start + CH_ROWS); i++) {
      out.push({ index: i, chapter: chapters[i]! });
    }
    return out;
  });

  // stats() reads plain counters, so it has no reactive dependency to wake the
  // aux text. Poll it on a slow frame interval into a signal instead.
  const [cacheStats, setCacheStats] = createSignal({ ready: 0, entries: 0, cover: 0 });
  let statFrames = 0;
  let progressSyncBusy = false;
  const synced: Record<string, number> = Object.create(null);
  onFrame(() => {
    frameClock += 1;
    connection.step();
    if (statFrames % 30 === 0) {
      setOnline(connection.connected());
      const session = connection.session();
      if (session > 0 && session !== observedSession && !indexLoading) {
        observedSession = session; void refreshIndex("remote");
      } else if (session <= 0 && observedSession > 0 && !indexLoading) {
        observedSession = 0; void refreshIndex("local");
      }
    }
    // Throttle saves: SD writes are slow enough to hitch a frame, and losing
    // at most a second of progress is acceptable.
    if (progressDirty && ++saveCountdown >= 30) {
      saveCountdown = 0;
      flushProgress();
    }
    if (connection.connected() && statFrames % 120 === 0 && !progressSyncBusy) {
      const entry = Object.entries(progress().series).find(([slug, value]) => value.updated > (synced[slug] ?? -1));
      if (entry) {
        progressSyncBusy = true;
        const [slug, value] = entry;
        void connection.syncProgress(deviceIdentity(), slug, value).then(() => { synced[slug] = value.updated; })
          .catch(() => {}).finally(() => { progressSyncBusy = false; });
      }
    }
    if (++statFrames % 30 !== 0) return;
    const page = pages.stats();
    setCacheStats({ ready: page.ready, entries: page.entries, cover: covers.stats().ready });
  });

  function commit(reduce: (previous: Progress) => Progress) {
    setProgress((previous) => {
      const next = reduce(previous);
      if (next !== previous) progressDirty = true;
      return next;
    });
  }

  // When a series opens, point the chapter cursor at the last read chapter.
  let chapterInitToken = -1;
  createEffect(() => {
    const token = openToken();
    const meta = fullMeta();
    if (!meta || token === chapterInitToken) return;
    chapterInitToken = token;
    setChapterSel(chapterAt(meta, resumePage(progress(), meta))?.index ?? 0);
  });

  // Record the page while reading, and mark a chapter read once its last page
  // is reached. commit() only flags a save, so this stays off the frame path.
  createEffect(() => {
    const meta = fullMeta();
    const current = screen();
    const at = page();
    if (!meta || current !== "reader") return;
    const span = chapterAt(meta, at);
    untrack(() => {
      commit(previous => withPage(previous, meta.slug, at, ++frameClock));
      if (span && at >= span.end - 1) commit(previous => markChapterRead(previous, meta.slug, span.index, frameClock));
    });
  });

  function openSeries(i: number) {
    const summary = series()[i];
    if (!summary) return;
    setSelected(i);
    setPage(0);
    setActiveSummary(summary);
    setDownloadLabel(""); setRemoveArmed(false);
    loadMeta(summary);
    setScreen("series");
    setOpenToken((token) => token + 1);
  }
  function openReader(start = 0) {
    if (!fullMeta()) return;
    setPage(Math.max(0, Math.min(start, fullMeta()!.pages - 1)));
    setScreen("reader");
  }
  /** Start the selected chapter; resume its saved page when it is the last
   *  chapter read, otherwise start at the chapter's first page. */
  function startChapter(index: number) {
    const meta = fullMeta();
    if (!meta) return;
    const resume = resumePage(progress(), meta);
    const same = chapterAt(meta, resume)?.index === index;
    openReader(same ? resume : meta.chapters?.[index]?.page ?? 0);
  }
  function toggleCurrentBookmark() {
    const meta = fullMeta();
    if (meta) commit((previous) => toggleBookmark(previous, meta.slug, page(), frameClock));
  }
  function cycleViewMode() {
    setViewMode(VIEW_MODES[(VIEW_MODES.indexOf(viewMode()) + 1) % VIEW_MODES.length]!);
  }
  function cycleSort() {
    setSortMode(SORT_MODES[(SORT_MODES.indexOf(sortMode()) + 1) % SORT_MODES.length]!);
  }
  function openSearch() {
    setSearchDraft(query());
    osk.open();
  }
  function nextPage() {
    const meta = fullMeta();
    if (meta && page() + 1 < meta.pages) setPage(page() + 1);
  }
  function prevPage() {
    if (page() > 0) setPage(page() - 1);
  }

  onButtonPress(BTN.UP, () => {
    if (osk.isOpen()) return;
    if (screen() === "library") setSelected((s) => Math.max(0, s - 1));
    else if (screen() === "series" && fullMeta()?.chapters)
      setChapterSel((s) => Math.max(0, s - 1));
  });
  onButtonPress(BTN.DOWN, () => {
    if (osk.isOpen()) return;
    if (screen() === "library") setSelected((s) => Math.max(0, Math.min(series().length - 1, s + 1)));
    else if (screen() === "series" && fullMeta()?.chapters)
      setChapterSel((s) => Math.min((fullMeta()!.chapters!.length - 1), s + 1));
  });
  onButtonPress(BTN.CIRCLE, () => {
    if (osk.isOpen()) return;
    if (screen() === "library") openSeries(selected());
    else if (screen() === "series") startChapter(chapterSel());
  });
  onButtonPress(BTN.CROSS, () => {
    if (osk.isOpen()) return;
    flushProgress();
    if (screen() === "reader") setScreen("series");
    else if (screen() === "series") {
      const at = series().findIndex(s => s.slug === activeSummary()?.slug);
      if (at >= 0) setSelected(at);
      setScreen("library");
    }
  });
  onButtonPress(BTN.RTRIGGER, () => screen() === "reader" && nextPage());
  onButtonPress(BTN.LTRIGGER, () => screen() === "reader" && prevPage());
  onButtonPress(BTN.SELECT, () => {
    if (osk.isOpen()) return;
    if (screen() === "reader") toggleCurrentBookmark();
    else if (screen() === "series") void downloadCurrent();
    else void refreshIndex(connection.connected() ? "remote" : "local");
  });
  // M3e: SQUARE cycles the reader framing (theme elsewhere), START cycles the
  // library order, TRIANGLE opens the title search from the library.
  onButtonPress(BTN.SQUARE, () => {
    if (osk.isOpen()) return;
    if (screen() === "reader") cycleViewMode();
    else setTheme((current) => (current === "night" ? "paper" : "night"));
  });
  onButtonPress(BTN.START, () => {
    if (osk.isOpen()) return;
    if (screen() === "library") cycleSort();
    else if (screen() === "series" && current() && !downloading()) {
      if (!removeArmed()) { setRemoveArmed(true); setDownloadLabel("START again: remove offline copy"); return; }
      setRemoveArmed(false);
      const summary = current()!;
      setDownloading(true);
      void connection.removeDownload(summary).then(() => {
        setSavedPacks(all => ({ ...all, [packOf(summary)]: false })); setDownloadLabel("Offline copy removed");
      }).catch(error => setDownloadLabel(String(error))).finally(() => setDownloading(false));
    }
  });
  onButtonPress(BTN.TRIANGLE, () => {
    if (osk.isOpen()) return;
    if (screen() === "library") openSearch();
    else if (screen() === "series" && current()) loadMeta(current()!);
  });

  // Lower-screen taps mirror the d-pad: a cover cell selects (tapping the
  // selected one opens), a chapter row reads, and the header line goes back.
  // During reading the region is null, so the reader's own gestures own the
  // surface.
  createGesture({
    surface: "auxiliary",
    region: {
      rect: () => (screen() === "reader" || osk.isOpen() ? null : { x: 0, y: 0, w: AUX_W, h: AUX_H }),
    },
    onTap: (c) => {
      const name = screen();
      if (name === "library") {
        if (!index()) return;
        if (c.y < AUX_HEADER) {
          if (c.x > AUX_W / 2) cycleSort();
          else openSearch();
          return;
        }
        const list = series();
        const col = Math.min(GRID_COLS - 1, Math.floor(c.x / (AUX_W / GRID_COLS)));
        const row = Math.min(
          GRID_ROWS - 1,
          Math.floor((c.y - AUX_HEADER) / ((AUX_H - AUX_HEADER) / GRID_ROWS)),
        );
        const pick = gridStart() + row * GRID_COLS + col;
        if (pick >= list.length) return;
        if (pick === selected()) openSeries(pick);
        else setSelected(pick);
        return;
      }
      if (name !== "series") return;
      const meta = fullMeta();
      if (!meta) return;
      if (c.y < AUX_HEADER) {
        setScreen("library");
        return;
      }
      if (!meta.chapters) {
        startChapter(0);
        return;
      }
      const row = Math.min(CH_ROWS - 1, Math.floor((c.y - AUX_HEADER) / ((AUX_H - AUX_HEADER) / CH_ROWS)));
      const pick = chapterWindowStart() + row;
      if (pick >= meta.chapters.length) return;
      setChapterSel(pick);
      startChapter(pick);
    },
  });

  // Two palettes for the surrounding chrome; the reader picture is unchanged.
  // Each helper returns a whole class literal (the build harvests literals).
  const night = () => theme() === "night";
  const tScreen = () =>
    night() ? "relative w-full h-full bg-slate-950 overflow-hidden" : "relative w-full h-full bg-[#efe4cc] overflow-hidden";
  const tLibrary = () =>
    night() ? "flex-row w-full h-full bg-slate-900" : "flex-row w-full h-full bg-[#ece0c6]";
  const tListPanel = () =>
    night() ? "flex-col w-[232] h-full p-2 gap-1 bg-slate-800" : "flex-col w-[232] h-full p-2 gap-1 bg-[#ded0ad]";
  const tCard = () => (night() ? "px-2 py-1 rounded-md bg-slate-800" : "px-2 py-1 rounded-md bg-[#fffdf6]");
  const tCardTitle = () => (night() ? "text-sm text-white" : "text-sm text-[#2a2214]");
  const tCardSub = () => (night() ? "text-xs text-slate-400" : "text-xs text-[#7a6a4c]");
  const tMuted = () => (night() ? "text-xs text-slate-400" : "text-xs text-[#7a6a4c]");
  const tPanel = () => (night() ? "flex-col w-full h-full bg-slate-900 overflow-hidden" : "flex-col w-full h-full bg-[#ece0c6] overflow-hidden");
  const tPanelAlt = () =>
    night() ? "h-[28] flex-row items-center justify-between px-2 bg-slate-800" : "h-[28] flex-row items-center justify-between px-2 bg-[#ded0ad]";

  const viewModeLabel = () =>
    viewMode() === "width" ? "FIT WIDTH" : viewMode() === "page" ? "FIT PAGE" : "1:1";
  const sortLabel = () =>
    sortMode() === "recent" ? "RECENT" : sortMode() === "title" ? "TITLE" : "UNREAD";

  const auxTitle = () => fullMeta()?.title ?? current()?.title ?? (screen() === "library" ? "Library" : "");
  const auxBadge = () => {
    if (screen() === "reader") {
      const meta = fullMeta();
      return meta ? `${page() + 1} / ${meta.pages}  ${viewModeLabel()}` : "";
    }
    if (screen() === "series") {
      const meta = fullMeta();
      return meta?.chapters ? `${meta.chapters.length} chapter(s)` : "1 chapter";
    }
    const total = Math.max(1, Math.ceil(series().length / GRID_SIZE));
    const search = query() ? `  "${query()}"` : "";
    return `${sortLabel()}  ${Math.floor(selected() / GRID_SIZE) + 1}/${total}${search}`;
  };
  const readerProgress = () => {
    const meta = fullMeta();
    if (!meta || meta.pages <= 0) return 0;
    return Math.min(AUX_W, Math.round(((page() + 1) / meta.pages) * AUX_W));
  };
  const auxHint = () => {
    if (screen() === "reader") {
      const meta = fullMeta();
      const dir = meta ? (meta.direction === "rtl" ? "RIGHT-TO-LEFT" : "LEFT-TO-RIGHT") : "";
      return `TOUCH: tap sides page, drag pan, pinch zoom  |  SQUARE mode  ZL/ZR zoom  TRIANGLE fit  L/R page  SELECT bookmark (${dir})`;
    }
    if (screen() === "series") {
      if (!fullMeta()) return metaError() ? `${metaError()} | TRIANGLE retry` : "LOADING SERIES METADATA...";
      return fullMeta()!.chapters
        ? "TAP a chapter to read   |   UP/DOWN chapter   A/CIRCLE read   B/CROSS back"
        : "TAP to read   |   A / CIRCLE  read      B / CROSS  back";
    }
    return indexError()
      ? indexError()!
      : "TAP cover select/open, header left search, right sort   |   UP/DOWN + A";
  };

  const readerLabel = () => {
    const meta = fullMeta();
    if (!meta) return "";
    const span = chapterAt(meta, page());
    if (!span) return `${page() + 1} / ${meta.pages}`;
    return `${span.title}  ${page() - span.start + 1} / ${span.end - span.start}`;
  };

  const libraryWindow = createMemo(() => {
    const list = series(), start = Math.max(0, Math.min(selected() - 2, list.length - 4));
    return list.slice(start, start + 4).map((summary, n) => ({ summary, index: start + n }));
  });

  const coverState = (summary: SeriesSummary, side: number) => {
    const state = coverView.state({ pack: packOf(summary), entry: SERIES_ENTRY_COVER });
    return state.status === "ready"
      ? { ...state, value: { ...state.value, width: side, height: side } } : state;
  };

  const creditLine = (meta: SeriesMeta) =>
    [meta.author, meta.publisher, meta.year ? String(meta.year) : undefined].filter(Boolean).join("  |  ");
  const clampText = (text: string, max = 170) =>
    text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;

  return (
    <>
      <Screen class={tScreen()}>
        <Show when={!osk.isOpen()}>
        <Show when={screen() !== "reader"}>
          <View class={tLibrary()}>
            <View class={tListPanel()}>
              <Show
                when={screen() === "series" ? fullMeta()?.chapters : undefined}
                fallback={
                  <>
                    <Text class="text-xs text-slate-500">{online() ? "COMPANION ONLINE" : "OFFLINE LIBRARY"}</Text>
                    <Show when={index()} fallback={<Text class={tMuted()}>{indexError() ?? "LOADING LIBRARY..."}</Text>}>
                      <For each={libraryWindow()}>
                        {({ summary: s, index: i }) => (
                          <View class={i === selected() ? "px-2 py-1 rounded-md bg-blue-600" : tCard()}>
                            <Text class={i === selected() ? "text-sm text-white" : tCardTitle()}>
                              {s.title}
                            </Text>
                            <Text class={i === selected() ? "text-xs text-blue-100" : tCardSub()}>
                              {s.pages} pages
                              {progress().series[s.slug] ? `  p.${progress().series[s.slug]!.page + 1}` : ""}
                            </Text>
                          </View>
                        )}
                      </For>
                    </Show>
                  </>
                }
              >
                {(chapters) => (
                  <>
                    <Text class="text-xs text-slate-500">CHAPTERS</Text>
                    <For each={chapterRows()}>
                      {({ chapter, index: i }) => (
                        <View class={i === chapterSel() ? "px-2 py-1 rounded-md bg-blue-600" : tCard()}>
                          <Text class={i === chapterSel() ? "text-sm text-white" : tCardTitle()}>
                            {chapter.title}
                          </Text>
                          <Text class={i === chapterSel() ? "text-xs text-blue-100" : tCardSub()}>
                            {isChapterRead(progress(), fullMeta()!.slug, i) ? "read" : "unread"}
                          </Text>
                        </View>
                      )}
                    </For>
                  </>
                )}
              </Show>
            </View>

            <View class="grow flex-col items-center justify-center gap-1 px-3">
              <Show when={current()} keyed>
                {(summary) => (
                  <>
                    <ResourceImage
                      class="w-[112] h-[112]"
                      state={() => coverState(summary, 112)}
                      fallback={() => <View class="w-[112] h-[112] bg-slate-300" />}
                    />
                    <Text
                      class={
                        night()
                          ? "text-base text-white font-bold"
                          : "text-base text-[#2a2214] font-bold"
                      }
                    >
                      {summary.title}
                    </Text>
                    <Show
                      when={screen() === "series" ? fullMeta() : undefined}
                      keyed
                      fallback={
                        <>
                          <Text class={tMuted()}>{summary.pages} pages</Text>
                          <Text class={tMuted()}>
                            {screen() === "series" ? (metaError() || "LOADING METADATA...") : "CIRCLE  OPEN"}
                          </Text>
                        </>
                      }
                    >
                      {(meta) => (
                        <>
                          <Text class="text-xs text-blue-500">{savedPacks()[packOf(meta)] ? "SAVED OFFLINE" : "SELECT: SAVE | START: REMOVE"}</Text>
                          <Text class={tMuted()}>{creditLine(meta) || "\u00a0"}</Text>
                          <Text class={tMuted()}>
                            {meta.pages} pages | {meta.levels.length} zoom level(s)
                          </Text>
                          <Show when={meta.genres} keyed>
                            {(genres) => <Text class={tMuted()}>{genres.join(", ")}</Text>}
                          </Show>
                          <Show when={meta.summary} keyed>
                            {(text) => <Text class={tMuted()}>{clampText(text)}</Text>}
                          </Show>
                          <Show when={progress().series[meta.slug]} keyed>
                            {(entry) => (
                              <Text class="text-xs text-blue-500">
                                CONTINUE  p.{entry.page + 1} / {meta.pages}
                                {entry.bookmarks.length ? `  (${entry.bookmarks.length} bookmark)` : ""}
                              </Text>
                            )}
                          </Show>
                          <Text class={night() ? "text-xs text-slate-400 mt-1" : "text-xs text-[#7a6a4c] mt-1"}>
                            {progress().series[meta.slug] ? "CIRCLE  CONTINUE" : "CIRCLE  START READING"}
                          </Text>
                        </>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            </View>
          </View>
        </Show>

        <Show when={screen() === "reader" && fullMeta()} keyed>
          {(meta) => (
            <View class={night() ? "relative w-full h-full bg-black overflow-hidden" : "relative w-full h-full bg-[#e9dcc0] overflow-hidden"}>
              <PageViewer
                meta={meta}
                page={page()}
                view={pageView}
                width={VIEW_W}
                height={VIEW_H}
                mode={viewMode()}
                onStatus={(ready, total, failed) => setPageStatus(ready >= total ? "" : failed ? (online() ? "Page unavailable. Reopen to retry." : "Page not fully cached. Connect companion to download.") : "LOADING PAGE...")}
                onDemand={(list) => {
                  readerDemand = list;
                }}
                onPage={(delta) => (delta > 0 ? nextPage() : prevPage())}
              />
              <Show when={pageStatus()}>
                <View class="absolute left-2 bottom-2 px-2 py-1 bg-[#000000cc]">
                  <Text class="text-xs text-white">{pageStatus()}</Text>
                </View>
              </Show>
              <View class="absolute right-2 top-2 px-2 py-1 rounded bg-[#000000aa]">
                <Text class="text-xs text-white">
                  {readerLabel()}
                  {isBookmarked(progress(), meta.slug, page()) ? "  *" : ""}
                </Text>
              </View>
              <View class="absolute left-0 bottom-0 w-full h-[4] bg-[#00000066]">
                <View
                  class="h-[4] bg-blue-400"
                  style={{ width: Math.round(((page() + 1) / meta.pages) * VIEW_W) }}
                />
              </View>
            </View>
          )}
        </Show>
        </Show>
        <Show when={osk.isOpen()}>
          <View class="grow flex-col w-full px-3 pt-3 gap-1">
            <Text class={night() ? "text-sm text-white" : "text-sm text-[#2a2214]"}>
              SEARCH  {osk.display()}
            </Text>
            <Text class={tMuted()}>Type a title, then START to search. B / CROSS cancels.</Text>
            <Text class={tMuted()}>{series().length} match(es)</Text>
          </View>
        </Show>
        <Osk osk={osk} theme={night() ? "dark" : "light"} />
      </Screen>

      <AuxiliarySurface>
        <View class={tPanel()}>
          <View class={tPanelAlt()}>
            <Text class="text-xs text-blue-500">{auxTitle()}</Text>
            <Text class={tMuted()}>{auxBadge()}</Text>
          </View>

          <Show when={screen() === "library"}>
            <View class="flex-row flex-wrap w-full">
              <For each={gridCells()}>
                {(cell) => (
                  <View
                    class={
                      cell.index === selected()
                        ? "w-[106] h-[106] flex-col items-center justify-center gap-1 bg-blue-600"
                        : night()
                          ? "w-[106] h-[106] flex-col items-center justify-center gap-1 bg-slate-800"
                          : "w-[106] h-[106] flex-col items-center justify-center gap-1 bg-[#fffdf6]"
                    }
                  >
                    <ResourceImage
                      class="w-[76] h-[76]"
                      state={() => coverState(cell.summary, 76)}
                      fallback={() => <View class="w-[76] h-[76] bg-slate-600" />}
                    />
                    <Text
                      class={
                        cell.index === selected()
                          ? "text-xs text-white px-1"
                          : night()
                            ? "text-xs text-white px-1"
                            : "text-xs text-[#2a2214] px-1"
                      }
                    >
                      {clampText(cell.summary.title, 22)}
                    </Text>
                  </View>
                )}
              </For>
            </View>
          </Show>

          <Show when={screen() === "series"}>
            <View class="flex-col w-full">
              <For each={chapterRows()}>
                {(row) => (
                  <View
                    class={
                      row.index === chapterSel()
                        ? "h-[35] flex-row items-center justify-between px-2 bg-blue-600"
                        : night()
                          ? "h-[35] flex-row items-center justify-between px-2 bg-slate-800"
                          : "h-[35] flex-row items-center justify-between px-2 bg-[#fffdf6]"
                    }
                  >
                    <Text
                      class={
                        row.index === chapterSel()
                          ? "text-sm text-white"
                          : night()
                            ? "text-sm text-slate-200"
                            : "text-sm text-[#2a2214]"
                      }
                    >
                      {clampText(row.chapter.title, 30)}
                    </Text>
                    <Text class={tMuted()}>
                      {isChapterRead(progress(), fullMeta()!.slug, row.index) ? "read" : "p.*"}
                    </Text>
                  </View>
                )}
              </For>
            </View>
          </Show>

          <Show when={screen() === "reader"}>
            <View class="flex-col w-full px-3 pt-3 gap-2">
              <Text class={night() ? "text-sm text-white" : "text-sm text-[#2a2214]"}>{readerLabel()}</Text>
              <View class="w-full h-[8] bg-slate-700">
                <View class="h-[8] bg-blue-500" style={{ width: readerProgress() }} />
              </View>
              <Text class={night() ? "text-xs text-slate-300" : "text-xs text-[#7a6a4c]"}>{auxHint()}</Text>
            </View>
          </Show>

          <View class="grow" />
          <Show when={screen() !== "reader"}>
            <View class="flex-col px-2 pb-1 gap-1">
              <Text class={night() ? "text-xs text-slate-300" : "text-xs text-[#7a6a4c]"}>{auxHint()}</Text>
              <Text class={tMuted()}>
                {cacheError() || downloadLabel() || (online() ? "COMPANION ONLINE | SELECT refresh / save" : "OFFLINE | Saved pages available")}
              </Text>
            </View>
          </Show>
        </View>
      </AuxiliarySurface>
    </>
  );
}
