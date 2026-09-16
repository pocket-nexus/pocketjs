import { Show } from "solid-js";
import { ActionHandler, AxisHandler, For, Text, View } from "@pocketjs/framework/solid/components";
import { onCleanup, onMount } from "@pocketjs/framework/solid/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { rows, open, setOpen, late, live, angle, removeNext, load, release, replace, reverse, rename, record, event, remove, armRemoval, restore, adjust } from "./App";
import Row from "./Row.tsx";
export default function App() {
  onMount(() => load());
  onCleanup(() => release());
  return <View class="bg-blue-600">
    <Text>live:{live()} angle:{angle()}</Text>
    <View focusable debugName="FocusCounter" onPress={() => record("focused")}><Text>focus</Text></View>
    <ActionHandler button={BTN.SELECT} onPress={() => setOpen(false)} />
    <ActionHandler button={BTN.SELECT} onPress={() => setOpen(true)} />
    <ActionHandler button={BTN.SQUARE} onPress={() => replace()} />
    <ActionHandler button={BTN.TRIANGLE} onPress={() => reverse()} />
    <ActionHandler button={BTN.START} onPress={() => armRemoval()} />
    <ActionHandler button={BTN.RTRIGGER} onPress={() => restore()} />
    <ActionHandler button={BTN.CROSS} active={removeNext()} onPress={() => remove()} />
    <AxisHandler axis="primary" onDelta={(delta) => adjust(delta)} />
    <Show when={late()}><Row label="late" /></Show>
    <Show when={open()}><Row label="branch" /></Show>
    <For each={rows()} by={(item) => item.id}>{(item, index) => <View>
      <Text>{index()}:{item().id}</Text>
      <ActionHandler button={BTN.SQUARE} onPress={() => record(item().label)} />
      <ActionHandler button={BTN.CROSS} onPress={() => { rename(item().id); record(item().label); }} />
      <ActionHandler button={BTN.CROSS} onPress={() => record(item().label)} />
      <Row label={item().label} onSaved={(value) => { event(value); record(value); record(value); }} />
      <For each={item().children} by={(nested) => nested.id}>{(nested) => <ActionHandler button={BTN.CROSS} onPress={() => record(nested().id)} />}</For>
    </View>}</For>
  </View>;
}
