// Small component kit shared by every screen. Everything is absolutely
// positioned in the 400x240 logical viewport so layouts stay predictable.

import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Focusable, Image, Text, View } from "@pocketjs/framework/components";
import { buttonClass, toneClass, type Tone } from "../theme.ts";
import { textClass, type TextSize, type TextTone } from "./text-classes.ts";

export type Str = string | (() => string);

export function read(value: Str): string {
  return typeof value === "function" ? value() : value;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

// -- Text ----------------------------------------------------------------------

/** Centered text inside a fixed box. */
export function Label(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  text: Str;
  size?: TextSize;
  tone?: TextTone;
}): JSX.Element {
  return (
    <View
      class="absolute items-center justify-center"
      style={{ insetL: props.x, insetT: props.y, width: props.w, height: props.h }}
    >
      <Text class={textClass(props.size ?? "xs", props.tone ?? "ink")}>{read(props.text)}</Text>
    </View>
  );
}

/** Left-aligned text inside a fixed box. */
export function LeftLabel(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  text: Str;
  size?: TextSize;
  tone?: TextTone;
}): JSX.Element {
  return (
    <View
      class="absolute items-start justify-center"
      style={{ insetL: props.x, insetT: props.y, width: props.w, height: props.h }}
    >
      <Text class={textClass(props.size ?? "xs", props.tone ?? "ink")}>{read(props.text)}</Text>
    </View>
  );
}

// -- Pills and buttons ------------------------------------------------------------

export function Chip(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  text: Str;
  tone?: Tone;
  size?: TextSize;
  textTone?: TextTone;
}): JSX.Element {
  return (
    <View
      class={toneClass(props.tone ?? "soft")}
      style={{ insetL: props.x, insetT: props.y, width: props.w, height: props.h, radius: props.h / 2 }}
    >
      <Text class={textClass(props.size ?? "xs", props.textTone ?? "ink")}>{read(props.text)}</Text>
    </View>
  );
}

export function Button(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  text: Str;
  onPress: () => void;
  tone?: Tone;
  size?: TextSize;
  textTone?: TextTone;
  debugName?: string;
}): JSX.Element {
  return (
    <Focusable
      debugName={props.debugName}
      class={buttonClass(props.tone ?? "soft")}
      style={{ insetL: props.x, insetT: props.y, width: props.w, height: props.h, radius: props.h / 2 }}
      onPress={props.onPress}
    >
      <Text class={textClass(props.size ?? "xsb", props.textTone ?? "teal")}>{read(props.text)}</Text>
    </Focusable>
  );
}

/** Round icon-style button whose face is a short string (`<`, `>`, `+`). */
export function RoundButton(props: {
  x: number;
  y: number;
  size: number;
  text: Str;
  onPress: () => void;
  tone?: Tone;
  textTone?: TextTone;
  debugName?: string;
}): JSX.Element {
  return (
    <Button
      debugName={props.debugName}
      x={props.x}
      y={props.y}
      w={props.size}
      h={props.size}
      text={props.text}
      tone={props.tone ?? "soft"}
      textTone={props.textTone ?? "teal"}
      size="sm"
      onPress={props.onPress}
    />
  );
}

// -- Surfaces ---------------------------------------------------------------------

export function Panel(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <View
      class="absolute rounded-[16px] border border-[#cbdde3] bg-[#f7fafb] overflow-hidden"
      style={{ insetL: props.x, insetT: props.y, width: props.w, height: props.h }}
    >
      {props.children}
    </View>
  );
}

// -- Meters -----------------------------------------------------------------------

/** Ring gauge with a value inside and a caption below. */
// Gauge fills are sprites, one per 5 percent. The core rasterises a real arc into a variable
// number of spans every frame, so a changing arc repainted the whole screen on the board; an image
// swap only repaints the gauge. The names are literals so the build bakes them into the pak
// (regenerate with tools/assets/make_rings.py).
const RING_FILL = [
  "ring_00.png", "ring_01.png", "ring_02.png", "ring_03.png", "ring_04.png", "ring_05.png",
  "ring_06.png", "ring_07.png", "ring_08.png", "ring_09.png", "ring_10.png", "ring_11.png",
  "ring_12.png", "ring_13.png", "ring_14.png", "ring_15.png", "ring_16.png", "ring_17.png",
  "ring_18.png", "ring_19.png", "ring_20.png",
];

