import { Show } from "solid-js";
import { ActionHandler, Text, View } from "@pocketjs/framework/solid/components";
import { BTN } from "@pocketjs/framework/input";
import { outer, inner, hits, toggle, press } from "./App";

export default function App() {
  return <View>
    <Text>hits:{hits()}</Text>
    <ActionHandler button={BTN.SELECT} onPress={toggle} />
    <Show when={outer()}>
      <View>
        <Show when={inner()}>
          <View focusable debugName="inner-focus" onPress={press}>
            <Text>target</Text>
          </View>
        </Show>
      </View>
    </Show>
  </View>;
}
