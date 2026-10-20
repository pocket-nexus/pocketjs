// apps/home/ui/bar.tsx — the iOS 6 navigation bar at the 3DS's 0.82 scale:
// a two-band gloss in blue, black or orange, an embossed title (or a title
// view such as a segmented control), an arrow back button and an optional
// right button. It names no image asset.
//
// Every `class` is one complete literal — the compiler bakes a class table,
// so a state change picks between two whole literals instead of building one.

import { createEffect, onMount, Show, type Accessor, type JSX } from "solid-js";
import { jump } from "@pocketjs/framework/animation";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { ellipsize, FONT, measure } from "./text.ts";
import type { Press, Target } from "./touch.ts";

export const NAV_H = 36;

export interface NavButton {
  id: string;
  label: string;
  /** "back" draws the arrow; "done" is the blue confirm button. */
  kind: "back" | "plain" | "done";
  run: () => void;
}

/** Width of a bar button holding `label`. */
export function barButtonWidth(button: NavButton): number {
  return Math.max(button.kind === "back" ? 44 : 46, Math.ceil(measure(button.label, FONT.xsBold)) + (button.kind === "back" ? 22 : 18));
}

/** Hit targets of a nav bar's buttons on a `width`-wide surface. */
export function navTargets(width: number, left: NavButton | null, right: NavButton | null): Target[] {
  const out: Target[] = [];
  if (left) out.push({ id: left.id, x: 0, y: 0, w: barButtonWidth(left) + 10, h: NAV_H, run: left.run });
  if (right) {
    const w = barButtonWidth(right);
    out.push({ id: right.id, x: width - w - 10, y: 0, w: w + 10, h: NAV_H, run: right.run });
  }
  return out;
}

/** A back button's colours: the 1 px edge and the body's three-stop gloss. */
interface BackPalette {
  edge: string;
  from: string;
  via: string;
  to: string;
}

const BACK_PALETTES: Record<"blue" | "black" | "orange", { up: BackPalette; lit: BackPalette }> = {
  blue: {
    up: { edge: "#3f4f66", from: "#9dabc0", via: "#7b8ca5", to: "#67788f" },
    lit: { edge: "#2a3648", from: "#6a7b95", via: "#53647e", to: "#45556d" },
  },
  black: {
    up: { edge: "#000000", from: "#6a6a6a", via: "#3a3a3a", to: "#2a2a2a" },
    lit: { edge: "#000000", from: "#3a3a3a", via: "#202020", to: "#151515" },
  },
  orange: {
    up: { edge: "#9a3d00", from: "#ffa45e", via: "#ef7420", to: "#df620c" },
    lit: { edge: "#7a2f00", from: "#d0620f", via: "#b84d00", to: "#a44300" },
  },
};

/* The body is the box x >= BODY_X, rows BODY_Y .. BODY_Y + BODY_H - 1. The
 * arrow's point is at column ARROW_TIP, on the two middle rows. */
const BODY_X = 17;
const BODY_Y = 6;
const BODY_H = 24;
const BODY_MID = BODY_Y + BODY_H / 2;
const ARROW_TIP = BODY_X - BODY_H / 2 + 1;
/** Columns past BODY_X the arrow's fill covers, hiding the body's rounded left corners. */
const ARROW_JOIN = 6;

function mixColor(a: string, b: string, t: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  let out = "#";
  for (const at of [1, 3, 5]) out += Math.round(channel(a, at) + (channel(b, at) - channel(a, at)) * t).toString(16).padStart(2, "0");
  return out;
}

/** The body's gloss at the pixel boundary `y` (BODY_Y .. BODY_Y + BODY_H). */
function glossAt(palette: BackPalette, y: number): string {
  const t = (y - BODY_Y) / BODY_H;
  return t <= 0.5 ? mixColor(palette.from, palette.via, t * 2) : mixColor(palette.via, palette.to, (t - 0.5) * 2);
}

interface ArrowRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Solid edge colour, or a top-to-bottom gloss through the body's middle. */
  edge?: string;
  from?: string;
  to?: string;
}

/** The arrow end as axis-aligned 1 px columns: each column is an edge pixel
 *  above and below and the body's gloss between them, so the 45 degree edges
 *  step one pixel per row and meet the body's top and bottom edges on whole
 *  pixels. A rotated square drew this before; without anti-aliasing its
 *  edges and its flat fill did not line up with the body on the 3DS. */