export function Ring(props: {
  x: number;
  y: number;
  value: () => string;
  percent: () => number;
  caption: Str;
}): JSX.Element {
  const percent = () => clampPercent(props.percent());
  const fill = () => RING_FILL[Math.round(percent() / 5)];
  return (
    <View class="absolute w-[48] h-[52]" style={{ insetL: props.x, insetT: props.y }}>
      <View class="absolute left-[8] top-[2] w-[32] h-[32] items-center justify-center">
        <Image class="absolute left-0 top-0 w-[32] h-[32]" src="ring_track.png" />
        <Image class="absolute left-0 top-0 w-[32] h-[32]" src={fill()} />
        <Text class={textClass("xsb", "ink")}>{props.value()}</Text>
      </View>
      <Label x={0} y={38} w={48} h={13} text={props.caption} size="xs" tone="sub" />
    </View>
  );
}

/** Horizontal fill bar. `fraction` is 0..1. */
export function Bar(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  fraction: () => number;
  trackClass?: "hub" | "night";
  fillTone?: "teal" | "coral" | "amber";
}): JSX.Element {
  const width = () => Math.max(0, Math.min(1, props.fraction())) * props.w;
  const track = () => (props.trackClass === "night" ? "absolute bg-[#1b3b57]" : "absolute bg-[#d5e0e4]");
  const fill = () => {
    if (props.fillTone === "coral") return "absolute left-0 top-0 h-full bg-[#ff6f7d]";
    if (props.fillTone === "amber") return "absolute left-0 top-0 h-full bg-[#ffc857]";
    return "absolute left-0 top-0 h-full bg-[#1d7974]";
  };
  return (
    <View
      class={track()}
      style={{ insetL: props.x, insetT: props.y, width: props.w, height: props.h, radius: props.h / 2 }}
    >
      <Show when={width() >= props.h}>
        <View class={fill()} style={{ width: width(), radius: props.h / 2 }} />
      </Show>
    </View>
  );
}

// -- Icons ------------------------------------------------------------------------

export function WifiIcon(props: { x: number; y: number; on: boolean }): JSX.Element {
  const bar = (i: number) => {
    const height = 4 + i * 3;
    return (
      <View
        class={props.on ? "absolute w-[3] rounded-[1px] bg-[#1d7974]" : "absolute w-[3] rounded-[1px] bg-[#b9cdd3]"}
        style={{ insetL: i * 5, insetT: 13 - height, height }}
      />
    );
  };
  return (
    <View class="absolute w-[18] h-[14]" style={{ insetL: props.x, insetT: props.y }}>
      {bar(0)}
      {bar(1)}
      {bar(2)}
      {bar(3)}
    </View>
  );
}

export function SunIcon(props: { x: number; y: number }): JSX.Element {
  return (
    <View class="absolute w-[16] h-[16]" style={{ insetL: props.x, insetT: props.y }}>
      <View class="absolute left-[4] top-[4] w-[8] h-[8] rounded-full bg-[#ff9f5a]" />
      <View class="absolute left-[7] top-0 w-[2] h-[3] bg-[#ff9f5a]" />
      <View class="absolute left-[7] bottom-0 w-[2] h-[3] bg-[#ff9f5a]" />
      <View class="absolute left-0 top-[7] w-[3] h-[2] bg-[#ff9f5a]" />
      <View class="absolute right-0 top-[7] w-[3] h-[2] bg-[#ff9f5a]" />
    </View>
  );
}

export function MenuIcon(props: { x: number; y: number }): JSX.Element {
  return (
    <View class="absolute w-[14] h-[10]" style={{ insetL: props.x, insetT: props.y }}>
      <View class="absolute left-0 top-0 w-[14] h-[2] rounded-full bg-[#1d7974]" />
      <View class="absolute left-0 top-[4] w-[14] h-[2] rounded-full bg-[#1d7974]" />
      <View class="absolute left-0 top-[8] w-[14] h-[2] rounded-full bg-[#1d7974]" />
    </View>
  );
}

/** Small vinyl-style disc. */
export function DiscIcon(props: { x: number; y: number; size: number; spin?: boolean }): JSX.Element {
  const inner = () => Math.round(props.size * 0.3);
  return (
    <View
      class="absolute border-2 border-[#1d7974] bg-[#eef5f7] items-center justify-center"
      style={{ insetL: props.x, insetT: props.y, width: props.size, height: props.size, radius: props.size / 2 }}
    >
      <View class="bg-[#1d7974]" style={{ width: inner(), height: inner(), radius: inner() / 2 }} />
    </View>
  );
}
