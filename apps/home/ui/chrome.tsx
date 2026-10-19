// apps/home/ui/chrome.tsx — iOS 6 chrome at the 3DS's 0.82 scale: the
// pinstriped grouped background, ON/OFF switches, glossy icon tiles, the
// status bar and the wallpaper both screens share. The navigation bar lives
// in bar.tsx, which names no image, so an app that only needs the bar (Hacker
// News) bakes none of these textures.
//
// Every element is absolutely placed by its caller through `style`, and every
// `class` is one complete literal — the compiler bakes a class table, so a
// state change picks between two whole literals instead of building one.

import { Show, type Accessor, type JSX } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";

// ---- backgrounds -----------------------------------------------------------------

/** The grouped-table pinstripes: one 512x8 texture stretched down the box. */
export function Pinstripes(props: { width: number; height: number }) {
  return (
    <View class="absolute left-0 top-0 overflow-hidden" style={{ width: props.width, height: props.height }}>
      <Image class="absolute left-0 top-0 w-[512]" src="art/stripes.svg" style={{ height: props.height }} />
    </View>
  );
}

/** A soft radial glow: a 64 px texture of stacked translucent discs,
 *  magnified with linear filtering so its rings blur into a gradient. */
function Glow(props: { x: number; y: number; r: number; color: "teal" | "violet" | "white" }) {
  return (
    <Image
      class="absolute"
      src={props.color === "teal" ? "art/glow-teal.svg" : props.color === "violet" ? "art/glow-violet.svg" : "art/glow-white.svg"}
      style={{ insetL: props.x - props.r, insetT: props.y - props.r, width: props.r * 2, height: props.r * 2 }}
    />
  );
}

/** The wallpaper, drawn as one picture across both screens: the top screen
 *  is its upper 240 px, the bottom screen continues below the hinge. */
export function Wallpaper(props: { screen: "top" | "bottom" }) {
  const top = props.screen === "top";
  return (
    <View
      class={top
        ? "absolute left-0 top-0 w-[400] h-[240] overflow-hidden bg-gradient-to-b from-[#0b1730] via-[#173a63] to-[#1f5277]"
        : "absolute left-0 top-0 w-[320] h-[240] overflow-hidden bg-gradient-to-b from-[#1f5277] via-[#1c4466] to-[#0d1a2c]"}
    >
      {top
        ? <>
            <Glow x={330} y={40} r={150} color="violet" />
            <Glow x={60} y={260} r={170} color="teal" />
            <Glow x={200} y={110} r={90} color="white" />
          </>
        : <>
            <Glow x={20} y={20} r={170} color="teal" />
            <Glow x={300} y={200} r={140} color="violet" />
          </>}
    </View>
  );
}

// ---- status bar ------------------------------------------------------------------

export interface StatusBarProps {
  width: number;
  carrier: string;
  /** 0..3 Wi-Fi bars; -1 hides the fan (radio off). */
  bars: Accessor<number>;
  time: Accessor<string>;
  /** Right-hand label (link state). */
  right: Accessor<string>;
  /** Opaque iOS 6 grey (Settings) instead of black translucent (lock screen). */
  opaque?: boolean;
}

/** The 16 px status bar: carrier and Wi-Fi bars, the time centered, the
 *  link state on the right. */
export function StatusBar(props: StatusBarProps) {
  const bar = (index: number, x: number, h: number) => (
    <View
      class={props.bars() > index ? "absolute w-[3] bg-white" : "absolute w-[3] bg-[#ffffff40]"}
      style={{ insetL: x, insetT: 12 - h, height: h }}
    />
  );
  return (
    <View
      class={props.opaque
        ? "absolute left-0 top-0 h-[16] bg-gradient-to-b from-[#4a5a71] to-[#25303f]"
        : "absolute left-0 top-0 h-[16] bg-[#00000090]"}
      style={{ width: props.width }}
    >
      <Text class="absolute left-[5] top-[1] text-xs text-white font-bold">{props.carrier}</Text>
      <View class={props.bars() < 0 ? "hidden" : "absolute left-[50] top-[2] w-[16] h-[12]"}>
        {bar(0, 0, 4)}
        {bar(1, 4, 7)}
        {bar(2, 8, 10)}
      </View>
      <Text class="absolute top-[1] text-xs text-white font-bold text-center" style={{ insetL: 0, width: props.width }}>{props.time()}</Text>
      <Text class="absolute top-[1] text-xs text-white font-bold text-right" style={{ insetL: props.width - 186, width: 180 }}>{props.right()}</Text>
    </View>
  );
}

// ---- icon tiles ------------------------------------------------------------------

export type Glyph =
  | "art/gear.svg" | "art/wifi.svg" | "art/laptop.svg" | "art/apps.svg" | "art/info.svg"
  | "art/clock.svg" | "art/camera.svg" | "art/download.svg";

