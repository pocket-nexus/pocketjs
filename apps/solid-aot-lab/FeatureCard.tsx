import type { JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";

export default function FeatureCard(props: {
  title: string;
  badge?: JSX.Element;
  children?: JSX.Element;
  footer?: JSX.Element;
}) {
  return (
    <View debugName="FeatureCard" class="flex-1 flex-col gap-2 p-3 rounded-xl shadow-md bg-white border-slate-200">
      <View class="flex-row items-center justify-between">
        <Text class="text-sm text-slate-950 font-bold">{props.title}</Text>
        {props.badge}
      </View>
      {props.children}
      <View class="flex-row items-center justify-between">{props.footer}</View>
    </View>
  );
}
