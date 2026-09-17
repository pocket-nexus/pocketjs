import { createSignal, For } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import {
  INITIAL_KEYED_ROWS,
  keyedDelete,
  keyedInsert,
  keyedReorder,
} from "./keyed-list-model.ts";

function KeyedListFixture() {
  const [rows, setRows] = createSignal([...INITIAL_KEYED_ROWS]);
  const [operation, setOperation] = createSignal("READY");

  onButtonPress(BTN.SQUARE, () => {
    setRows(keyedInsert);
    setOperation("INSERT");
  });
  onButtonPress(BTN.TRIANGLE, () => {
    setRows(keyedReorder);
    setOperation("REORDER");
  });
  onButtonPress(BTN.CIRCLE, () => {
    setRows(keyedDelete);
    setOperation("DELETE");
  });

  return (
    <View debugName="KeyedListFixture" class="w-full h-full flex-col p-4 gap-3 bg-slate-100">
      <View class="h-8 flex-row justify-between">
        <Text class="text-lg text-slate-950 font-bold">KEYED LIST</Text>
        <Text class="text-sm text-blue-600 font-bold">{operation()}</Text>
      </View>
      <View debugName="KeyedRows" class="flex-col gap-2">
        <For each={rows()}>
          {(row) => (
            <View debugName={`KeyedRow:${row.id}`} class="h-8 flex-row gap-3 px-2 py-1 bg-white border-slate-300">
              <View class={row.swatchClass} />
              <Text class="w-24 text-sm text-slate-950 font-bold">{row.label}</Text>
              <Text class="text-sm text-slate-600">{row.detail}</Text>
            </View>
          )}
        </For>
      </View>
    </View>
  );
}

mount(() => <KeyedListFixture />);
