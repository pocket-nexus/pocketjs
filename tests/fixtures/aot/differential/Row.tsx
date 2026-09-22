import { ActionHandler, Text, View } from "@pocketjs/framework/solid/components";
import { onCleanup, onMount } from "@pocketjs/framework/solid/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { createRow } from "./Row";
export default function Row(props: { label: string; onSaved?: (value: string) => void }) {
  const { presses, press, load, release } = createRow();
  onMount(() => load());
  onCleanup(() => release());
  return <View><Text>{props.label}:{presses()}</Text><ActionHandler button={BTN.CROSS} onPress={() => props.onSaved?.(press())} /></View>;
}
