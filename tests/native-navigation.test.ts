import { expect, test } from "bun:test";
import { onNativeAppReturn, type NativeAppReturn } from "../framework/src/launcher.ts";

test("native handoff subscriptions can be removed out of order and restore the previous host callback", () => {
  const g = globalThis as any, previous = g.__pocketjsNativeReturn;
  const original: string[] = [], events: NativeAppReturn[] = [];
  const parent = (output: string) => original.push(output);
  g.__pocketjsNativeReturn = parent;
  const first = onNativeAppReturn(event => events.push(event));
  const second = onNativeAppReturn(event => events.push({ ...event, output: "second" }));
  try {
    first();
    g.__pocketjsNativeReturn("clear-main", "switcher", 7, 0, .05, -.04, .9);
    expect(events).toEqual([{ output: "second", destination: "switcher", shot: 7, error: 0, pose: { x: .05, y: -.04, scale: .9 } }]);
    expect(original).toEqual(["clear-main"]);
    second();
    first();
    expect(g.__pocketjsNativeReturn).toBe(parent);
  } finally { second(); first(); g.__pocketjsNativeReturn = previous; }
});
