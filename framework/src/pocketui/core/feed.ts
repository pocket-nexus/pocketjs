// PocketUI core/feed.ts — a list of rows of unknown height that stays where
// the reader left it.
//
// A transcript's rows are as tall as their text wraps to, a row grows while
// its text streams in, older rows arrive above the ones on screen, and only
// the rows near the window exist. A list that keeps "the scroll offset"
// through all that jumps: every one of those changes moves what is at a
// given offset. This model keeps an anchor instead:
//
//   anchor   the first row that is at least partly in the window, and how
//            far into it the window's top edge is. After any change (rows
//            added above or below, a height learnt or changed) the offset
//            is recomputed so that row is where it was.
//   follow   while the reader is at the end, the end stays in view as rows
//            arrive and grow; scrolling up leaves follow, reaching the end
//            again re-enters it.
//
// A row not yet measured has an estimated height (the mean of the measured
// ones, or the `estimate` given). When a row is measured for the first time
// above the anchor, the offset moves by the error, so the estimate being
// wrong never shows as a jump; it shows only in the scroll bar's length.
//
// The model holds numbers only: no nodes, no framework. ui/feed.ts mounts
// the rows `window()` names and reports their heights back.

export interface FeedAnchor {
  key: string;
  /** how far below the row's top the window's top edge is */
  offset: number;
}

export interface FeedOptions {
  /** the height of a row never measured, until a mean exists */
  estimate?: number;
  /** room between rows */
  gap?: number;
  /** room before the first row and after the last */
  padStart?: number;
  padEnd?: number;
  /** within this many points of the end counts as at the end */
  slack?: number;
}

export class FeedModel {
  private keys: string[] = [];
  private index = new Map<string, number>();
  private heights = new Map<string, number>();
  private tops: number[] = [];
  private topsValid = false;
  private measuredSum = 0;
  private measuredCount = 0;
  private viewport = 0;
  private top = 0;
  private anchorKey: string | null = null;
  private anchorOffset = 0;
  private readonly baseEstimate: number;
  readonly gap: number;
  readonly padStart: number;
  readonly padEnd: number;
  private readonly slack: number;
  /** the end stays in view as content grows */
  following = true;

  constructor(options: FeedOptions = {}) {
    this.baseEstimate = options.estimate ?? 60;
    this.gap = options.gap ?? 0;
    this.padStart = options.padStart ?? 0;
    this.padEnd = options.padEnd ?? 0;
    this.slack = options.slack ?? 4;
  }

  get count(): number {
    return this.keys.length;
  }

  keyAt(index: number): string | undefined {
    return this.keys[index];
  }

  indexOf(key: string): number {
    return this.index.get(key) ?? -1;
  }

  /** The height a row is laid out with: measured, else the estimate. */
  heightOf(key: string): number {
    return this.heights.get(key) ?? this.estimate();
  }

  measured(key: string): boolean {
    return this.heights.has(key);
  }

  private estimate(): number {
    return this.measuredCount > 0 ? this.measuredSum / this.measuredCount : this.baseEstimate;
  }

  private layout(): void {
    if (this.topsValid) return;
    const tops = this.tops;
    tops.length = this.keys.length + 1;
    const estimate = this.estimate();
    let y = this.padStart;
    for (let i = 0; i < this.keys.length; i++) {
      tops[i] = y;
      y += (this.heights.get(this.keys[i]!) ?? estimate) + this.gap;
    }
    tops[this.keys.length] = this.keys.length > 0 ? y - this.gap + this.padEnd : this.padStart + this.padEnd;
    this.topsValid = true;
  }

  /** The content's whole height. */
  total(): number {
    this.layout();
    return this.tops[this.keys.length]!;
  }

  max(): number {
    return Math.max(0, this.total() - this.viewport);
  }

  topOf(index: number): number {
    this.layout();
    return this.tops[index]!;
  }

  get scrollTop(): number {
    return this.top;
  }

  atEnd(): boolean {
    return this.max() - this.top <= this.slack;
  }

