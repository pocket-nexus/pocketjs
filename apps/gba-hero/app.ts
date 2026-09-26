import { createSignal } from "solid-js";
import { animate, createNodeRef } from "@pocketjs/framework/animation";
import { frames, type i32 } from "@pocketjs/framework/solid/std";

export const [count, setCount] = createSignal<i32>(0);
export const [phase, setPhase] = createSignal<i32>(0);
export const underline = createNodeRef();

export function press(): void {
  setCount(count() + 1);
}

export function reset(): void {
  setCount(0);
}

export function reveal(): void {
  animate(underline, "width", 144, { dur: 700 as i32, easing: "out", delay: 150 as i32 });
}

// MicroTS tasks use bounded loops. This bound covers over six years at 30 Hz;
// each iteration suspends, so the host does no work while the wait is pending.
export async function spin(): Promise<void> {
  for (let step: i32 = 0; step < 2147483647; step++) {
    // Alternating 2/1 ticks advances this adapter's atlas 20 times per
    // simulation second at the configured 30 Hz tick rate.
    await frames(2);
    setPhase(phase() === 7 ? 0 : phase() + 1);
    await frames(1);
    setPhase(phase() === 7 ? 0 : phase() + 1);
  }
}

export function start(): void {
  reveal();
  spin();
}
