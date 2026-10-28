// GameBlocks' WaveSpawnDirector (src/modules/gameplay/WaveSpawnDirector.js),
// ported from GameBlocks' mech-arena (https://gb-mech-arena.vercel.app/,
// MIT, xt4d/GameBlocks).
//
// Deviation: `step` writes its spawn plans into a caller's array and returns
// their count, so the frame path allocates nothing.

export interface WaveSettings<T extends string> {
  baseWaveSize: number;
  growthPerWave: number;
  maxWaveSize: number;
  maxSpawnsPerStep: number;
  /** [first wave, type], in any order */
  unlock: readonly (readonly [number, T])[];
  weights: { readonly [K in T]: number | ((wave: number) => number) };
  autoStart: boolean;
  random: () => number;
}

export class WaveDirector<T extends string> {
  waveNumber = 1;
  inProgress = false;
  unitsToSpawn = 0;
  unitsSpawned = 0;
  private readonly unlock: readonly (readonly [number, T])[];

  constructor(private readonly s: WaveSettings<T>) {
    this.unlock = [...s.unlock].sort((a, b) => a[0] - b[0]);
  }

  reset(wave = 1): void {
    this.waveNumber = wave;
    this.inProgress = false;
    this.unitsToSpawn = 0;
    this.unitsSpawned = 0;
  }

  startWave(wave = this.waveNumber): void {
    this.waveNumber = wave;
    this.unitsToSpawn = this.waveSize(wave);
    this.unitsSpawned = 0;
    this.inProgress = true;
  }

  waveSize(wave = this.waveNumber): number {
    const raw = this.s.baseWaveSize + (wave - 1) * this.s.growthPerWave;
    return Math.max(1, Math.min(this.s.maxWaveSize, Math.floor(raw)));
  }

  /** Completes a wave whose units are all spawned and gone; true when it did. */
  completeIfDone(active: number): boolean {
    if (!this.inProgress || this.unitsSpawned < this.unitsToSpawn || active > 0) return false;
    this.inProgress = false;
    this.waveNumber += 1;
    return true;
  }

  /** This step's spawns into `out`; their count. */
  step(active: number, out: T[]): number {
    this.completeIfDone(active);
    if (!this.inProgress && this.s.autoStart) this.startWave(this.waveNumber);
    return this.planSpawns(out);
  }

  planSpawns(out: T[]): number {
    if (!this.inProgress) return 0;
    let n = 0;
    while (this.unitsSpawned < this.unitsToSpawn && n < this.s.maxSpawnsPerStep) {
      out[n++] = this.selectType(this.waveNumber);
      this.unitsSpawned += 1;
    }
    return n;
  }

  selectType(wave: number): T {
    let total = 0;
    let first: T | undefined;
    for (const [from, type] of this.unlock) {
      if (wave < from) continue;
      first ??= type;
      const w = this.weight(type, wave);
      if (w > 0) total += w;
    }
    if (total <= 0) return first as T;
    let pick = this.s.random() * total;
    let last = first as T;
    for (const [from, type] of this.unlock) {
      if (wave < from) continue;
      const w = this.weight(type, wave);
      if (w <= 0) continue;
      last = type;
      pick -= w;
      if (pick <= 0) return type;
    }
    return last;
  }

  private weight(type: T, wave: number): number {
    const w = this.s.weights[type];
    return typeof w === "function" ? w(wave) : w;
  }
}