  /** The first row whose bottom edge is below `y`. */
  private rowAt(y: number): number {
    this.layout();
    const tops = this.tops;
    let lo = 0;
    let hi = this.keys.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const bottom = tops[mid]! + this.heightOf(this.keys[mid]!);
      if (bottom > y) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  private takeAnchor(): void {
    if (this.keys.length === 0) {
      this.anchorKey = null;
      this.anchorOffset = 0;
      return;
    }
    const at = this.rowAt(this.top);
    this.anchorKey = this.keys[at]!;
    this.anchorOffset = this.top - this.topOf(at);
  }

  /** Recompute the offset from the anchor (or the end) after the layout changed. Returns how far the offset moved. */
  private settle(): number {
    const before = this.top;
    this.topsValid = false;
    const max = this.max();
    if (this.following) this.top = max;
    else if (this.anchorKey !== null && this.index.has(this.anchorKey)) {
      const at = this.index.get(this.anchorKey)!;
      const inside = Math.min(this.anchorOffset, this.heightOf(this.anchorKey) + this.gap);
      this.top = Math.min(max, Math.max(0, this.topOf(at) + inside));
    } else this.top = Math.min(max, Math.max(0, this.top));
    return this.top - before;
  }

  /** The rows, in order. Rows that kept their key keep their height. Returns how far the offset moved to keep the anchor in place. */
  setKeys(keys: readonly string[]): number {
    // an anchor row that is gone hands over to the nearest row after it that stays, else before it
    if (!this.following && this.anchorKey !== null) {
      const next = new Set(keys);
      if (!next.has(this.anchorKey)) {
        const from = this.index.get(this.anchorKey) ?? 0;
        let heir: string | null = null;
        for (let i = from + 1; i < this.keys.length && heir === null; i++) if (next.has(this.keys[i]!)) heir = this.keys[i]!;
        for (let i = from - 1; i >= 0 && heir === null; i--) if (next.has(this.keys[i]!)) heir = this.keys[i]!;
        this.anchorKey = heir;
        this.anchorOffset = 0;
      }
    }
    this.keys = keys.slice();
    this.index = new Map();
    for (let i = 0; i < keys.length; i++) this.index.set(keys[i]!, i);
    if (this.heights.size > keys.length * 2 + 64) {
      // forget rows long gone
      for (const key of this.heights.keys()) {
        if (!this.index.has(key)) {
          this.measuredSum -= this.heights.get(key)!;
          this.measuredCount--;
          this.heights.delete(key);
        }
      }
    }
    return this.settle();
  }

  /** A row's measured height. Returns how far the offset moved. */
  setHeight(key: string, height: number): number {
    const known = this.heights.get(key);
    if (known === height) return 0;
    if (known === undefined) this.measuredCount++;
    else this.measuredSum -= known;
    this.measuredSum += height;
    this.heights.set(key, height);
    return this.settle();
  }

  /** The window's height. Returns how far the offset moved. */
  setViewport(height: number): number {
    if (height === this.viewport) return 0;
    this.viewport = height;
    return this.settle();
  }

  /** The reader (or a fling) moved the window. Clamped to the content. */
  scrollTo(top: number): void {
    const max = this.max();
    this.top = Math.min(max, Math.max(0, top));
    this.following = max - this.top <= this.slack;
    this.takeAnchor();
  }

  /** Go to the end and stay there. */
  followEnd(): void {
    this.following = true;
    this.settle();
  }

  /** Put a row at the window's top (`start`), or bring it into view (`nearest`). */
  scrollToKey(key: string, align: "start" | "nearest" | "end" = "start", margin = 0): void {
    const at = this.index.get(key);
    if (at === undefined) return;
    const top = this.topOf(at);
    const bottom = top + this.heightOf(key);
    let to = this.top;
    if (align === "start") to = top - margin;
    else if (align === "end") to = bottom + margin - this.viewport;
    else if (top - margin < this.top) to = top - margin;
    else if (bottom + margin > this.top + this.viewport) to = bottom + margin - this.viewport;
    this.following = false;
    this.scrollTo(to);
  }

  /** Where the reader is, to keep across a remount: null while following the end. */
  anchor(): FeedAnchor | null {
    if (this.following || this.anchorKey === null) return null;
    return { key: this.anchorKey, offset: this.anchorOffset };
  }

  /** Return to a kept place. A key that is not a row leaves the feed following the end. */
  restore(anchor: FeedAnchor | null): void {
    if (anchor === null || !this.index.has(anchor.key)) {
      this.following = true;
      this.settle();
      return;
    }
    this.following = false;
    this.anchorKey = anchor.key;
    this.anchorOffset = anchor.offset;
    this.settle();
  }

  /** The rows that intersect the window widened by `overscan` points each way: [first, last], or null when there are none. */
  window(overscan: number): [number, number] | null {
    if (this.keys.length === 0) return null;
    const first = this.rowAt(Math.max(0, this.top - overscan));
    let last = this.rowAt(this.top + this.viewport + overscan);
    // rowAt returns the row whose bottom is past the edge; the last row otherwise
    if (last < first) last = first;
    return [first, last];
  }
}