function arrowRects(palette: BackPalette): ArrowRect[] {
  const out: ArrowRect[] = [];
  for (let x = ARROW_TIP; x < BODY_X; x++) {
    const top = BODY_MID - 1 - (x - ARROW_TIP);
    const bottom = BODY_MID + (x - ARROW_TIP);
    out.push({ x, y: top, w: 1, h: bottom - top + 1, edge: palette.edge });
    if (bottom - top >= 2) out.push({ x, y: top + 1, w: 1, h: bottom - top - 1, from: glossAt(palette, top + 1), to: glossAt(palette, bottom) });
  }
  out.push({ x: BODY_X, y: BODY_Y, w: ARROW_JOIN, h: 1, edge: palette.edge });
  out.push({ x: BODY_X, y: BODY_Y + BODY_H - 1, w: ARROW_JOIN, h: 1, edge: palette.edge });
  out.push({ x: BODY_X, y: BODY_Y + 1, w: ARROW_JOIN, h: BODY_H - 2, from: glossAt(palette, BODY_Y + 1), to: glossAt(palette, BODY_Y + BODY_H - 1) });
  return out;
}

const ARROWS = new Map<BackPalette, ArrowRect[]>();

function Arrow(props: { palette: BackPalette }) {
  let rects = ARROWS.get(props.palette);
  if (!rects) ARROWS.set(props.palette, (rects = arrowRects(props.palette)));
  return rects.map((rect) =>
    rect.edge
      ? <View class="absolute" style={{ insetL: rect.x, insetT: rect.y, width: rect.w, height: rect.h, bgColor: rect.edge }} />
      : <View class="absolute" style={{ insetL: rect.x, insetT: rect.y, width: rect.w, height: rect.h, gradDir: 1, gradFrom: rect.from, gradVia: props.palette.via, gradViaPos: 0.5, gradTo: rect.to }} />,
  );
}

function BackButton(props: { button: NavButton; press: Press; tint: "blue" | "black" | "orange" }) {
  const w = barButtonWidth(props.button);
  const lit = () => props.press.is(props.button.id);
  const orange = props.tint === "orange";
  const black = props.tint === "black";
  const palettes = BACK_PALETTES[props.tint];
  let litArrow!: NodeMirror;
  // The pressed arrow is a second set of columns shown by one opacity write.
  onMount(() => createEffect(() => jump(litArrow, "opacity", lit() ? 1 : 0)));
  return (
    <>
      <View
        class={orange
          ? lit()
            ? "absolute h-[24] rounded-[4] border border-[#7a2f00] bg-gradient-to-b from-[#d0620f] via-[#b84d00] to-[#a44300]"
            : "absolute h-[24] rounded-[4] border border-[#9a3d00] bg-gradient-to-b from-[#ffa45e] via-[#ef7420] to-[#df620c]"
          : black
            ? lit()
              ? "absolute h-[24] rounded-[4] border border-[#000000] bg-gradient-to-b from-[#3a3a3a] via-[#202020] to-[#151515]"
              : "absolute h-[24] rounded-[4] border border-[#000000] bg-gradient-to-b from-[#6a6a6a] via-[#3a3a3a] to-[#2a2a2a]"
            : lit()
              ? "absolute h-[24] rounded-[4] border border-[#2a3648] bg-gradient-to-b from-[#6a7b95] via-[#53647e] to-[#45556d]"
              : "absolute h-[24] rounded-[4] border border-[#3f4f66] bg-gradient-to-b from-[#9dabc0] via-[#7b8ca5] to-[#67788f]"}
        style={{ insetL: BODY_X, insetT: BODY_Y, width: w - 12 }}
      />
      <View class="absolute left-0 top-0 w-[24] h-[36]">
        <Arrow palette={palettes.up} />
      </View>
      <View ref={litArrow} class="absolute left-0 top-0 w-[24] h-[36] opacity-0">
        <Arrow palette={palettes.lit} />
      </View>
      <Text class={orange ? "absolute text-xs text-[#7a2f0099] font-bold" : "absolute text-xs text-[#39495f99] font-bold"} style={{ insetL: 20, insetT: 9 }}>{props.button.label}</Text>
      <Text class="absolute text-xs text-white font-bold" style={{ insetL: 20, insetT: 10 }}>{props.button.label}</Text>
    </>
  );
}

