import { after } from "./clock.ts";

export interface CaretBlinkOptions {
  /** Receives visibility changes only. Bind this to a signal or native prop. */
  onChange(visible: boolean): void;
  /** Duration of each visible/hidden phase in virtual milliseconds. Default 500. */
  intervalMs?: number;
}

/**
 * A caret starts unfocused. Focus, typing and movement restart its visible
 * phase; a held drag keeps it visible. Uses one cancellable virtual-clock
 * deadline, with no per-frame UI writes. Call dispose when its owner unmounts.
 * Geometry, selection and the UI library remain the caller's responsibility.
 */
export function createCaretBlink(options: CaretBlinkOptions) {
  const interval = options.intervalMs ?? 500;
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new RangeError("PocketJS: caret intervalMs must be finite and positive");
  }
  let active = false, held = false, visible = false, disposed = false;
  let cancel: (() => void) | undefined;
  const emit = (next: boolean) => {
    if (visible === next) return;
    visible = next;
    options.onChange(next);
  };
  const stop = () => { cancel?.(); cancel = undefined; };
  const schedule = () => {
    if (disposed || !active || held) return;
    // onChange can synchronously reset through a reactive binding.
    stop();
    cancel = after(interval / 1000, () => {
      cancel = undefined;
      emit(!visible);
      schedule();
    });
  };
  const reset = () => {
    if (disposed) return;
    stop(); emit(active); schedule();
  };
  return {
    setActive(next: boolean) { if (next !== active && !disposed) { active = next; reset(); } },
    setHeld(next: boolean) { if (next !== held && !disposed) { held = next; reset(); } },
    reset,
    dispose() { if (!disposed) { disposed = true; stop(); emit(false); } },
  };
}
