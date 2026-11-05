/** A bounded receiver window. Credit denotes capacity, never delivery. */
export class StreamCredit {
  private available: number;
  private waiter?: () => void;
  constructor(readonly capacity: number, readonly signal: AbortSignal) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8192) throw new Error("invalid stream window");
    this.available = capacity;
  }
  grant(bytes: number): boolean {
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > this.capacity - this.available) return false;
    this.available += bytes;
    this.waiter?.();
    return true;
  }
  async take(maximum: number): Promise<number> {
    while (this.available === 0) {
      this.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { this.waiter = undefined; reject(this.signal.reason); };
        this.waiter = () => { this.signal.removeEventListener("abort", abort); this.waiter = undefined; resolve(); };
        this.signal.addEventListener("abort", abort, { once: true });
        if (this.signal.aborted) abort();
      });
    }
    this.signal.throwIfAborted();
    const taken = Math.min(maximum, this.available);
    this.available -= taken;
    return taken;
  }
}
