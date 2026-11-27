// Type surface of browser-input.js for the TS harness
// (tests/browser-input.test.ts, tests/runtime-programs.test.ts). The .js stays
// plain ESM so the browser loads it without a build step.

export interface BrowserInputOptions {
  pointer?: boolean;
  scroll?: boolean;
  text?: boolean;
  contacts?: boolean;
  buttons?: Record<string, number>;
  viewport?: () => readonly [number, number];
}

export interface BrowserInputSample {
  buttons: number;
  pointer?: { surface: number; x: number; y: number; buttons: number };
  scroll?: [number, number];
  text?: Array<
    | { kind: "key"; key: string; pressed: boolean; repeat: boolean }
    | { kind: "commit"; text: string }
    | { kind: "composition"; text: string; selectionStart: number; selectionEnd: number }
    | { kind: "compositionEnd" }
  >;
  contacts?: Array<{ surface: number; id: number; x: number; y: number; cancelled: boolean }>;
}

export interface BrowserInput {
  sample(): BrowserInputSample;
  caret(x: number, y: number, h?: number): void;
  focus(): void;
  dispose(): void;
}

export declare function createBrowserInput(
  element: any,
  options?: BrowserInputOptions,
): BrowserInput;
