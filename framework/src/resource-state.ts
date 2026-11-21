/** A value's availability, independent of its transport or UI framework. */
export type ResourceState<T> =
  | { status: "pending" }
  | { status: "ready"; value: T }
  | { status: "error"; error: unknown };

const PENDING = Object.freeze({ status: "pending" as const });
export const pending = <T = never>(): ResourceState<T> => PENDING;
export const ready = <T>(value: T): ResourceState<T> => ({ status: "ready", value });
export const failed = <T = never>(error: unknown): ResourceState<T> => ({ status: "error", error });

/** Completion tickets fence superseded requests and disposed resources.
 * The caller owns scheduling, cancellation and any native texture lifetime. */
export function createResourceSlot<T>(changed: () => void = () => {}) {
  let generation = 0;
  let disposed = false;
  let state: ResourceState<T> = pending();
  const publish = (next: ResourceState<T>) => { state = next; changed(); };
  return {
    state: () => state,
    begin() {
      if (disposed) return 0;
      generation++;
      publish(pending());
      return generation;
    },
    resolve(ticket: number, value: T) {
      if (disposed || !ticket || ticket !== generation || state.status !== "pending") return false;
      publish(ready(value));
      return true;
    },
    reject(ticket: number, error: unknown) {
      if (disposed || !ticket || ticket !== generation || state.status !== "pending") return false;
      publish(failed(error));
      return true;
    },
    dispose() { disposed = true; generation++; state = pending(); },
  };
}
