/** Contact-owned keyboard holds; time is supplied by the PocketJS virtual clock. */
export const KEY_HOLD = { space: 0.20, backspace: 0.43, repeat: 0.085, fastAfter: 2, fastRepeat: 0.05,
  cursorPitch: 10, cursorHysteresis: 2, slop: 12 } as const;
type Kind = "space" | "backspace" | "other";
type Rect = { x: number; y: number; w: number; h: number };
type Hold = { kind: Kind; x: number; y: number; startX: number; startY: number; at: number;
  next: number; cancelled: boolean; consumed: boolean; rect: Rect };
export function createKeyboardTouch(handlers: {
  space(): void; backspace(): void; caret(direction: number): void;
  trackpad(active: boolean): void;
}) {
  const holds = new Map<number, Hold>();
  let cursorOwner: number | undefined, anchor = 0;
  function drag(hold: Hold) {
    const threshold = KEY_HOLD.cursorPitch / 2 + KEY_HOLD.cursorHysteresis;
    let steps = 0;
    while (Math.abs(hold.x - anchor) >= threshold && steps < 8) {
      const direction = hold.x > anchor ? 1 : -1;
      anchor += direction * KEY_HOLD.cursorPitch;
      handlers.caret(direction); steps++;
    }
    // A discontinuous input sample cannot create an unbounded catch-up loop.
    if (steps === 8) anchor = hold.x;
  }
  function release(id: number, cancelled = false) {
    const hold = holds.get(id);
    if (!hold) return;
    holds.delete(id);
    if (cursorOwner === id) { cursorOwner = undefined; handlers.trackpad(false); }
    else if (!cancelled && hold.kind === "space" && !hold.cancelled && !hold.consumed) handlers.space();
  }
  return {
    begin(id: number, x: number, y: number, kind: Kind, rect: Rect, now: number) {
      if (cursorOwner !== undefined || holds.size >= 8) return false;
      release(id, true);
      // A rolling two-thumb space/letter chord keeps text in down-edge order.
      for (const hold of holds.values()) if (hold.kind === "space" && !hold.cancelled && !hold.consumed) {
        hold.consumed = true; handlers.space();
      }
      holds.set(id, { kind, x, y, startX: x, startY: y, at: now, next: now + KEY_HOLD.backspace,
        cancelled: false, consumed: false, rect });
      if (kind === "backspace") handlers.backspace();
      return true;
    },
    move(id: number, x: number, y: number) {
      const hold = holds.get(id);
      if (!hold) return;
      hold.x = x; hold.y = y;
      if (cursorOwner === id) { drag(hold); return; }
      if (hold.kind === "space" && Math.hypot(x - hold.startX, y - hold.startY) > KEY_HOLD.slop) hold.cancelled = true;
      if (hold.kind === "backspace") {
        const r = hold.rect, s = KEY_HOLD.slop;
        if (x < r.x - s || x > r.x + r.w + s || y < r.y - s || y > r.y + r.h + s) hold.cancelled = true;
      }
    },
    step(now: number) {
      for (const [id, hold] of holds) {
        if (hold.cancelled || hold.consumed) continue;
        if (hold.kind === "space" && cursorOwner === undefined && now - hold.at + 1e-7 >= KEY_HOLD.space) {
          cursorOwner = id; hold.consumed = true; anchor = hold.x; handlers.trackpad(true);
        }
        if (hold.kind === "backspace" && cursorOwner === undefined) {
          let count = 0;
          while (now + 1e-7 >= hold.next && count < 2) {
            handlers.backspace(); count++;
            hold.next += now - hold.at >= KEY_HOLD.fastAfter ? KEY_HOLD.fastRepeat : KEY_HOLD.repeat;
          }
          if (count === 2 && hold.next < now) hold.next = now + KEY_HOLD.repeat;
        }
      }
    },
    release,
    cancel() { for (const id of holds.keys()) release(id, true); },
    tracking: () => cursorOwner !== undefined,
    holdingSpace() {
      for (const hold of holds.values()) if (hold.kind === "space" && !hold.cancelled) return true;
      return false;
    },
  };
}
