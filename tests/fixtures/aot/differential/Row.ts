import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";
import { live, setLive, trace } from "./App.ts";
let nextId = 0;
export function createRow() {
  const id = ++nextId;
  const [presses, setPresses] = createSignal<i32>(0);
  trace.push("create:" + id);
  setLive(live() + 1);
  function load(): void { trace.push("mount:" + id); }
  function release(): void { trace.push("unmount:" + id); setLive(live() - 1); }
  function press(): string { setPresses(presses() + 1); const value = `${id}:${presses()}`; trace.push("press:" + value); return value; }
  return { presses, press, load, release };
}
