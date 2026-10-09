// Result bookkeeping shared by the stage and the result screen.

export interface GameResult {
  songId: number;
  title: string;
  score: number;
  maxCombo: number;
  perfect: number;
  great: number;
  miss: number;
  total: number;
  /** 0..100 */
  accuracy: number;
  /** 0 = failed, 1 C, 2 B, 3 A, 4 S */
  rank: number;
  failed: boolean;
  newBest: boolean;
}

export const RANK_LETTERS = ["F", "C", "B", "A", "S"] as const;

export function rankFor(accuracy: number, failed: boolean): number {
  if (failed) return 0;
  if (accuracy >= 95) return 4;
  if (accuracy >= 85) return 3;
  if (accuracy >= 70) return 2;
  return 1;
}
