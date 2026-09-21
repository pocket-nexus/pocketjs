import { mergeProps } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import type { i32 } from "@pocketjs/framework/solid/std";

export default function ModelButton(raw: {
  label?: string;
  value: i32;
  onChange: (value: i32) => void;
}) {
  const props = mergeProps({ label: "VALUE +1" }, raw);
  return (
    <View
      debugName="ModelButton"
      class="flex-row items-center justify-between px-3 py-2 rounded-lg shadow bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
      focusable
      onPress={() => props.onChange(props.value + 1)}
    >
      <Text class="text-sm text-white font-bold">{props.label}</Text>
      <Text class="text-sm text-white font-bold">{props.value}</Text>
    </View>
  );
}
