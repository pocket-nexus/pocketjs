import { Show } from "solid-js";
import { ActionHandler, Text, View } from "@pocketjs/framework/solid/components";
import { BTN } from "@pocketjs/framework/input";
import { delay, live, open, held, press, hold, release, combo, record, toggleLive, toggleOpen } from "./App";
export default function App() {
  return <View>
    <Text>held:{held()}</Text>
    <View focusable debugName="First" onPress={() => record("first")}><Text>first</Text></View>
    <View focusable debugName="Second" onPress={() => record("second")}><Text>second</Text></View>
    <ActionHandler button={BTN.CROSS} holdMs={delay()} repeatMs={50} onPress={(pressed, buttons) => press(pressed, buttons)} onHold={(mask, buttons) => hold(mask, buttons)} onRelease={release} />
    <ActionHandler button={BTN.CIRCLE} onPress={combo} />
    <ActionHandler button={BTN.SQUARE} active={live()} onPress={() => record("square:press")} onHold={() => record("square:hold")} onRelease={() => record("square:release")} />
    <ActionHandler button={BTN.TRIANGLE} onPress={() => toggleLive()} />
    <ActionHandler button={BTN.SELECT} onPress={() => toggleOpen()} />
    <Show when={open()}>
      <ActionHandler button={BTN.START} latched onPress={() => record("start:press")} onRelease={() => record("start:release")} />
    </Show>
  </View>;
}
