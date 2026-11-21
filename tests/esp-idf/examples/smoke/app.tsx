import { Text, View } from "@pocketjs/framework/solid/components";

export default function App() {
  return (
    <View class="w-full h-full bg-slate-950 items-center justify-center">
      <View class="w-48 h-24 rounded-xl bg-blue-600 items-center justify-center">
        <Text class="text-lg text-white font-bold">PocketJS · ESP-IDF</Text>
      </View>
    </View>
  );
}
