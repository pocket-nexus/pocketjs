import { useContext } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import type { i32 } from "@pocketjs/framework/solid/std";
import { ThemeContext } from "./app";
import { createFeatureToggle } from "./FeatureToggle";

export default function FeatureToggle(props: {
  label: string;
  enabled: boolean;
  onToggle: (presses: i32) => void;
}) {
  const { presses, press } = createFeatureToggle();
  const theme = useContext(ThemeContext)!;
  return (
    <View
      debugName="FeatureToggle"
      class={props.enabled
        ? "flex-1 flex-row items-center justify-between px-2 py-[2] rounded-lg shadow bg-emerald-600 border-emerald-500 focus:bg-emerald-500"
        : "flex-1 flex-row items-center justify-between px-2 py-[2] rounded-lg shadow bg-slate-200 border-slate-300 focus:bg-blue-100"}
      focusable
      onPress={() => props.onToggle(press())}
    >
      <Text class={props.enabled ? "text-xs text-white font-bold" : "text-xs text-slate-600 font-bold"}>{props.label}</Text>
      <Text class={props.enabled ? "text-xs text-white" : "text-xs text-slate-500"}>
        {props.enabled ? theme().enabledLabel : "OFF"} · {presses()}
      </Text>
    </View>
  );
}
