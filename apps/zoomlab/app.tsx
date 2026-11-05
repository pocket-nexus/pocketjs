// Zoom Lab — the DeepZoom engine's first-party demo: pans and zooms two
// synthetic pages baked by gen-assets.ts into TILESET pyramids and streamed
// by the DeepZoom engine component. Controls:
//
//   analog nub / d-pad  pan          R / L trigger  zoom in / out
//   TRIANGLE / SQUARE   next / prev page            CROSS  fit page
//
// Everything on screen is a baked tile: the poster's rings, cards, numbered
// cells and gradient bar are rasterized offline — no runtime drawing, no
// fonts, no network. (The real-world cousin of this demo, the Figma viewer,
// lives at github.com/pocket-nexus/pocket-figma.)

import { createSignal } from "solid-js";
import { DeepZoom, Text, View, type DeepZoomView, type TileDoc } from "@pocketjs/framework/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import * as hot from "@pocketjs/framework/hot";
import type { NodeMirror } from "@pocketjs/framework";
import { BTN } from "../../contracts/spec/spec.ts";
import { PAGES, TILE } from "./tiles.ts";

/** Baked manifest -> the DeepZoom engine's document shape. */
const DOCS: TileDoc[] = PAGES.map((p) => ({
  name: p.name,
  w: p.w,
  h: p.h,
  bg: p.bg,
  tile: TILE,
  levels: p.levels,
}));

export default function App() {
  const [page, setPage] = createSignal(0);
  let zoomLabel: NodeMirror | undefined;

  onButtonPress(BTN.TRIANGLE, () => setPage((p) => (p + 1) % DOCS.length));
  onButtonPress(BTN.SQUARE, () => setPage((p) => (p + DOCS.length - 1) % DOCS.length));

  // Per-frame zoom readout bypasses Solid (hot.text gates on change) — a
  // trigger-held zoom would otherwise re-render the HUD 60x/s on QuickJS.
  const onView = (v: DeepZoomView): void => {
    hot.text(zoomLabel, `${Math.round(v.zoom * 100)}%`);
  };

  return (
    <View class="w-full h-full bg-slate-900">
      <DeepZoom doc={DOCS[page()]} onView={onView} />
      {/* HUD bar; the zoom readout lives in a FIXED cell so hot.text updates
          never relayout (see framework/src/hot.ts rules) */}
      <View class="absolute left-0 right-0 bottom-0 h-7 flex-row items-center justify-between bg-slate-900 px-2">
        <Text class="text-xs text-white">{DOCS[page()].name}</Text>
        <Text class="text-xs text-slate-400">TRI/SQR page  R/L zoom  X fit</Text>
        <Text
          class="text-xs text-white"
          style={{ width: 44, height: 14 }}
          nodeRef={(n) => (zoomLabel = n)}
        >
          100%
        </Text>
      </View>
    </View>
  );
}
