// Demo app + the jsx.d.ts typecheck fixture (bunx tsc --noEmit must pass).
// Uses all three public primitives, class literals, a dynamic style object,
// focus + onPress, and a signal in text — the exact surface phase v1 supports.

import { createEffect, createSignal, onMount, Show } from "solid-js";
import {
  Image,
  Sprite,
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { TICKS_PER_SECOND } from "@pocketjs/framework/clock";
import { frameworkName } from "@pocketjs/framework/solid";

function Stat(props: { label: string; value: string; cls: string; largeLayout?: boolean }) {
  return (
    <View class="flex-col items-end">
      <Text class={props.cls}>{props.value}</Text>
      <Text class={props.largeLayout
        ? "text-lg text-slate-500 tracking-wide"
        : "text-xs text-slate-500 tracking-wide"}>{props.label}</Text>
    </View>
  );
}

export interface HeroProps {
  actionLabel?: string;
  deviceLabel?: string;
  headline?: string;
  largeLayout?: boolean;
  onAction?: (count: number) => void;
  presentationHz?: number;
  runtimeLabel?: string;
  spinnerFrameStep?: number;
}

export default function Hero(props: HeroProps = {}) {
  const [count, setCount] = createSignal(0);
  createEffect(() => {
    const completedCount = count();
    if (completedCount > 0) props.onAction?.(completedCount);
  });
  let underline: NodeMirror | undefined;
  onMount(() => {
    // Underline sweeps in once on mount — native tween, zero steady-state JS.
    if (underline)
      animate(underline, "width", props.largeLayout ? 315 : 210, {
        dur: 700,
        easing: "out",
        delay: 150,
      });
  });
  return (
    <View
      debugName="HeroScreen"
      class={props.largeLayout
        ? "w-full h-full flex-col justify-between p-[30] bg-gradient-to-b from-slate-50 to-slate-100"
        : "w-full h-full flex-col justify-between p-5 bg-gradient-to-b from-slate-50 to-slate-100"}
    >
      <View
        debugName="Header"
        class="flex-row flex-wrap items-center justify-between"
      >
        <View class={props.largeLayout ? "flex-row items-center gap-[18]" : "flex-row items-center gap-3"}>
          <Image class={props.largeLayout
            ? "w-[60] h-[60] rounded-xl shadow"
            : "w-10 h-10 rounded-lg shadow"} src="logo.png" />
          <View class="flex-col">
            <Text class={props.largeLayout
              ? "text-2xl text-slate-950 font-bold tracking-wide"
              : "text-base text-slate-950 font-bold tracking-wide"}>
              PocketJS
            </Text>
            <Text class={props.largeLayout
              ? "text-lg text-slate-500 tracking-wide"
              : "text-xs text-slate-500 tracking-wide"}>
              {frameworkName()} + {props.runtimeLabel ?? "RUST + SCEGU"}
            </Text>
          </View>
        </View>
        <View class={props.largeLayout ? "flex-row gap-6" : "flex-row gap-4"}>
          <Stat
            label="FPS"
            value={String(props.presentationHz ?? TICKS_PER_SECOND)}
            cls={props.largeLayout
              ? "text-2xl text-emerald-600 font-bold"
              : "text-lg text-emerald-600 font-bold"}
            largeLayout={props.largeLayout}
          />
          <Stat
            label="NODES"
            value="42"
            cls={props.largeLayout
              ? "text-2xl text-blue-600 font-bold"
              : "text-lg text-blue-600 font-bold"}
            largeLayout={props.largeLayout}
          />
          <Stat
            label="DRAWS"
            value="9"
            cls={props.largeLayout
              ? "text-2xl text-amber-600 font-bold"
              : "text-lg text-amber-600 font-bold"}
            largeLayout={props.largeLayout}
          />
        </View>
      </View>

      <View class={props.largeLayout ? "flex-col gap-3" : "flex-col gap-2"}>
        <Text class={props.largeLayout
          ? "text-lg text-blue-600 tracking-wide"
          : "text-xs text-blue-600 tracking-wide"}>
          ONE RUST CORE · ONE JSX APP
        </Text>
        <View class="flex-row flex-wrap items-center justify-between">
          <Text class={props.largeLayout
            ? "text-5xl text-slate-950 font-bold"
            : "text-4xl text-slate-950 font-bold"}>
            {props.headline ?? `JSX at ${TICKS_PER_SECOND} FPS.`}
          </Text>
          <Sprite
            class={props.largeLayout ? "w-[60] h-[60]" : "w-10 h-10"}
            frameStep={props.spinnerFrameStep}
            sprite="spinner-atlas.svg"
          />
        </View>
        <View
          ref={underline}
          class={props.largeLayout
            ? "h-[6] w-0 rounded-full shadow bg-gradient-to-r from-blue-500 to-cyan-500"
            : "h-1 w-0 rounded-full shadow bg-gradient-to-r from-blue-500 to-cyan-500"}
          style={{ translateX: count() * (props.largeLayout ? 3 : 2) }}
        />
        <View
          debugName="Description"
          class="flex-row flex-wrap gap-1"
          style={{ gap: props.largeLayout ? 6 : 4 }}
        >
          <Text class={props.largeLayout ? "text-xl text-slate-600" : "text-sm text-slate-600"}>
            Flexbox, springs and baked type —
          </Text>
          <Text class={props.largeLayout ? "text-xl text-slate-600" : "text-sm text-slate-600"}>
            {props.deviceLabel ?? "running on a 2005 handheld."}
          </Text>
        </View>
      </View>

      <View
        class="flex-row flex-wrap items-center gap-4"
        style={{ gap: props.largeLayout ? 24 : 16 }}
      >
        <View
          class={props.largeLayout
            ? "px-6 py-3 rounded-[18px] shadow-md bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
            : "px-4 py-2 rounded-xl shadow-md bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"}
          focusable
          onPress={() => setCount(count() + 1)}
        >
          <Text class={props.largeLayout
            ? "text-2xl text-white font-bold"
            : "text-base text-white font-bold"}>
            {props.actionLabel ?? "Press Circle"}
          </Text>
        </View>
        <Text class={props.largeLayout ? "text-xl text-slate-600" : "text-sm text-slate-600"}>
          Count: {count()}
        </Text>
        <Show when={count() > 3}>
          <Text class={props.largeLayout ? "text-xl text-emerald-600" : "text-sm text-emerald-600"}>
            Reactive on real hardware.
          </Text>
        </Show>
      </View>
    </View>
  );
}
