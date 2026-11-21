// The lists screen: a full-content-height canvas of blue list rows plus the
// credit block hidden above the fold. The canvas and each row expose their
// NodeMirrors so app.tsx can drive scrolling, the vertical open/back
// transitions, and the long-pull reveal; the pending-count cells and the
// dimmed empty look ride per-list refs refreshed through refresh().

import { shallowRef } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { pendingCount, type TodoList } from "./model.ts";
import { listRowColors } from "./palette.ts";
import { ROW_H } from "./metrics.ts";

export interface ListsScreen {
  view: JSX.Element;
  /** Full content height (rows only; the credit hangs above y 0). */
  height: number;
  canvas(): NodeMirror | null;
  rowNode(index: number): NodeMirror | null;
  /** Re-read one list's pending count (or every list's) into the cells. */
  refresh(index?: number): void;
}

export function makeListsScreen(lists: TodoList[]): ListsScreen {
  let canvasNode: NodeMirror | null = null;
  const rowNodes: (NodeMirror | null)[] = lists.map(() => null);
  const counts = lists.map((l) => shallowRef(String(pendingCount(l))));
  const empty = lists.map((l) => shallowRef(pendingCount(l) === 0));

  function refresh(index?: number): void {
    for (let i = 0; i < lists.length; i += 1) {
      if (index !== undefined && i !== index) continue;
      const pending = pendingCount(lists[i]);
      counts[i].value = String(pending);
      empty[i].value = pending === 0;
    }
  }

  function renderListRow(title: string, i: number) {
    const [from, to] = listRowColors(i, lists.length);
    return (
      <View
        nodeRef={(node) => {
          rowNodes[i] = node ?? null;
        }}
        class="absolute left-0 right-0 top-0 h-[62]"
        style={{ translateY: i * ROW_H }}
      >
        <View
          class="absolute inset-0 bg-gradient-to-b from-[#1780f7] to-[#1780f7]"
          style={{ gradFrom: from, gradTo: to }}
        >
          <View class="absolute left-0 right-0 top-0 bg-[#ffffff12]" style={{ height: 1 }} />
          <View class="absolute left-0 right-0 bottom-0 bg-[#0000001a]" style={{ height: 1 }} />
          <View class="absolute inset-0 flex-row items-center pl-3">
            <Text class={empty[i].value ? "text-xl font-bold text-[#ffffff80]" : "text-xl font-bold text-white"}>
              {title}
            </Text>
          </View>
          <View class="absolute right-0 top-0 bottom-0 items-center justify-center bg-[#ffffff26]" style={{ width: ROW_H }}>
            <Text class={empty[i].value ? "text-xl font-bold text-[#ffffff80]" : "text-xl font-bold text-white"}>
              {counts[i].value}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  const view = (
    <View
      nodeRef={(node) => {
        canvasNode = node ?? null;
      }}
      class="absolute left-0 right-0 top-0"
      style={{ height: lists.length * ROW_H, zIndex: 1 }}
    >
      <View
        class="absolute left-0 right-0 flex-col items-center justify-center"
        style={{ translateY: -2.5 * ROW_H, height: ROW_H }}
      >
        <Text class="text-sm text-[#ffffff40] text-center">Made with PocketJS + Vue Vapor</Text>
        <Text class="text-sm text-[#ffffff40] text-center">Original by Evan You, iOS app by Realmac</Text>
      </View>
      {lists.map((l, i) => renderListRow(l.title, i))}
    </View>
  );

  return {
    view,
    height: lists.length * ROW_H,
    canvas: () => canvasNode,
    rowNode: (index) => rowNodes[index] ?? null,
    refresh,
  };
}
