import type { ImeState, ImeCandidatePage } from "@pocketjs/framework/ime";
import type { Scroller } from "@pocketjs/framework/kinetics";

export const CANDIDATE_ROW_H = 44;
export interface CandidateCell { index: number; text: string; x: number; y: number; w: number; pending: boolean; divider: boolean }
/** Keep surviving rows in their mounted slots; recycle only departed cells. */
export function candidateSlots(current: readonly (CandidateCell | null)[], visible: readonly CandidateCell[]): (CandidateCell | null)[] {
  const key = (cell: CandidateCell) => `${cell.index}:${cell.y}`;
  const remaining = new Map(visible.map(cell => [key(cell), cell]));
  const next = current.map(cell => {
    const id = cell && key(cell), keep = id ? remaining.get(id) : undefined;
    if (id && keep) remaining.delete(id);
    return keep ?? null;
  });
  const incoming = remaining.values();
  for (let i = 0; i < next.length; i++) if (!next[i]) next[i] = incoming.next().value ?? null;
  return next;
}
export function candidateGrid(words: readonly string[], width: number, placeholders = 0, firstIndex = 0): CandidateCell[] {
  let x = 0, y = 0;
  const result: CandidateCell[] = [];
  for (let index = firstIndex; index < words.length + placeholders; index++) {
    const text = words[index] ?? "", scalars = Array.from(text), w = Math.min(width, Math.max(64, scalars.length * 16 + 24));
    if (x + w > width) { x = 0; y += CANDIDATE_ROW_H; }
    const chars = Math.max(1, Math.floor((width - 24) / 16));
    if (scalars.length > chars) {
      for (let from = 0; from < scalars.length; from += chars) {
        result.push({ index, text: scalars.slice(from, from + chars).join(""), x: 0, y, w: width, pending: false, divider: from + chars >= scalars.length });
        y += CANDIDATE_ROW_H;
      }
      x = 0;
    } else { result.push({ index, text, x, y, w, pending: index >= words.length, divider: true }); x += w; }
  }
  return result;
}

/** Scroll/tap ownership and bounded read windows, independent of key actions. */
export function createCandidatePanel(options: {
  width: number; height: number; scroller: Scroller;
  firstIndex?: number | (() => number);
  browse(offset: number, complete: (page: ImeCandidatePage | null) => void): number;
  select(index: number): void;
}) {
  let state: ImeState | undefined, chinese = false, open = false, epoch = 0, loaded = 0, last = false, loading = false, retry = 0;
  let words: string[] = [], cells: CandidateCell[] = [], contact: { id: number; x: number; y: number; lastY: number; at: number; velocity: number; moved: boolean; epoch: number } | undefined;
  const empty: CandidateCell[] = [];
  let visibleCells = empty, visibleSource = cells, visibleStart = -1, visibleEnd = -1;
  const scroll = options.scroller;
  function layout() {
    const first = typeof options.firstIndex === "function" ? options.firstIndex() : options.firstIndex;
    const next = candidateGrid(words, options.width, last ? 0 : 10, first);
    cells = next.map((cell, i) => {
      const old = cells[i];
      return old && old.index === cell.index && old.text === cell.text && old.x === cell.x && old.y === cell.y &&
        old.w === cell.w && old.pending === cell.pending && old.divider === cell.divider ? old : cell;
    });
  }
  function bound(y: number, after: boolean) {
    let lo = 0, hi = cells.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (after ? cells[mid].y <= y : cells[mid].y < y) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function close() { open = false; contact = undefined; scroll.endDrag(0); scroll.scrollTo(0, { immediate: true }); }
  return {
    setState(next: ImeState, mode: boolean) {
      if (state?.revision !== next.revision) {
        epoch++; words = []; loaded = 0; last = false; loading = false; retry = 0; contact = undefined;
        scroll.endDrag(0); scroll.scrollTo(0, { immediate: true });
      }
      state = next; chinese = mode;
      if (!loaded && !next.pending && next.page === 0) words = next.candidates.slice();
      if (!mode || !next.composing || !next.connected || next.error) close();
      layout();
    },
    toggle() { if (!chinese || !state?.composing || !state.connected || state.error) return; open ? close() : open = true; },
    close,
    isOpen: () => open,
    max: () => Math.max(0, (cells.at(-1)?.y ?? 0) + CANDIDATE_ROW_H - options.height),
    visible() {
      if (!open) return empty;
      const start = bound(scroll.offset() - CANDIDATE_ROW_H * 2, true), end = bound(scroll.offset() + options.height + CANDIDATE_ROW_H, false);
      if (visibleSource !== cells || visibleStart !== start || visibleEnd !== end) {
        visibleSource = cells; visibleStart = start; visibleEnd = end; visibleCells = cells.slice(start, end);
      }
      return visibleCells;
    },
    offset: scroll.offset,
    step() {
      if (!open) return;
      scroll.step();
      if (retry > 0) { retry--; return; }
      if (!state || state.pending || !state.connected || loading || last || loaded >= 512) return;
      const lastLoadedY = cells.findLast(c => c.index < loaded)?.y ?? 0;
      if (loaded && lastLoadedY > scroll.offset() + options.height + CANDIDATE_ROW_H * 2) return;
      const version = epoch;
      loading = true;
      const id = options.browse(loaded, page => {
        if (version !== epoch) return;
        loading = false;
        if (!page) { retry = 60; return; }
        words = [...words.slice(0, page.offset), ...page.candidates]; loaded = words.length; last = page.last;
        layout();
      });
      if (!id) loading = false;
    },
    press(id: number, x: number, y: number, now: number) {
      if (contact || !open) return;
      contact = { id, x, y, lastY: y, at: now, velocity: 0, moved: false, epoch };
      scroll.beginDrag();
    },
    move(id: number, x: number, y: number, now: number) {
      if (contact?.id !== id) return;
      const c = contact, dy = c.lastY - y, dt = now - c.at;
      if (Math.hypot(x - c.x, y - c.y) > 6) c.moved = true;
      if (c.moved) { scroll.drag(dy); if (dt > 0) c.velocity = Math.max(-1800, Math.min(1800, dy / dt)); }
      c.lastY = y; c.at = now;
    },
    release(id: number, cancelled: boolean) {
      if (contact?.id !== id) return false;
      const c = contact; contact = undefined;
      scroll.endDrag(cancelled ? 0 : c.velocity);
      if (!cancelled && !c.moved && c.epoch === epoch) {
        const y = c.y + scroll.offset(), cell = cells.find(p => c.x >= p.x && c.x < p.x + p.w && y >= p.y && y < p.y + CANDIDATE_ROW_H);
        if (cell && !cell.pending && !state?.pending) { options.select(cell.index); close(); }
      }
      return true;
    },
  };
}
