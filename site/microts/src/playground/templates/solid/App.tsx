import { Text, View } from "@pocketjs/framework/solid/components";
import { presses, press, reset } from "./App";

export default function App() {
  return (
    <View class="w-full h-full flex-col gap-2 p-4 bg-slate-900">
      <Text class="text-xl text-white font-bold">Hello, MicroTS</Text>
      <Text class="text-sm text-slate-400">Edit App.tsx and App.ts</Text>
      <View class="flex-row flex-wrap gap-2">
        <View class="px-3 py-1 rounded-lg bg-blue-600 focus:bg-blue-400" focusable onPress={() => press()}>
          <Text class="text-base text-white">Pressed {presses()} times</Text>
        </View>
        <View class="px-3 py-1 rounded-lg bg-slate-700 focus:bg-slate-500" focusable onPress={() => reset()}>
          <Text class="text-base text-white">Reset</Text>
        </View>
      </View>
    </View>
  );
}
