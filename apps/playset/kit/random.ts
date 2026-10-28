// GameBlocks' RandomGenerator (Mulberry32, src/modules/math/RandomUtils.js,
// MIT, xt4d/GameBlocks) as one closure: random() in [0, 1).

export interface Random {
  (): number;
  /** [min, max) */
  uniform(min: number, max: number): number;
  /** an integer in [min, max] */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

export function mulberry(seed: number): Random {
  let state = seed >>> 0;
  const next = (() => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Random;
  next.uniform = (min, max) => min + (max - min) * next();
  next.int = (min, max) => Math.floor(min + (max - min + 1) * next());
  next.pick = (items) => items[Math.floor(next() * items.length)];
  return next;
}
