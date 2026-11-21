import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import {
  createTextLayout,
  type TextLayoutState,
} from "@pocketjs/framework/text-layout";
const source =
  "Portable Rust text layout runs on a companion worker. The device keeps handling input and frames while requests are queued. The same package fonts and source coordinates are used by native and WASM providers.";
function App() {
  const [layout, setLayout] = createSignal<TextLayoutState>({
    status: "companion-required",
    revision: 0,
  });
  const [frames, setFrames] = createSignal(0);
  let ticks = 0;
  const document = createTextLayout(setLayout);
  document.update(source, { slot: 1, width: 430 });
  onCleanup(document.dispose);
  onFrame(() => {
    if (++ticks % 60 === 0) setFrames(ticks);
  });
  const rows = () => {
    const value = layout();
    return value.status === "ready" ? value.rows : [];
  };
  return (
    <View class="w-full h-full bg-slate-950 p-4 gap-2 flex-col">
      <Text class="text-lg text-white font-bold">Portable text layout</Text>
      <Text class="text-sm text-slate-300">{`Frames: ${frames()} | ${layout().status}`}</Text>
      {layout().status === "companion-required" ? (
        <Text class="text-sm text-amber-300">
          Pair the text companion to continue.
        </Text>
      ) : null}
      {rows().map((row) => (
        <Text class="text-sm text-white">{source.slice(row.from, row.to)}</Text>
      ))}
    </View>
  );
}
mount(() => <App />);
