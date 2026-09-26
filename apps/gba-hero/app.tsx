import { Show } from "solid-js";
import { ActionHandler, Image, Text, View } from "@pocketjs/framework/solid/components";
import { onMount } from "@pocketjs/framework/solid/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { count, phase, press, reset, start, underline } from "./app";

export default function App() {
  onMount(start);
  return (
    <View debugName="HeroScreen" class="w-full h-full bg-gradient-to-b from-slate-50 to-slate-100">
      <ActionHandler button={BTN.CROSS} onPress={reset} />
      <Image class="absolute left-[8] top-[8] w-[24] h-[24] rounded-lg shadow" src="logo.png" />
      <View class="absolute left-[40] top-[7] flex-col">
        <Text class="text-sm font-bold text-slate-950">PocketJS</Text>
        <Text class="text-xs text-slate-500">MICROTS + GBA</Text>
      </View>
      <View class="absolute right-[8] top-[5] flex-col items-end">
        <Text class="text-lg font-bold text-emerald-600">30</Text>
        <Text class="text-xs text-slate-500">FPS target</Text>
      </View>
      <Text class="absolute left-[8] top-[44] text-xs text-blue-600">ONE RUST CORE / ONE TSX APP</Text>
      <Text class="absolute left-[8] top-[59] text-xl font-bold text-slate-950">JSX on GBA.</Text>
      <View debugName="Spinner" class="absolute left-[200] top-[58] w-[32] h-[32]">
        <Show when={phase() === 0}><Image class="w-[32] h-[32]" src="spinner-00.svg" /></Show>
        <Show when={phase() === 1}><Image class="w-[32] h-[32]" src="spinner-01.svg" /></Show>
        <Show when={phase() === 2}><Image class="w-[32] h-[32]" src="spinner-02.svg" /></Show>
        <Show when={phase() === 3}><Image class="w-[32] h-[32]" src="spinner-03.svg" /></Show>
        <Show when={phase() === 4}><Image class="w-[32] h-[32]" src="spinner-04.svg" /></Show>
        <Show when={phase() === 5}><Image class="w-[32] h-[32]" src="spinner-05.svg" /></Show>
        <Show when={phase() === 6}><Image class="w-[32] h-[32]" src="spinner-06.svg" /></Show>
        <Show when={phase() === 7}><Image class="w-[32] h-[32]" src="spinner-07.svg" /></Show>
      </View>
      <View ref={underline} debugName="Underline" class="absolute left-[8] top-[87] h-[3] w-0 rounded-[2px] shadow bg-gradient-to-r from-blue-500 to-cyan-500" style={{ translateX: count() * 2 }} />
      <Text class="absolute left-[8] top-[98] text-xs text-slate-600">TSX + flexbox, 2001 hardware.</Text>
      <View debugName="HeroAction" class="absolute left-[8] top-[118] w-[80] h-[24] items-center justify-center rounded-lg shadow-md bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150" focusable onPress={press}>
        <Text class="text-xs font-bold text-white">Press A</Text>
      </View>
      <View debugName="Counter" class="absolute left-[100] top-[123] w-[82] h-[15]">
        <Text class="text-xs text-slate-600">Count: {count()}</Text>
      </View>
      <Text class="absolute left-[185] top-[123] text-xs text-slate-500">B: Reset</Text>
      <View debugName="ReactiveMessage" class="absolute left-[8] top-[145] w-[224] h-[15]">
        <Show when={count() > 3}><Text class="text-xs text-emerald-600">Reactive on GBA.</Text></Show>
      </View>
    </View>
  );
}
