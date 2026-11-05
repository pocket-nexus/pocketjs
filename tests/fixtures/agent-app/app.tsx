// tests/fixtures/agent-app — the app tests/agent-layer.test.ts runs the
// system agent's overlay over. It declares "system.agent" and imports nothing
// of the agent: the build adds the overlay.
//
// The touch screen shows a header with a count of R presses and six rows; a
// tap on a row names it in the footer. The top screen is the system's.

import { createSignal, For } from "solid-js";
import { AuxiliarySurface, Text, View } from "@pocketjs/framework/components";
import { auxiliaryTouches, BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";

const ROWS = ["Message 1", "Message 2", "Message 3", "Message 4", "Message 5", "Message 6"];
const HEADER = 32;
const ROW = 28;

export default function AgentFixture() {
  const [presses, setPresses] = createSignal(0);
  const [opened, setOpened] = createSignal("");
  let down: { x: number; y: number } | null = null;

  onButtonPress(BTN.RTRIGGER, () => setPresses(presses() + 1));
  onFrame(() => {
    const contact = auxiliaryTouches()[0];
    if (contact) {
      down ??= { x: contact.x, y: contact.y };
      return;
    }
    if (!down) return;
    const row = Math.floor((down.y - HEADER) / ROW);
    down = null;
    if (row >= 0 && row < ROWS.length) setOpened(`Opened ${ROWS[row]}`);
  });

  return (
    <AuxiliarySurface>
      <View class="w-[320] h-[240] flex-col bg-white">
        <View class="w-[320] h-[32] flex-row items-center justify-between px-[10] bg-slate-800">
          <Text class="text-sm font-bold text-white">Inbox</Text>
          <Text class="text-xs text-white">{`R presses: ${presses()}`}</Text>
        </View>
        <For each={ROWS}>
          {(row) => (
            <View class="w-[320] h-[28] flex-row items-center px-[10]">
              <Text class="text-sm text-slate-900">{row}</Text>
            </View>
          )}
        </For>
        <View class="w-[320] h-[40] flex-row items-center px-[10]">
          <Text class="text-sm text-slate-600">{opened() || "Nothing opened"}</Text>
        </View>
      </View>
    </AuxiliarySurface>
  );
}
