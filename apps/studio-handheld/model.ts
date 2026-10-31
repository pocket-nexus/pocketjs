// The state the program pushes down the overlay channel, the commands it takes,
// and the pure pieces of the interface.

export interface GameEntry { id: string; title: string; tagline: string; summary: string; color: string }
export interface State {
  games: GameEntry[];
  mic: { on: boolean; level: number; seconds: number; busy: boolean; error: string };
  transcript: string;
  transcriptSeq: number;
  agent: { running: boolean; phase: string; line: string; failed: string; doneId: string; gameId: string; elapsed: number; tokens: number; runs: number };
  stage: "room" | "play";
  testing: boolean;
  anchors: Record<string, [number, number] | null>;
}

export const EMPTY_STATE: State = {
  games: [],
  mic: { on: false, level: 0, seconds: 0, busy: false, error: "" },
  transcript: "",
  transcriptSeq: 0,
  agent: { running: false, phase: "", line: "", failed: "", doneId: "", gameId: "", elapsed: 0, tokens: 0, runs: 0 },
  stage: "room",
  testing: false,
  anchors: {},
};

export type Command =
  | { t: "pose"; name: string; shift: number; seconds?: number }
  | { t: "focus"; name: string }
  | { t: "case"; index: number | null; page: number }
  | { t: "mic"; on: boolean }
  | { t: "asr" }
  | { t: "make"; prompt: string; game: string | null }
  | { t: "cancel" }
  | { t: "clear" }
  | { t: "play"; id: string }
  | { t: "delete"; id: string }
  | { t: "quit" };

export const PRESETS = [
  "彩色方块的三维贪吃蛇，吃到苹果变长",
  "赛车躲障碍，越开越快，按 A 加速",
  "三维打砖块，摇杆控制挡板",
  "小飞船穿过圆环，打爆陨石",
];

export const RACK_COLUMNS = 4;
export const RACK_SLOTS = 12;

/** Grid movement over `count` items; it stops at the edges of the row and list. */
export function gridStep(index: number, direction: "left" | "right" | "up" | "down", count: number, columns: number): number {
  if (count <= 0) return 0;
  let next = index;
  if (direction === "left" && index % columns > 0) next = index - 1;
  if (direction === "right" && index % columns < columns - 1) next = index + 1;
  if (direction === "up") next = index - columns;
  if (direction === "down") next = index + columns;
  if (next < 0) return index;
  if (next >= count) return direction === "down" && index + 1 < count ? count - 1 : index;
  return next;
}

/** Break text by estimated width: CJK a full em, Latin about 0.56 em. */
export function wrap(text: string, width: number, fontPx: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "", used = 0;
    for (const character of Array.from(paragraph)) {
      const advance = (character.charCodeAt(0) > 0x2e7f ? 1 : 0.56) * fontPx;
      if (used + advance > width && line) {
        lines.push(line);
        line = "";
        used = 0;
        if (character === " ") continue;
      }
      line += character;
      used += advance;
    }
    lines.push(line);
  }
  return lines;
}
