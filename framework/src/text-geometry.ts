import type { RuntimeCaret, RuntimeTextLayout } from "../../contracts/spec/runtime-text.ts";

/** Every editor coordinate is selected from the layout used by drawing. */
export function textCaret(layout: RuntimeTextLayout, offset: number): RuntimeCaret {
  let best = layout.carets[0] ?? [0, 0, 0, 0] as const;
  for (const caret of layout.carets) {
    if (Math.abs(caret[0] - offset) <= Math.abs(best[0] - offset)) best = caret;
  }
  return best;
}
export function textHitTest(layout: RuntimeTextLayout, x: number, y: number): number {
  let row = 0;
  for (let i = 1; i < layout.rows.length; i++) {
    if (y >= layout.rows[i][3] - layout.baseline) row = i;
  }
  const carets = layout.carets.filter(c => c[3] === row);
  let best = carets[0];
  for (const caret of carets) if (!best || Math.abs(caret[1] - x) < Math.abs(best[1] - x)) best = caret;
  return best?.[0] ?? 0;
}
export function textSelection(layout: RuntimeTextLayout, from: number, to: number) {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  if (lo === hi) return [];
  return layout.rows.flatMap((row, index) => {
    if (hi <= row[0] || lo > row[1]) return [];
    const carets = layout.carets.filter(c => c[3] === index);
    const nearest = (offset: number) => carets.reduce<RuntimeCaret | undefined>((best, caret) =>
      !best || Math.abs(caret[0] - offset) < Math.abs(best[0] - offset) ? caret : best, undefined);
    const a = nearest(Math.max(lo, row[0])), b = nearest(Math.min(hi, row[1]));
    if (!a || !b) return [];
    return [{ x: Math.min(a[1], b[1]), y: a[2], width: Math.abs(a[1] - b[1]), height: layout.font.lineHeight, row: index }];
  });
}
/** Walk grapheme-safe caret stops supplied by the worker; never split UTF-16. */
export function textMoveCaret(layout: RuntimeTextLayout, offset: number, direction: -1 | 1): number {
  const offsets = [...new Set(layout.carets.map(c => c[0]))].sort((a, b) => a - b);
  return direction < 0 ? offsets.filter(x => x < offset).at(-1) ?? 0
    : offsets.find(x => x > offset) ?? layout.text.length;
}
