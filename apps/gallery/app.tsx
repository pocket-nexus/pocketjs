// apps/gallery/app.tsx — "gallery" showcase: full-screen, screen-by-screen
// paging driven by the L / R shoulder triggers, over baked bitmap tiles.
//
// Built from three reusable framework components (all new, in framework/src/components.ts):
//   - <Gallery> slides one whole screen per LTRIGGER/RTRIGGER press. Its strip's
//     translateX is animated once per press and ticked natively (paint-only, no
//     relayout), so paging stays fluid within the PSP draw budget.
//   - <Grid> lays each page's tiles out as a wrapping row and hands them
//     row/column d-pad traversal (FocusGrid, columns=3).
//   - <Lazy> reveals a page's content ON DEMAND: a page mounts only inside the
//     Gallery's +/-1 window and shows a spinner the first time it is built,
//     then its tiles. Because in-window neighbours are prefetched, paging is
//     smooth (the outgoing page keeps its tiles as it slides off), while pages
//     farther than one away are never in the native tree at all.
//
// Honest note: the tile textures are uploaded eagerly at pak load — the reveal
// models on-demand *content build*, not texture residency. The genuine saving
// is the windowing: a far-off page costs zero nodes/quads.
//
// Every class is a FULL literal and all UI copy is ASCII (Inter has no CJK).

