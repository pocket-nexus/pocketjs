import { createSignal } from "solid-js";
import { animate, createNodeRef } from "@pocketjs/framework/animation";
import { type i32 } from "@pocketjs/framework/solid/std";

export const [count, setCount] = createSignal<i32>(0);
export const [phase, setPhase] = createSignal<i32>(0);
export const underline = createNodeRef();

export function press(): void {
  setCount(count() + 1);
}

export function reveal(): void {
  animate(underline, "width", 144, { dur: 700 as i32, easing: "out", delay: 150 as i32 });
}
