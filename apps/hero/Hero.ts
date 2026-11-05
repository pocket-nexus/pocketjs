import { createSignal } from "solid-js";
import { animate, createNodeRef } from "@pocketjs/framework/animation";
import { after, imod, type i32 } from "@pocketjs/framework/solid/std";

export interface HeroViewProps {
  actionLabel: string;
  compact: boolean;
  deviceLabel: string;
  headline: string;
  largeLayout: boolean;
  onAction?: (count: i32) => void;
  presentationHz: i32;
  runtimeLabel: string;
  spinnerDelay: i32;
}

/** Each mounted Hero owns the same state in the JavaScript guest and MicroTS. */
export function createHero(underlineWidth: i32, offsetStep: i32, spinnerDelay: i32) {
  const [count, setCount] = createSignal<i32>(0);
  const [spinnerFrame, setSpinnerFrame] = createSignal<i32>(0);
  const underline = createNodeRef();

  function underlineOffset(): i32 {
    return imod(count(), 8) * offsetStep;
  }

  async function advanceSpinner(delay: i32): Promise<void> {
    // The wait is in milliseconds; changing the host frame rate preserves time.
    // MicroTS requires a bounded task; 100 ms waits cover over six years.
    for (let step: i32 = 0; step < 2147483647; step++) {
      await after(delay);
      setSpinnerFrame(imod(spinnerFrame() + 1, 8));
    }
  }

  function mountHero(): void {
    animate(underline, "width", underlineWidth, { dur: 700 as i32, easing: "out", delay: 150 as i32 });
    advanceSpinner(spinnerDelay);
  }

  function press(): void {
    setCount(count() + 1);
  }

  return { count, spinnerFrame, underlineOffset, underline, mountHero, press };
}
