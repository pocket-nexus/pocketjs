// apps/home/ui/bar.tsx — the iOS 6 navigation bar at the 3DS's 0.82 scale:
// a two-band gloss in blue, black or orange, an embossed title (or a title
// view such as a segmented control), an arrow back button and an optional
// right button. It names no image asset.
//
// Every `class` is one complete literal — the compiler bakes a class table,
// so a state change picks between two whole literals instead of building one.

import { Show, type Accessor, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
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

function BackButton(props: { button: NavButton; press: Press; tint: "blue" | "black" | "orange" }) {
  const w = barButtonWidth(props.button);
  const lit = () => props.press.is(props.button.id);
  const orange = props.tint === "orange";
  const black = props.tint === "black";
  return (
    <>
      <View
        class={orange
          ? lit() ? "absolute w-[17] h-[17] rounded-[3] border border-[#7a2f00] bg-[#b84d00]" : "absolute w-[17] h-[17] rounded-[3] border border-[#9a3d00] bg-[#ef7420]"
          : black
            ? lit() ? "absolute w-[17] h-[17] rounded-[3] border border-[#000000] bg-[#202020]" : "absolute w-[17] h-[17] rounded-[3] border border-[#000000] bg-[#3a3a3a]"
            : lit() ? "absolute w-[17] h-[17] rounded-[3] border border-[#2a3648] bg-[#4c5d77]" : "absolute w-[17] h-[17] rounded-[3] border border-[#3f4f66] bg-[#7b8ca5]"}
        style={{ insetL: 8.5, insetT: 9.5, rotate: 45 }}
      />
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
        style={{ insetL: 17, insetT: 6, width: w - 12 }}
      />
      <View
        class={orange
          ? lit()
            ? "absolute w-[6] h-[22] bg-gradient-to-b from-[#d0620f] via-[#b84d00] to-[#a44300]"
            : "absolute w-[6] h-[22] bg-gradient-to-b from-[#ffa45e] via-[#ef7420] to-[#df620c]"
          : black
            ? lit()
              ? "absolute w-[6] h-[22] bg-gradient-to-b from-[#3a3a3a] via-[#202020] to-[#151515]"
              : "absolute w-[6] h-[22] bg-gradient-to-b from-[#6a6a6a] via-[#3a3a3a] to-[#2a2a2a]"
            : lit()
              ? "absolute w-[6] h-[22] bg-gradient-to-b from-[#6a7b95] via-[#53647e] to-[#45556d]"
              : "absolute w-[6] h-[22] bg-gradient-to-b from-[#9dabc0] via-[#7b8ca5] to-[#67788f]"}
        style={{ insetL: 17, insetT: 7 }}
      />
      {/* square the body's left corners where it meets the arrow */}
      <View
        class={orange ? "absolute w-[6] h-[1] bg-[#9a3d00]" : black ? "absolute w-[6] h-[1] bg-[#000000]" : lit() ? "absolute w-[6] h-[1] bg-[#2a3648]" : "absolute w-[6] h-[1] bg-[#3f4f66]"}
        style={{ insetL: 17, insetT: 6 }}
      />
      <View
        class={orange ? "absolute w-[6] h-[1] bg-[#9a3d00]" : black ? "absolute w-[6] h-[1] bg-[#000000]" : lit() ? "absolute w-[6] h-[1] bg-[#2a3648]" : "absolute w-[6] h-[1] bg-[#3f4f66]"}
        style={{ insetL: 17, insetT: 29 }}
      />
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