import {
  ActionBar,
  FocusScope,
  Gallery,
  Grid,
  Lazy,
  Screen,
  Sprite,
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/components";
import { createSignal, onMount } from "solid-js";
import { focusNode } from "@pocketjs/framework/input";
import { GALLERY_PAGES, TILES_PER_PAGE, TILE_SRCS } from "./tiles.ts";

const REVEAL_FRAMES = 16; // ~0.27s spinner the first time a page is built

// Per-page theme — one hue family per screen (matches gen-assets.ts PAGE_HUE).
const PAGE_TITLE = ["SYNTHWAVE", "GOLDEN HOUR", "EVERGREEN", "NEBULA"];
const PAGE_SUB = ["neon coast drive", "warm analog haze", "deep forest floor", "far outer dark"];
const PAGE_COUNT_LABEL = ["01 / 04", "02 / 04", "03 / 04", "04 / 04"];
const PAGE_BG = [
  "relative flex-col w-full h-full items-center bg-gradient-to-b from-blue-900 to-slate-950",
  "relative flex-col w-full h-full items-center bg-gradient-to-b from-orange-900 to-slate-950",
  "relative flex-col w-full h-full items-center bg-gradient-to-b from-emerald-900 to-slate-950",
  "relative flex-col w-full h-full items-center bg-gradient-to-b from-violet-900 to-slate-950",
];

// prettier-ignore
const TILE_LABEL = [
  "OUTRUN", "NEON", "MIRAGE", "PULSE", "CHROME", "MIDNIGHT",
  "EMBER", "DUSK", "AMBER", "SANDS", "COPPER", "FLARE",
  "FERN", "MOSS", "PINE", "JADE", "TIDE", "GROVE",
  "QUASAR", "COMET", "ORBIT", "VIOLET", "NOVA", "DRIFT",
];

// A framed, focusable thumbnail: the 64x64 texture in a 68px matte that lifts +
// outlines on focus (draw.rs scales the image quad with the frame, glyph cells
// stay crisp). No shadow-md — plain matte + border keeps the per-tile quad
// count low so a full page stays inside the PSP draw budget (docs/DESIGN.md).
const TILE_FRAME =
  "w-[68] h-[68] rounded-lg items-center justify-center bg-slate-900 border-slate-700 focus:scale-110 focus:border-white transition-transform duration-150 ease-out";

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** On-demand loading indicator shown by <Lazy> before a page's tiles reveal. */
function Loading(props: { title: string }) {
  return (
    <View debugName="Loading" class="flex-col items-center justify-center gap-2 grow">
      <Sprite class="w-9 h-9" sprite="spinner-atlas.svg" />
      <Text class="text-xs text-slate-300 tracking-wide">LOADING {props.title}</Text>
    </View>
  );
}

/** The 3x2 tile grid for one page. Seeds focus on the first tile when it mounts
 *  as the current page (the prefetched-neighbour case is handled by the page's
 *  FocusScope autoFocus when it later becomes current). */
function TileGrid(props: {
  page: number;
  current: () => number;
  onSelect: (label: string) => void;
}) {
  const start = props.page * TILES_PER_PAGE;
  const srcs = TILE_SRCS.slice(start, start + TILES_PER_PAGE);
  const refs: (NodeMirror | undefined)[] = [];
  onMount(() => {
    if (props.current() === props.page) focusNode(refs[0] ?? null);
  });
  return (
    <Grid debugName="TileGrid" active columns={3} gap={8} class="flex-row flex-wrap items-start justify-center w-[264]">
      {srcs.map((src, k) => (
        <View class="flex-col items-center gap-1 w-[78]">
          <View
            ref={refs[k]}
            class={TILE_FRAME}
            focusable
            onPress={() => props.onSelect(TILE_LABEL[start + k])}
          >
            <Sprite class="w-[64] h-[64] rounded-lg" sprite={src} />
          </View>
          <Text class="text-xs text-slate-200 font-bold">{TILE_LABEL[start + k]}</Text>
        </View>
      ))}
    </Grid>
  );
}

/** One full-screen page: themed header + the lazily-revealed tile grid. The
 *  FocusScope keeps the d-pad on the current page even though in-window
 *  neighbours are mounted (prefetched) for a seamless slide. */
function Page(props: {
  index: number;
  current: () => number;
  onSelect: (label: string) => void;
}) {
  const isCurrent = () => props.current() === props.index;
  return (
    <View debugName="Page" class={PAGE_BG[props.index]}>
      <View debugName="PageHeader" class="w-full flex-row items-end justify-between px-4 pt-2 pb-1">
        <View class="flex-col">
          <Text class="text-xs text-slate-300 tracking-wide">{PAGE_SUB[props.index]}</Text>
          <Text class="text-xl text-white font-bold">{PAGE_TITLE[props.index]}</Text>
        </View>
        <Text class="text-xs text-slate-300">{PAGE_COUNT_LABEL[props.index]}</Text>
      </View>
      <FocusScope
        active={isCurrent}
        restoreFocus={false}
        class="grow w-full flex-col items-center justify-center"
      >
        <Lazy when={true} reveal={REVEAL_FRAMES} fallback={() => <Loading title={PAGE_TITLE[props.index]} />}>
          {() => <TileGrid page={props.index} current={props.current} onSelect={props.onSelect} />}
        </Lazy>
      </FocusScope>
      {/* reserve room for the portalled hint bar so the bottom row stays clear */}
      <View class="w-full h-9 shrink-0" />
    </View>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function GalleryDemo() {
  const [page, setPage] = createSignal(0);
  const [viewing, setViewing] = createSignal<string | null>(null);

  return (
    <Screen debugName="GalleryScreen" class="relative w-full h-full bg-slate-950 overflow-hidden">
      <Gallery
        count={GALLERY_PAGES}
        page={page}
        onPageChange={(next) => {
          setPage(next);
          setViewing(null);
        }}
        duration={300}
        easing="out"
        renderPage={(i) => <Page index={i} current={page} onSelect={setViewing} />}
      />

      <ActionBar debugName="HintBar" class="absolute left-3 right-3 bottom-2 flex-row items-center justify-between px-3 py-1 rounded-lg shadow-md bg-slate-900 border-slate-700">
        <View debugName="PageDots" class="flex-row items-center gap-2">
          {Array.from({ length: GALLERY_PAGES }).map((_, i) => (
            <View
              class={
                page() === i
                  ? "w-4 h-1 rounded-full bg-white"
                  : "w-1 h-1 rounded-full bg-slate-600"
              }
            />
          ))}
        </View>
        <Text class="text-xs text-slate-400">
          {viewing() ? "VIEWING  " + viewing() : "L / R  FLIP    D-PAD  MOVE    CIRCLE  VIEW"}
        </Text>
      </ActionBar>
    </Screen>
  );
}