export interface TileProps {
  x: number;
  y: number;
  size: number;
  from: string;
  to: string;
  glyph?: Glyph;
  /** Letters drawn when there is no glyph (generated app icons). */
  letters?: string;
  /** Darkened while pressed. */
  dim?: Accessor<boolean>;
  shadow?: boolean;
}

/** A glossy rounded-square icon: a vertical tint gradient, the iOS 6 gloss
 *  arc over the top half, a white glyph or letters, a darkening wash while
 *  pressed. */
export function Tile(props: TileProps) {
  const r = Math.round(props.size * 0.22);
  const glyph = Math.round(props.size * 0.72);
  const letterSlot = props.size >= 40 ? "large" : "small";
  return (
    <>
      <View
        class={props.shadow ? "absolute shadow" : "absolute"}
        style={{ insetL: props.x, insetT: props.y, width: props.size, height: props.size, radius: r, gradDir: 1, gradFrom: props.from, gradTo: props.to }}
      />
      <Show when={props.glyph}>
        {(src) => (
          <Image
            class="absolute"
            src={src()}
            style={{ insetL: props.x + (props.size - glyph) / 2, insetT: props.y + (props.size - glyph) / 2, width: glyph, height: glyph }}
          />
        )}
      </Show>
      <Show when={!props.glyph && props.letters}>
        <Text
          class={letterSlot === "large" ? "absolute text-xl text-[#00000040] font-bold text-center" : "absolute text-sm text-[#00000040] font-bold text-center"}
          style={{ insetL: props.x, insetT: props.y + (letterSlot === "large" ? props.size / 2 - 12 + 1 : props.size / 2 - 9 + 1), width: props.size }}
        >
          {props.letters}
        </Text>
        <Text
          class={letterSlot === "large" ? "absolute text-xl text-white font-bold text-center" : "absolute text-sm text-white font-bold text-center"}
          style={{ insetL: props.x, insetT: props.y + (letterSlot === "large" ? props.size / 2 - 12 : props.size / 2 - 9), width: props.size }}
        >
          {props.letters}
        </Text>
      </Show>
      <Image class="absolute" src="art/gloss.svg" style={{ insetL: props.x, insetT: props.y, width: props.size, height: props.size }} />
      <View
        class={props.dim?.() ? "absolute bg-[#00000070]" : "hidden"}
        style={{ insetL: props.x, insetT: props.y, width: props.size, height: props.size, radius: r }}
      />
    </>
  );
}

/** Deterministic icon tint and letters for an app that ships no icon. */
export function appTint(id: string, title: string): { from: string; to: string; letters: string } {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193) >>> 0;
  const hue = hash % 360;
  const letters = title
    .replace(/[^A-Za-z0-9 ]/g, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("") || "?";
  return { from: hsl(hue, 0.62, 0.62), to: hsl(hue, 0.7, 0.36), letters };
}

function hsl(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

// ---- switch ----------------------------------------------------------------------

export const SWITCH_W = 62;
export const SWITCH_H = 22;

/** The iOS 6 ON/OFF switch: a blue "ON" or grey "OFF" pill and a white knob. */
export function Switch(props: { x: number; y: number; on: Accessor<boolean> }) {
  return (
    <>
      <View
        class={props.on()
          ? "absolute w-[62] h-[22] rounded-[11] border border-[#1b4fa3] bg-gradient-to-b from-[#1d5bc6] via-[#3a84ea] to-[#5aa0f4]"
          : "absolute w-[62] h-[22] rounded-[11] border border-[#a9a9a9] bg-gradient-to-b from-[#d5d5d5] via-[#ececec] to-[#fbfbfb]"}
        style={{ insetL: props.x, insetT: props.y }}
      />
      <Text
        class={props.on() ? "absolute text-xs text-white font-bold text-center" : "absolute text-xs text-[#7f7f7f] font-bold text-center"}
        style={{ insetL: props.on() ? props.x + 6 : props.x + 26, insetT: props.y + 4, width: 30 }}
      >
        {props.on() ? "ON" : "OFF"}
      </Text>
      <View
        class="absolute w-[22] h-[22] rounded-[11] border border-[#9c9c9c] bg-gradient-to-b from-[#ffffff] to-[#dcdcdc]"
        style={{ insetL: props.on() ? props.x + SWITCH_W - SWITCH_H : props.x, insetT: props.y }}
      />
    </>
  );
}

/** Wi-Fi strength as three rising bars (lit: 0..3). */
export function Bars(props: { x: number; y: number; level: Accessor<number>; white?: Accessor<boolean> }) {
  const bar = (index: number, h: number) => (
    <View
      class={props.white?.()
        ? props.level() > index ? "absolute w-[3] bg-white" : "absolute w-[3] bg-[#ffffff60]"
        : props.level() > index ? "absolute w-[3] bg-[#38547f]" : "absolute w-[3] bg-[#c0c6ce]"}
      style={{ insetL: props.x + index * 4, insetT: props.y + 10 - h, height: h }}
    />
  );
  return <>{bar(0, 4)}{bar(1, 7)}{bar(2, 10)}</>;
}

export type Children = JSX.Element;
