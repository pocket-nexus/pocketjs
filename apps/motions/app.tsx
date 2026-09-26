// apps/motions — yui540 motion studies on baked keyframe timelines.
// Attribution and the project-specific permission boundary are recorded in
// ./ATTRIBUTION.md. Keep the requested `(yui540)` credit on every page.
//
// Four pages mirror the original portfolio pages — motions/53, /56, /30 and
// /64 — each a grid of SIX tiles playing together (3x2 here for the PSP's
// landscape screen; the originals are 2x3 portrait). Every animation is a
// `theme.keyframes` + `theme.animation` entry in ./pocket.config.ts applied
// through static `animate-<name>` utilities; a page-wide `loop` period
// replays all six tiles in sync, like the original page remount. The /64
// page runs on the 3D pipeline (`perspective-[N]` roots + rotate-x/y +
// translate-z with TEX_TRI-projected letter textures), and the reload tile
// strokes the arc primitive. ZERO per-frame JS runs while a page plays.
//
// Left/Right on the d-pad switch pages.

import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

// ---------------------------------------------------------------------------
// Tile chrome: 3x2 grid of 154x116 rounded cards. Keep the grid between the
// header and footer so their text never paints over the animated tiles.
// ---------------------------------------------------------------------------

const TILE_POS = [
  "absolute left-[5] top-[16] w-[154] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
  "absolute left-[163] top-[16] w-[154] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
  "absolute left-[321] top-[16] w-[154] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
  "absolute left-[5] top-[136] w-[154] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
  "absolute left-[163] top-[136] w-[154] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
  "absolute left-[321] top-[136] w-[154] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
];

