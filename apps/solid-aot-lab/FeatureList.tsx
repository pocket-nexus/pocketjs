import type { Accessor, JSX } from "solid-js";
import { For, View } from "@pocketjs/framework/solid/components";

export default function FeatureList<T extends { id: string }>(props: {
  items: T[];
  row: (props: { item: Accessor<T> }) => JSX.Element;
}) {
  return (
    <View class="flex-row gap-2">
      <For each={props.items} by={(item) => item.id}>
        {(item) => props.row({ item })}
      </For>
    </View>
  );
}
