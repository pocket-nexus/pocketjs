import { Text, View } from "@pocketjs/framework/solid/components";
import { count, setCount } from "./Counter";

export default function Counter() {
  return (
    <View class="w-full h-full flex-col gap-4 p-4 bg-slate-50">
      <Text class="text-lg text-slate-950">Count: {count()}</Text>
      <View class="p-2 rounded-lg bg-blue-600 focus:bg-blue-500" focusable
        onPress={() => setCount(count() + 1)}>
        <Text class="text-white">ADD ONE</Text>
      </View>
    </View>
  );
}
