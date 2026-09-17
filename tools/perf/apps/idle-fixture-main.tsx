import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";

function IdleFixture() {
  return (
    <View debugName="IdleFixture" class="w-full h-full flex-col p-4 gap-4 bg-slate-100">
      <View class="h-8 flex-row justify-between">
        <Text class="text-lg text-slate-950 font-bold">STATIC DASHBOARD</Text>
        <Text class="text-sm text-emerald-600 font-bold">IDLE</Text>
      </View>
      <View class="h-[144] flex-row gap-4">
        <View class="w-[216] h-[144] flex-col p-3 gap-2 bg-white border-slate-300">
          <Text class="text-xs text-blue-600 font-bold">RUNTIME</Text>
          <Text class="text-base text-slate-950 font-bold">QuickJS</Text>
          <Text class="text-sm text-slate-600">No timers</Text>
          <Text class="text-sm text-slate-600">No animation</Text>
        </View>
        <View class="w-[216] h-[144] flex-col p-3 gap-2 bg-white border-slate-300">
          <Text class="text-xs text-blue-600 font-bold">RENDERER</Text>
          <Text class="text-base text-slate-950 font-bold">UiSurface</Text>
          <Text class="text-sm text-slate-600">Stable tree</Text>
          <Text class="text-sm text-slate-600">Stable DrawList</Text>
        </View>
      </View>
      <View class="h-8 flex-row justify-between">
        <Text class="text-xs text-slate-500">480 x 272</Text>
        <Text class="text-xs text-slate-500">NO INPUT</Text>
      </View>
    </View>
  );
}

mount(() => <IdleFixture />);