function PlainButton(props: { button: NavButton; press: Press; x: number; tint: "blue" | "black" | "orange" }) {
  const w = barButtonWidth(props.button);
  const lit = () => props.press.is(props.button.id);
  const done = props.button.kind === "done";
  return (
    <>
      <View
        class={props.tint === "orange"
          ? lit()
            ? "absolute h-[24] rounded-[4] border border-[#7a2f00] bg-gradient-to-b from-[#d0620f] via-[#b84d00] to-[#a44300]"
            : "absolute h-[24] rounded-[4] border border-[#9a3d00] bg-gradient-to-b from-[#ffa45e] via-[#ef7420] to-[#df620c]"
          : done
          ? lit()
            ? "absolute h-[24] rounded-[4] border border-[#14336b] bg-gradient-to-b from-[#3b6dc4] via-[#2453a6] to-[#1a4592]"
            : "absolute h-[24] rounded-[4] border border-[#1f4486] bg-gradient-to-b from-[#7aa6ee] via-[#3f75d6] to-[#2a5fc4]"
          : lit()
            ? "absolute h-[24] rounded-[4] border border-[#2a3648] bg-gradient-to-b from-[#6a7b95] via-[#53647e] to-[#45556d]"
            : "absolute h-[24] rounded-[4] border border-[#3f4f66] bg-gradient-to-b from-[#9dabc0] via-[#7b8ca5] to-[#67788f]"}
        style={{ insetL: props.x, insetT: 6, width: w }}
      />
      <Text class="absolute text-xs text-[#26364d99] font-bold text-center" style={{ insetL: props.x, insetT: 9, width: w }}>
        {props.button.label}
      </Text>
      <Text class="absolute text-xs text-white font-bold text-center" style={{ insetL: props.x, insetT: 10, width: w }}>
        {props.button.label}
      </Text>
    </>
  );
}

export interface NavBarProps {
  width: number;
  title: Accessor<string>;
  left?: NavButton | null;
  right?: NavButton | null;
  press: Press;
  /** Bar tint: iOS 6 blue (default), black translucent (camera), orange. */
  tint?: "blue" | "black" | "orange";
  /** Drawn instead of the title (a segmented control). */
  titleView?: () => JSX.Element;
}

/** The 36 px navigation bar: two-band gloss, highlight and shadow lines, an
 *  embossed centered title, an arrow back button and an optional right button. */
export function NavBar(props: NavBarProps) {
  const leftW = props.left ? barButtonWidth(props.left) + 14 : 10;
  const rightW = props.right ? barButtonWidth(props.right) + 14 : 10;
  const side = Math.max(leftW, rightW);
  const titleW = props.width - side * 2;
  const title = () => ellipsize(props.title(), FONT.baseBold, titleW);
  const tint = props.tint ?? "blue";
  return (
    <View
      class={tint === "black" ? "absolute left-0 top-0 h-[36] bg-[#000000a0]" : tint === "orange" ? "absolute left-0 top-0 h-[36] bg-[#f06a10]" : "absolute left-0 top-0 h-[36] bg-[#6d7e99]"}
      style={{ width: props.width }}
    >
      <View
        class={tint === "black"
          ? "absolute left-0 right-0 top-0 h-[18] bg-gradient-to-b from-[#ffffff30] to-[#ffffff10]"
          : tint === "orange"
            ? "absolute left-0 right-0 top-0 h-[18] bg-gradient-to-b from-[#ffb36e] to-[#ff8c38]"
            : "absolute left-0 right-0 top-0 h-[18] bg-gradient-to-b from-[#b5c2d3] to-[#8e9db5]"}
      />
      <View
        class={tint === "black"
          ? "hidden"
          : tint === "orange"
            ? "absolute left-0 right-0 top-[18] h-[18] bg-gradient-to-b from-[#ff7d1f] to-[#ea6206]"
            : "absolute left-0 right-0 top-[18] h-[18] bg-gradient-to-b from-[#7f90aa] to-[#6b7d99]"}
      />
      <View class={tint === "black" ? "absolute left-0 right-0 top-0 h-[1] bg-[#ffffff40]" : tint === "orange" ? "absolute left-0 right-0 top-0 h-[1] bg-[#ffd1a6]" : "absolute left-0 right-0 top-0 h-[1] bg-[#d3dae4]"} />
      <View class={tint === "black" ? "absolute left-0 right-0 bottom-0 h-[1] bg-[#000000]" : tint === "orange" ? "absolute left-0 right-0 bottom-0 h-[1] bg-[#9a3d00]" : "absolute left-0 right-0 bottom-0 h-[1] bg-[#2d3a4c]"} />
      <Show
        when={props.titleView}
        fallback={
          <>
            <Text class={tint === "orange" ? "absolute text-base text-[#8a360099] font-bold text-center" : "absolute text-base text-[#2f3d5299] font-bold text-center"} style={{ insetL: side, insetT: 7, width: titleW }}>{title()}</Text>
            <Text class="absolute text-base text-white font-bold text-center" style={{ insetL: side, insetT: 8, width: titleW }}>{title()}</Text>
          </>
        }
      >
        {(view) => view()()}
      </Show>
      <Show when={props.left}>
        {(left) => (left().kind === "back"
          ? <BackButton button={left()} press={props.press} tint={tint} />
          : <PlainButton button={left()} press={props.press} x={5} tint={tint} />)}
      </Show>
      <Show when={props.right}>
        {(right) => <PlainButton button={right()} press={props.press} x={props.width - barButtonWidth(right()) - 5} tint={tint} />}
      </Show>
    </View>
  );
}

