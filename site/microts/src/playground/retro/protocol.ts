// Message format between the main thread and the retro Worker.

export interface SourceError {
  phase: "compile" | "setup" | "frame" | "timeout";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  stack?: string;
}

export interface AssetPayload {
  images: ArrayLike<number>;
  tilemaps: ArrayLike<number>;
  tilemapImages: number[];
  colors: number[];
  sounds: number[];
  soundStarts: number[];
  musics: number[];
  musicStarts: number[];
}

export type WorkerRequest =
  | { type: "start"; files: Record<string, string>; entry: string; assets: AssetPayload }
  | { type: "frame"; id: number; keys: number; ticks: number };

export type WorkerReply =
  | { type: "ready"; width: number; height: number; fps: number }
  | {
      type: "frame";
      id: number;
      width: number;
      height: number;
      fps: number;
      screen: Uint8Array;
      colors?: number[];
      voices: Int32Array;
    }
  | { type: "log"; level: "log" | "info" | "warn" | "error" | "debug"; text: string }
  | { type: "error"; error: SourceError };

/** GBA KEYINPUT bits, matching sdk/input.ts */
export const BUTTON = {
  A: 1,
  B: 2,
  SELECT: 4,
  START: 8,
  RIGHT: 16,
  LEFT: 32,
  UP: 64,
  DOWN: 128,
  R: 256,
  L: 512,
} as const;
export type ButtonName = keyof typeof BUTTON;