function Caption(props: { label: string; light?: boolean }) {
  return (
    <View debugName="Caption" class="absolute left-0 bottom-[4] w-full flex-row justify-center">
      <Show
        when={props.light}
        fallback={<Text class="text-xs font-bold text-[#888] tracking-wide">{props.label}</Text>}
      >
        <Text class="text-xs font-bold text-[#f1f1f1] tracking-wide">{props.label}</Text>
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// PAGE 1 — motions/53 (functional micro-interactions)
// ---------------------------------------------------------------------------

/** Menu: the pill stretches open; dots morph into an X; T/B/I items rise. */
function Menu53() {
  return (
    <>
      <View debugName="Menu53" class="absolute left-[10] top-[32] w-[38] h-[38] rounded-[19px] bg-white overflow-hidden animate-m53-menu-pill">
        <View class="absolute left-[34] top-0 w-[38] h-[38]">
          <View class="absolute left-[4] top-[4] w-[30] h-[30] rounded-full bg-[#f1f1f1] flex-row justify-center items-center animate-m53-menu-item-1">
            <Image class="w-[18] h-[18]" src="icon-text.svg" />
          </View>
        </View>
        <View class="absolute left-[68] top-0 w-[38] h-[38]">
          <View class="absolute left-[4] top-[4] w-[30] h-[30] rounded-full bg-[#f1f1f1] flex-row justify-center items-center animate-m53-menu-item-2">
            <Image class="w-[18] h-[18]" src="icon-bold.svg" />
          </View>
        </View>
        <View class="absolute left-[103] top-0 w-[38] h-[38]">
          <View class="absolute left-[4] top-[4] w-[30] h-[30] rounded-full bg-[#f1f1f1] flex-row justify-center items-center animate-m53-menu-item-3">
            <Image class="w-[18] h-[18]" src="icon-italic.svg" />
          </View>
        </View>
        <View class="absolute left-0 top-0 w-[38] h-[38]">
          <View class="absolute left-[7] top-[17] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-menu-x-left" />
          <View class="absolute left-[17] top-[17] w-[5] h-[5] rounded-[2px] bg-[#777]" />
          <View class="absolute left-[27] top-[17] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-menu-x-right" />
        </View>
      </View>
      <Caption label="MENU" />
    </>
  );
}

/** D-pad: pentagon keys — cap + same-color trapezoid base pointing inward,
 *  diagonal gaps between the four; caps stretch outward, arrows anchored to
 *  the OUTER edge so they ride the stretch. */
function DPad53() {
  return (
    <>
      <Image debugName="DPad53" class="absolute left-[64] top-[34] w-[26] h-[11]" src="icon-base-down.svg" />
      <Image class="absolute left-[64] top-[59] w-[26] h-[11]" src="icon-base-up.svg" />
      <Image class="absolute left-[84] top-[39] w-[11] h-[26]" src="icon-base-left.svg" />
      <Image class="absolute left-[59] top-[39] w-[11] h-[26]" src="icon-base-right.svg" />
      <View class="absolute left-[64] top-[13] w-[26] h-[24] rounded-[5px] bg-[#888] animate-m53-dpad-up">
        <Image class="absolute left-[6] top-[4] w-[15] h-[15]" src="icon-arrow-up.svg" />
      </View>
      <View class="absolute left-[92] top-[39] w-[24] h-[26] rounded-[5px] bg-[#888] animate-m53-dpad-right">
        <Image class="absolute right-[4] top-[5] w-[15] h-[15]" src="icon-arrow-right.svg" />
      </View>
      <View class="absolute left-[64] top-[67] w-[26] h-[24] rounded-[5px] bg-[#888] animate-m53-dpad-down">
        <Image class="absolute left-[6] bottom-[4] w-[15] h-[15]" src="icon-arrow-down.svg" />
      </View>
      <View class="absolute left-[38] top-[39] w-[24] h-[26] rounded-[5px] bg-[#888] animate-m53-dpad-left">
        <Image class="absolute left-[4] top-[5] w-[15] h-[15]" src="icon-arrow-left.svg" />
      </View>
      <Caption label="D-PAD" />
    </>
  );
}

/** Share: the white card inflates behind a FIXED, pinned logo. */
function Share53() {
  return (
    <>
      <View debugName="Share53" class="absolute left-[33] top-[34] w-[38] h-[38] rounded-[11px] bg-white animate-m53-share-a" />
      <View class="absolute left-[83] top-[34] w-[38] h-[38] rounded-[11px] bg-white animate-m53-share-b" />
      <View class="absolute left-[33] top-[34] w-[38] h-[38] flex-row justify-center items-center">
        <Image class="w-[24] h-[24]" src="icon-x.svg" />
      </View>
      <View class="absolute left-[83] top-[34] w-[38] h-[38] flex-row justify-center items-center">
        <Image class="w-[26] h-[26]" src="icon-youtube.svg" />
      </View>
      <View class="absolute left-[27] top-[14] w-[50] h-[16] overflow-hidden">
        <View class="w-full h-full flex-row justify-center items-center animate-m53-share-label-a">
          <Text class="text-xs font-bold text-[#777]">SHARE</Text>
        </View>
      </View>
      <View class="absolute left-[77] top-[14] w-[50] h-[16] overflow-hidden">
        <View class="w-full h-full flex-row justify-center items-center animate-m53-share-label-b">
          <Text class="text-xs font-bold text-[#777]">SHARE</Text>
        </View>
      </View>
      <Caption label="SHARE" />
    </>
  );
}

/** Hover: the button lifts while an arrow compartment slides open. */
function Hover53() {
  return (
    <>
      <View debugName="Hover53" class="absolute left-[23] top-[34] w-[108] h-[32] rounded-[9px] bg-white shadow overflow-hidden flex-row animate-m53-hover-btn">
        <View class="flex-1 h-full flex-row justify-center items-center">
          <Text class="text-sm font-bold text-[#777] tracking-wide">BUTTON</Text>
        </View>
        <View class="relative h-full w-[26] overflow-hidden animate-m53-hover-arrow">
          <View class="absolute left-0 top-0 w-[2] h-full bg-[#f1f1f1]" />
          <Image class="absolute left-[6] top-[8] w-[15] h-[15]" src="icon-chevron.svg" />
        </View>
      </View>
      <Caption label="HOVER" />
    </>
  );
}

/** Reload: stroke arcs (the arc primitive) wind while drawing on. */
function Reload53() {
  return (
    <>
      <View debugName="Reload53" class="absolute left-[41] top-[30] w-[38] h-[38] bg-white arc-width-[6] animate-m53-arc-a" />
      <View class="absolute left-[48] top-[37] w-[24] h-[24] flex-row justify-center items-center animate-m53-reload-icon-a">
        <Image class="w-[24] h-[24]" src="icon-reload.svg" />
      </View>
      <View class="absolute left-[80] top-[25] w-[48] h-[48] rounded-full bg-white" />
      <View class="absolute left-[80] top-[25] w-[48] h-[48] bg-[#777] arc-width-[2] animate-m53-arc-b" />
      <View class="absolute left-[90] top-[35] w-[28] h-[28] flex-row justify-center items-center animate-m53-reload-icon-b">
        <Image class="w-[28] h-[28]" src="icon-reload.svg" />
      </View>
      <Caption label="RELOAD" />
    </>
  );
}

/** Keypad: keys squash wide with an inset top shadow; digits bob. */
function Keypad53() {
  return (
    <>
      <View debugName="Keypad53" class="absolute left-[16] top-[32] w-[34] h-[34]">
        <View class="absolute left-0 top-0 w-[34] h-[34] rounded-[10px] bg-[#e0e0e0] flex-row justify-center items-center animate-m53-key-1">
          <View class="animate-m53-key-digit-1">
            <Text class="text-lg font-bold text-[#777]">1</Text>
          </View>
        </View>
      </View>
      <View class="absolute left-[60] top-[32] w-[34] h-[34]">
        <View class="absolute left-0 top-0 w-[34] h-[34] rounded-[10px] bg-[#e0e0e0] flex-row justify-center items-center animate-m53-key-2">
          <View class="animate-m53-key-digit-2">
            <Text class="text-lg font-bold text-[#777]">2</Text>
          </View>
        </View>
      </View>
      <View class="absolute left-[104] top-[32] w-[34] h-[34]">
        <View class="absolute left-0 top-0 w-[34] h-[34] rounded-[10px] bg-[#e0e0e0] flex-row justify-center items-center animate-m53-key-3">
          <View class="animate-m53-key-digit-3">
            <Text class="text-lg font-bold text-[#777]">3</Text>
          </View>
        </View>
      </View>
      <Caption label="KEYPAD" />
    </>
  );
}

// ---------------------------------------------------------------------------
// PAGE 2 — motions/56
// ---------------------------------------------------------------------------

function Launch56() {
  return (
    <>
      <View debugName="Launch56" class="absolute left-[62] top-[31] w-[31] h-[31] overflow-hidden animate-m56-applaunch-box">
        <View class="absolute inset-0 rounded-[11px] bg-[#888] animate-m56-applaunch-press" />
      </View>
      <Caption label="LAUNCH" />
    </>
  );
}

function Layout56() {
  return (
    <>
      <View debugName="Layout56" class="absolute left-[20] top-[12] w-[113] h-[73]">
        <View class="absolute inset-0 animate-m56-layout-p1">
          <View class="absolute left-0 top-0 h-full w-[58] rounded-[10px] bg-white animate-m56-layout-left" />
          <View class="absolute left-[55] top-0 h-full w-[58] animate-m56-layout-right">
            <View class="absolute left-0 top-0 w-full h-[37] bg-white animate-m56-layout-half-top" />
            <View class="absolute left-0 top-[36] w-full h-[37] bg-white animate-m56-layout-half-bottom" />
          </View>
        </View>
        <View class="absolute inset-0 animate-m56-layout-p2">
          <View class="absolute left-0 top-0 w-full h-[25] bg-white animate-m56-layout-row-top" />
          <View class="absolute left-0 top-[24] w-full h-[25] bg-white animate-m56-layout-row-mid" />
          <View class="absolute left-0 top-[48] w-full h-[25] bg-white animate-m56-layout-row-bottom" />
        </View>
      </View>
      <Caption label="LAYOUT" />
    </>
  );
}

function Shutter56() {
  return (
    <>
      <View debugName="Shutter56" class="absolute left-[20] top-0 w-[113] flex-col">
        <View class="w-full h-[5] bg-[#bbb] animate-m56-shutter-1" />
        <View class="w-full h-[5] bg-[#ccc] animate-m56-shutter-2" />
        <View class="w-full h-[5] bg-[#bbb] animate-m56-shutter-3" />
        <View class="w-full h-[5] bg-[#ccc] animate-m56-shutter-4" />
        <View class="w-full h-[10] bg-[#aaa]">
          <View class="absolute left-[46] top-[3] w-[22] h-[5] rounded-[999px] bg-[#f1f1f1]" />
        </View>
      </View>
      <Caption label="SHUTTER" />
    </>
  );
}

function Cards56() {
  return (
    <>
      <View debugName="Cards56" class="absolute left-[56] top-[4] w-[42] h-[96]">
        <View class="absolute inset-0 origin-bottom animate-m56-fan-l2">
          <View class="absolute left-[4] top-0 w-[35] h-[54] rounded-[7px] bg-[#e0e0e0]" />
        </View>
        <View class="absolute inset-0 origin-bottom animate-m56-fan-r2">
          <View class="absolute left-[4] top-0 w-[35] h-[54] rounded-[7px] bg-[#e0e0e0]" />
        </View>
        <View class="absolute inset-0 origin-bottom animate-m56-fan-l1">
          <View class="absolute left-[4] top-0 w-[35] h-[54] rounded-[7px] bg-[#bbb]" />
        </View>
        <View class="absolute inset-0 origin-bottom animate-m56-fan-r1">
          <View class="absolute left-[4] top-0 w-[35] h-[54] rounded-[7px] bg-[#bbb]" />
        </View>
        <View class="absolute inset-0 origin-bottom animate-m56-fan-pulse">
          <View class="absolute left-[4] top-0 w-[35] h-[54] rounded-[7px] bg-[#999]" />
        </View>
      </View>
      <Caption label="CARDS" />
    </>
  );
}

function Heave56() {
  return (
    <>
      <View debugName="Heave56" class="absolute left-[26] top-[34] w-[108] h-[29]">
        <View class="absolute left-0 top-0 w-[34] h-[29] rounded-[999px] bg-[#bbb] animate-m56-heave" />
      </View>
      <Caption label="HEAVE-HO" />
    </>
  );
}

function RingCorner(props: { cls1: string; cls2: string }) {
  return (
    <>
      <View debugName="RingCorner" class={props.cls1} />
      <View class={props.cls2} />
    </>
  );
}

function Focus56() {
  return (
    <>
      <View debugName="Focus56" class="absolute left-[23] top-[32] w-[34] h-[34] flex-row justify-center items-center">
        <Text class="text-xl font-bold text-[#888]">A</Text>
      </View>
      <View class="absolute left-[60] top-[32] w-[34] h-[34] flex-row justify-center items-center">
        <Text class="text-xl font-bold text-[#888]">B</Text>
      </View>
      <View class="absolute left-[97] top-[32] w-[34] h-[34] flex-row justify-center items-center">
        <Text class="text-xl font-bold text-[#888]">C</Text>
      </View>
      <View class="absolute left-[60] top-[32] w-[34] h-[34]">
        <View class="absolute left-0 top-0 w-[34] h-[34] animate-m56-focus-ring">
          <View class="absolute inset-[-6] animate-m56-focus-pulse">
            <RingCorner
              cls1="absolute left-0 top-0 w-[11] h-[6] bg-[#ccc]"
              cls2="absolute left-0 top-0 w-[6] h-[11] bg-[#ccc]"
            />
            <RingCorner
              cls1="absolute right-0 top-0 w-[11] h-[6] bg-[#ccc]"
              cls2="absolute right-0 top-0 w-[6] h-[11] bg-[#ccc]"
            />
            <RingCorner
              cls1="absolute right-0 bottom-0 w-[11] h-[6] bg-[#ccc]"
              cls2="absolute right-0 bottom-0 w-[6] h-[11] bg-[#ccc]"
            />
            <RingCorner
              cls1="absolute left-0 bottom-0 w-[11] h-[6] bg-[#ccc]"
              cls2="absolute left-0 bottom-0 w-[6] h-[11] bg-[#ccc]"
            />
          </View>
        </View>
      </View>
      <Caption label="FOCUS" />
    </>
  );
}

// ---------------------------------------------------------------------------
// PAGE 3 — motions/30
// ---------------------------------------------------------------------------

function Reveal30() {
  return (
    <>
      <View debugName="Reveal30" class="absolute left-[20] top-[12] w-[113] h-[71] bg-[#ccc] overflow-hidden shadow">
        <View class="absolute left-[83] top-[50] w-[14] h-[14] rounded-full bg-white animate-m30-reveal" />
        <View class="absolute inset-0 bg-white animate-m30-reveal-cap" />
        <View class="absolute left-0 top-0 w-full h-[50] flex-col justify-center items-center gap-1 animate-m30-reveal-logo">
          <View class="w-[16] h-[16] rounded-full bg-[#e0e0e0]" />
          <View class="w-[36] h-[5] rounded-[2px] bg-[#e0e0e0]" />
        </View>
        <View class="absolute left-[38] top-[54] w-[37] h-[11] rounded-[999px] bg-[#ccc] animate-m30-reveal-btn" />
      </View>
      <Caption label="REVEAL" />
    </>
  );
}

const GRID30_CELLS = [
  "absolute left-0 top-0 w-[28.25] h-[23.67] bg-white animate-m30-cell-c",
  "absolute left-[28.25] top-0 w-[28.25] h-[23.67] bg-white animate-m30-cell-b",
  "absolute left-[56.5] top-0 w-[28.25] h-[23.67] bg-white animate-m30-cell-a",
  "absolute left-[84.75] top-0 w-[28.25] h-[23.67] bg-white animate-m30-cell-b",
  "absolute left-0 top-[23.67] w-[28.25] h-[23.67] bg-white animate-m30-cell-c",
  "absolute left-[28.25] top-[23.67] w-[28.25] h-[23.67] bg-white animate-m30-cell-b",
  "absolute left-[56.5] top-[23.67] w-[28.25] h-[23.67] bg-white animate-m30-cell-c",
  "absolute left-[84.75] top-[23.67] w-[28.25] h-[23.67] bg-white animate-m30-cell-b",
  "absolute left-0 top-[47.33] w-[28.25] h-[23.67] bg-white animate-m30-cell-a",
  "absolute left-[28.25] top-[47.33] w-[28.25] h-[23.67] bg-white animate-m30-cell-b",
  "absolute left-[56.5] top-[47.33] w-[28.25] h-[23.67] bg-white animate-m30-cell-c",
  "absolute left-[84.75] top-[47.33] w-[28.25] h-[23.67] bg-white animate-m30-cell-b",
];

function Grid30() {
  return (
    <>
      <View debugName="Grid30" class="absolute left-[20] top-[12] w-[113] h-[71]">
        {GRID30_CELLS.map((cls) => (
          <View class={cls} />
        ))}
        <View class="absolute left-0 top-0 w-full h-[16] overflow-hidden">
          <View class="w-full h-full bg-[#bbb] animate-m30-grid-header" />
        </View>
        <View class="absolute left-0 top-[31] w-full flex-row justify-center animate-m30-grid-text">
          <Text class="text-xs font-bold text-[#aaa]">HELLO!</Text>
        </View>
        <View class="absolute left-[38] top-[53] w-[37] h-[13] overflow-hidden">
          <View class="w-full h-full rounded-[999px] bg-[#bbb] animate-m30-grid-button" />
        </View>
      </View>
      <Caption label="GRID" />
    </>
  );
}

function Expand30() {
  return (
    <>
      <View debugName="Expand30" class="absolute left-[20] top-[12] w-[113] h-[71] rounded-[6px] bg-white border-[#ccc] border-2 overflow-hidden flex-col animate-m30-expand">
        <View class="w-full h-[16] bg-[#ccc] flex-row items-center gap-1 pl-1">
          <View class="w-[6] h-[6] rounded-full bg-white" />
          <View class="w-[6] h-[6] rounded-full bg-white" />
        </View>
        <View class="flex-col gap-1 p-2 animate-m30-expand-body">
          <View class="w-[67] h-[5] rounded-[2px] bg-[#e0e0e0]" />
          <View class="w-[50] h-[5] rounded-[2px] bg-[#e0e0e0]" />
          <View class="w-[96] h-[24] rounded-[3px] bg-[#e0e0e0]" />
        </View>
      </View>
      <Caption label="EXPAND" />
    </>
  );
}

function Modal30() {
  return (
    <>
      <View debugName="Modal30" class="absolute left-[119] top-[17] w-[11] flex-col gap-2 rotate-140">
        <View class="w-[11] h-[4] rounded-[999px] overflow-hidden rotate-28">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-1" />
        </View>
        <View class="w-[11] h-[4] rounded-[999px] overflow-hidden rotate-332">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-2" />
        </View>
      </View>
      <View class="absolute left-[48] top-[59] w-[11] flex-col gap-2 rotate-320">
        <View class="w-[11] h-[4] rounded-[999px] overflow-hidden rotate-28">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-1" />
        </View>
        <View class="w-[11] h-[4] rounded-[999px] overflow-hidden rotate-332">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-2" />
        </View>
      </View>
      <View class="absolute left-[43] top-[22] w-[67] h-[44] rounded-[6px] bg-white shadow-md flex-col items-center gap-1 pt-2 animate-m30-modal">
        <View class="w-[40] h-[4] rounded-[2px] bg-[#e0e0e0]" />
        <View class="w-[28] h-[4] rounded-[2px] bg-[#e0e0e0]" />
        <View class="w-[50] h-[17] rounded-[3px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute left-[58] top-[71] w-[37] h-[13] rounded-[999px] bg-[#ccc] origin-bottom animate-m30-modal-btn" />
      <Caption label="MODAL" />
    </>
  );
}

function Comments30() {
  return (
    <>
      <View debugName="Comments30" class="absolute left-[40] top-[26] w-[40] h-[28] rounded-[5px] bg-white shadow origin-bottom flex-col gap-1 p-1 animate-m30-comment-1">
        <View class="flex-row items-center gap-1">
          <View class="w-[6] h-[6] rounded-full bg-[#e0e0e0]" />
          <View class="w-[16] h-[3] rounded-[2px] bg-[#e0e0e0]" />
        </View>
        <View class="w-[29] h-[3] rounded-[2px] bg-[#e0e0e0]" />
        <View class="w-[22] h-[3] rounded-[2px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute left-[101] top-[44] w-[40] h-[28] rounded-[5px] bg-white shadow origin-bottom flex-col gap-1 p-1 animate-m30-comment-2">
        <View class="flex-row items-center gap-1">
          <View class="w-[6] h-[6] rounded-full bg-[#e0e0e0]" />
          <View class="w-[16] h-[3] rounded-[2px] bg-[#e0e0e0]" />
        </View>
        <View class="w-[29] h-[3] rounded-[2px] bg-[#e0e0e0]" />
        <View class="w-[22] h-[3] rounded-[2px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute left-[74] top-[33] w-[31] h-[23] rounded-[999px] bg-white shadow origin-bottom flex-row justify-center items-center gap-1 animate-m30-bubble">
        <View class="w-[4] h-[4] rounded-full bg-[#bbb]" />
        <View class="w-[4] h-[4] rounded-full bg-[#bbb]" />
        <View class="w-[4] h-[4] rounded-full bg-[#bbb]" />
      </View>
      <Caption label="COMMENTS" />
    </>
  );
}

function SlideIn30() {
  return (
    <>
      <View debugName="SlideIn30" class="absolute left-[59] top-[26] w-[73] h-[48] rotate-8">
        <View class="w-full h-full rounded-[5px] bg-[#e0e0e0] animate-m30-slidein-back" />
      </View>
      <View class="absolute left-[54] top-[20] w-[73] h-[48]">
        <View class="w-full h-full rounded-[5px] bg-white shadow flex-col gap-1 p-1 animate-m30-slidein-front">
          <View class="w-[44] h-[4] rounded-[2px] bg-[#e0e0e0]" />
          <View class="w-[31] h-[4] rounded-[2px] bg-[#e0e0e0]" />
          <View class="w-[64] h-[26] rounded-[3px] bg-[#f1f1f1]" />
        </View>
      </View>
      <View class="absolute left-[58] top-[74] w-[37] h-[12] rounded-[999px] bg-[#ccc] animate-m30-slidein-btn" />
      <Caption label="SLIDE-IN" />
    </>
  );
}

// ---------------------------------------------------------------------------
// PAGE 4 — motions/64 (3D transforms)
// ---------------------------------------------------------------------------

/** Door: swings 110° open about its right edge inside a framed wall. */
function Door64() {
  return (
    <>
      <View debugName="Door64" class="absolute left-[35] top-[14] w-[84] h-[62] bg-[#e0e0e0]">
        <View class="absolute left-[15] top-[10] w-[54] h-[41] bg-[#999]" />
        <View class="absolute left-[15] top-[10] w-[54] h-[41] perspective-[460]">
          <View class="absolute inset-0 bg-[#aaa] translate-z-[-8]" />
          <View class="absolute left-[-4] top-0 w-[8] h-[41] bg-[#bbb] rotate-y-[90] translate-z-[-4]" />
          <View class="absolute inset-0 origin-right animate-m64-door">
            <View class="absolute inset-0 bg-[#ccc]" />
            <View class="absolute left-[5] top-[16] w-[10] h-[10] rounded-full bg-[#aaa]" />
            <View class="absolute left-[9] top-[18] w-[16] h-[6] rounded-[3px] bg-[#888] origin-left animate-m64-knob" />
          </View>
        </View>
      </View>
      <Caption label="DOOR" />
    </>
  );
}

/** The six faces of a 28px cube (front/back z ±14, sides folded 90°). */
function CubeFaces() {
  return (
    <>
      <View debugName="CubeFaces" class="absolute inset-0 bg-[#888] translate-z-[-14]" />
      <View class="absolute inset-0 bg-[#999] translate-y-[-14] rotate-x-[90]" />
      <View class="absolute inset-0 bg-[#bbb] translate-y-[14] rotate-x-[90]" />
      <View class="absolute inset-0 bg-[#aaa] translate-x-[14] rotate-y-[90]" />
      <View class="absolute inset-0 bg-[#ccc] translate-x-[-14] rotate-y-[90]" />
      <View class="absolute inset-0 bg-[#888] translate-z-[14]" />
    </>
  );
}

/** Spin: one cube turns forever; the other somersaults and back. */
function Spin64() {
  return (
    <>
      <View debugName="Spin64" class="absolute inset-0 opacity-70 perspective-[190]">
        <View class="absolute left-[32] top-[36] w-[28] h-[28] rotate-x-[-40] translate-z-[-14] animate-m64-spin">
          <CubeFaces />
        </View>
        <View class="absolute left-[94] top-[36] w-[28] h-[28] rotate-y-[40] translate-z-[-14] animate-m64-tumble">
          <CubeFaces />
        </View>
      </View>
      <Caption label="SPIN" />
    </>
  );
}

/** Pop-out: a slab rises out of a tilted floor plane. */
function PopOut64() {
  return (
    <>
      <View debugName="PopOut64" class="absolute inset-0 opacity-70 perspective-[190]">
        <View class="absolute left-[43] top-[10] w-[67] h-[67] rotate-x-[-45]">
          <View class="absolute left-[10] top-[26] w-[48] h-[48] rotate-x-[90] bg-[#ccc]" />
          <View class="absolute left-[17] top-[48] w-[34] h-[0] bg-[#aaa] animate-m64-rise" />
          <View class="absolute left-[17] top-[31] w-[34] h-[34] rotate-x-[90] bg-[#ccc] animate-m64-cap" />
        </View>
      </View>
      <Caption label="POP-OUT" />
    </>
  );
}

/** Stretch: the cube's width stretches while it yaws 30°. */
function Stretch64() {
  return (
    <>
      <View debugName="Stretch64" class="absolute inset-0 opacity-70 perspective-[190]">
        <View class="absolute left-[60] top-[33] w-[34] h-[34] rotate-x-[-30] translate-z-[-17] animate-m64-stretch">
          <View class="absolute inset-0 bg-[#888] translate-z-[-17]" />
          <View class="absolute inset-0 bg-[#bbb] translate-y-[-17] rotate-x-[90]" />
          <View class="absolute inset-0 bg-[#bbb] translate-y-[17] rotate-x-[90]" />
          <View class="absolute right-0 top-0 w-[34] h-[34] bg-[#aaa] translate-x-[17] rotate-y-[90]" />
          <View class="absolute left-0 top-0 w-[34] h-[34] bg-[#aaa] translate-x-[-17] rotate-y-[90]" />
          <View class="absolute inset-0 bg-[#888] translate-z-[17]" />
        </View>
      </View>
      <Caption label="STRETCH" />
    </>
  );
}

/** Page flip: three cards swing in about their right hinges. */
function Flip64() {
  return (
    <>
      <View debugName="Flip64" class="absolute left-[63] top-[14] w-[46] h-[56] perspective-[230]">
        <View class="absolute inset-0 bg-[#ccc] origin-right animate-m64-flip-1" />
        <View class="absolute inset-0 bg-[#aaa] origin-right animate-m64-flip-2" />
        <View class="absolute inset-0 bg-[#888] origin-right animate-m64-flip-3" />
      </View>
      <Caption label="FLIP" />
    </>
  );
}

/** Room: the camera sits inside a box that turns A -> B -> A.
 *  The letters are baked path textures riding the walls (TEX_TRI projection). */
function Room64() {
  return (
    <>
      <View debugName="Room64" class="absolute inset-0 perspective-[280]">
        <View class="absolute inset-0 translate-z-[-77] animate-m64-room">
          <View class="absolute inset-0 bg-[#ccc] translate-z-[77]">
            <Image class="absolute left-[51] top-[32] w-[52] h-[52]" src="letter-a.svg" />
          </View>
          <View class="absolute inset-0 bg-[#aaa] translate-x-[77] rotate-y-[90]">
            <Image class="absolute left-[51] top-[32] w-[52] h-[52]" src="letter-b.svg" />
          </View>
        </View>
      </View>
      <Caption label="ROOM" light />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

interface PageDef {
  title: string;
  source: string;
  tiles: Array<() => JSX.Element>;
}

const PAGES: PageDef[] = [
  {
    title: "MOTIONS/53",
    source: "yui540.com/motions/53",
    tiles: [Menu53, DPad53, Share53, Hover53, Reload53, Keypad53],
  },
  {
    title: "MOTIONS/56",
    source: "yui540.com/motions/56",
    tiles: [Launch56, Layout56, Shutter56, Cards56, Heave56, Focus56],
  },
  {
    title: "MOTIONS/30",
    source: "yui540.com/motions/30",
    tiles: [Reveal30, Grid30, Expand30, Modal30, Comments30, SlideIn30],
  },
  {
    title: "MOTIONS/64 · 3D",
    source: "yui540.com/motions/64",
    tiles: [Door64, Spin64, PopOut64, Stretch64, Flip64, Room64],
  },
];

export default function Motions() {
  const [index, setIndex] = createSignal(0);
  const page = () => PAGES[index()];
  onButtonPress(BTN.RIGHT | BTN.RTRIGGER, () => setIndex((i) => (i + 1) % PAGES.length));
  onButtonPress(BTN.LEFT | BTN.LTRIGGER, () => setIndex((i) => (i + PAGES.length - 1) % PAGES.length));
  return (
    <View debugName="MotionsScreen" class="w-full h-full bg-[#191919]">
      <View debugName="Header" class="absolute left-0 top-[1] w-full flex-row justify-between px-[8]">
        <Text class="text-xs font-bold text-[#888] tracking-wide">{page().title}</Text>
        <Text class="text-xs font-bold text-[#666]">{`${index() + 1}/4 · L/R`}</Text>
      </View>
      <Show when={page()} keyed>
        {(p) => (
          <>
            {p.tiles.map((Tile, i) => (
              <View debugName="Tile" class={TILE_POS[i]}>
                <Tile />
              </View>
            ))}
          </>
        )}
      </Show>
      <View
        debugName="Footer"
        class="absolute left-0 bottom-[1] w-full flex-row justify-between px-[8]"
      >
        <Text class="text-xs text-[#666]">{page().source}</Text>
        <Text class="text-xs font-bold text-[#888]">(yui540)</Text>
      </View>
    </View>
  );
}
