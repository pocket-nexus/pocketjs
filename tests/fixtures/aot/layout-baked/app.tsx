import { Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/solid/components";
import { onMount } from "@pocketjs/framework/solid/lifecycle";
import { count, phase, press, reveal, underline } from "./app";

export default function App() {
  onMount(reveal);
  return (
    <View debugName="Page" class="w-full h-full layout-baked bg-slate-50">
      <View debugName="Header" class="absolute left-[40] top-[7] flex-col">
        <Text class="text-sm font-bold text-slate-950">PocketJS</Text>
      </View>
      <View debugName="Spinner" class="absolute left-[200] top-[58] w-[32] h-[32] contain-strict">
        <Show when={phase() === 0}><Image class="w-[32] h-[32]" src="spinner-00.svg" /></Show>
      </View>
      <View ref={underline} debugName="Underline" class="absolute left-[8] top-[87] h-[3] w-0 bg-blue-500" style={{ translateX: count() * 2 }} />
      <View debugName="Action" class="absolute left-[8] top-[118] w-[80] h-[24] items-center justify-center bg-blue-600 focus:bg-blue-500" focusable onPress={press}>
        <Text class="text-xs text-white">Press A</Text>
      </View>
      <View debugName="Counter" class="absolute left-[100] top-[123] w-[82] h-[15]">
        <Text class="text-xs w-[82] h-[15] text-slate-600">Count: {count()}</Text>
      </View>
      <View debugName="Message" class="absolute left-[8] top-[145] w-[224] h-[15]">
        <Show when={count() > 3}><Text class="absolute left-0 top-0 w-[224] h-[15] text-xs text-emerald-600">Reactive</Text></Show>
      </View>
    </View>
  );
}
