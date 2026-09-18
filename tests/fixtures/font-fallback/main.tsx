import { Text, View } from "@pocketjs/framework/components";
import { mount } from "@pocketjs/framework/solid";

const runtimeCodepoint = (globalThis as typeof globalThis & {
  __fontFallbackCodepoint: number;
}).__fontFallbackCodepoint;
const runtimeText = String.fromCodePoint(runtimeCodepoint);

mount(() => (
  <View class="w-full h-full bg-slate-950">
    <Text class="w-[64] h-[32] text-base text-white">{runtimeText}</Text>
  </View>
));
