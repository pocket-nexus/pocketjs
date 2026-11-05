// apps/devkit/app.tsx — the screen of Pocket Devkit, the wired development
// container for PS Vita. Its installed build is the recovery image: native
// builds from other projects run in its pocket-dev-a/b slots and JS/PAK
// packages replace its guest, all over the USB link (docs/VITA-USB.md).
// Reopening the LiveArea bubble returns here.

import { createSignal, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";

/** vitaTitleId("dev.pocket-nexus.devkit"): the title every tool addresses. */
const TITLE_ID = "P25BFE5E2";

const STEPS = [
  { n: "1", text: "Connect the USB cable to the computer" },
  { n: "2", text: "bun run vita:dev serve --app devkit" },
  { n: "3", text: "bun run vita:dev native --app devkit" },
];

/** The PocketJS mark from site/assets/favicon.svg, drawn with views. */
function Mark() {
  return (
    <View class="w-[64] h-[44] rounded-[13] bg-[#ffd23f] p-[5]">
      <View class="w-full h-full rounded-[9] bg-[#171226] flex-row items-center px-[8] gap-[6]">
        <View class="w-[12] h-[12] shrink-0 rounded-full bg-[#ff5f9e]" />
        <View class="flex-col gap-[4]">
          <View class="w-[20] h-[4] rounded-full bg-[#3fd0e8]" />
          <View class="w-[13] h-[4] rounded-full bg-[#ff5f9e]" />
        </View>
      </View>
    </View>
  );
}

export default function Devkit() {
  // A slow blink shows the process is alive while it waits for a build.
  const [frame, setFrame] = createSignal(0);
  onFrame(() => setFrame((frame() + 1) % 60));
  const lit = () => frame() < 36;

  return (
    <View debugName="Devkit" class="w-full h-full flex-col justify-between px-6 py-5 bg-[#171226]">
      <View class="flex-row items-center gap-4">
        <Mark />
        <View class="flex-col">
          <Text class="text-2xl text-white font-bold tracking-wide">Pocket Devkit</Text>
          <Text class="text-xs text-[#3fd0e8] tracking-wide">POCKETJS WIRED DEVELOPMENT CONTAINER</Text>
        </View>
      </View>

      <View class="flex-col gap-2">
        <View class="flex-row items-center gap-2">
          <View class="w-2 h-2 rounded-full bg-[#ff5f9e]" style={{ opacity: lit() ? 1 : 0.25 }} />
          <Text class="text-sm text-[#ffd23f] font-bold">Waiting for a build over USB</Text>
        </View>
        <For each={STEPS}>
          {(step) => (
            <View class="flex-row items-center gap-3">
              <Text class="w-[10] text-xs text-[#ff5f9e] font-bold">{step.n}</Text>
              <Text class="text-sm text-white">{step.text}</Text>
            </View>
          )}
        </For>
      </View>

      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-[#9a8fb8]">Title {TITLE_ID}</Text>
          <Text class="text-xs text-[#9a8fb8]">Reopen this bubble to return here</Text>
        </View>
        <Text class="text-xs text-[#9a8fb8]">L + R + SELECT  menu</Text>
      </View>
    </View>
  );
}
