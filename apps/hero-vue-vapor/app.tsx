import { onMounted, ref } from "vue";
import { Image, Sprite, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { frameworkName } from "@pocketjs/framework";

function Stat(props: { label: string; value: string; cls: string }) {
  return (
    <View class="flex-col items-end">
      <Text class={props.cls}>{props.value}</Text>
      <Text class="text-xs text-slate-500 tracking-wide">{props.label}</Text>
    </View>
  );
}

export default () => {
  const count = ref(0);
  let underline: NodeMirror | undefined;

  onMounted(() => {
    if (underline) animate(underline, "width", 210, { dur: 700, easing: "out", delay: 150 });
  });

  return (
    <View class="w-full h-full flex-col justify-between p-5 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-center justify-between">
        <View class="flex-row items-center gap-3">
          <Image class="w-10 h-10 rounded-lg shadow" src="logo.png" />
          <View class="flex-col">
            <Text class="text-base text-slate-950 font-bold tracking-wide">PocketJS</Text>
            <Text class="text-xs text-slate-500 tracking-wide">{frameworkName()} + RUST + SCEGU</Text>
          </View>
        </View>
        <View class="flex-row gap-4">
          <Stat label="FPS" value="60" cls="text-lg text-emerald-600 font-bold" />
          <Stat label="NODES" value="42" cls="text-lg text-blue-600 font-bold" />
          <Stat label="DRAWS" value="9" cls="text-lg text-amber-600 font-bold" />
        </View>
      </View>

      <View class="flex-col gap-2">
        <Text class="text-xs text-blue-600 tracking-wide">ONE RUST CORE - ONE VUE VAPOR APP</Text>
        <View class="flex-row items-center justify-between">
          <Text class="text-4xl text-slate-950 font-bold">JSX at 60 FPS.</Text>
          <Sprite class="w-10 h-10" sprite="spinner-atlas.svg" />
        </View>
        <View
          nodeRef={(node) => {
            underline = node ?? undefined;
          }}
          class="h-1 w-0 rounded-full shadow bg-gradient-to-r from-blue-500 to-cyan-500"
          style={{ translateX: count.value * 2 }}
        />
        <Text class="text-sm text-slate-600">
          Flexbox, springs and baked type - running through Vue Vapor.
        </Text>
      </View>

      <View class="flex-row items-center gap-4">
        <View
          class="px-4 py-2 rounded-xl shadow-md bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
          focusable
          onPress={() => {
            count.value++;
          }}
        >
          <Text class="text-base text-white font-bold">Press Circle</Text>
        </View>
        <Text class="text-sm text-slate-600">Count: {count.value}</Text>
        {count.value > 3 ? (
          <Text class="text-sm text-emerald-600">Reactive on real hardware.</Text>
        ) : null}
      </View>
    </View>
  );
};
