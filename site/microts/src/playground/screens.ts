// Screen sizes available to the UI preview. Presets come from app.viewport.fixed.logical in pocketjs apps/*/pocket.json.

export interface Viewport {
  width: number;
  height: number;
}

export interface ScreenPreset extends Viewport {
  id: string;
  label: string;
}

export const SCREENS: ScreenPreset[] = [
  { id: "psp", label: "PSP", width: 480, height: 272 },
  { id: "gba", label: "Game Boy Advance", width: 240, height: 160 },
  { id: "3ds", label: "3DS top screen", width: 400, height: 240 },
  { id: "iphone", label: "iPhone 2G / 4S", width: 320, height: 480 },
  { id: "ipod-touch", label: "iPod touch", width: 320, height: 568 },
  { id: "bb-classic", label: "BlackBerry Classic", width: 360, height: 360 },
  { id: "ipod-nano", label: "iPod nano", width: 176, height: 132 },
  { id: "meizu-m8", label: "Meizu M8", width: 480, height: 720 },
];

export const DEFAULT_VIEWPORT: Viewport = { width: 480, height: 272 };
export const MIN_SIDE = 32;
export const MAX_SIDE = 2048;
/** pocket-retro sdk/api/system.ts: the GBA screen is at most 240 × 160 */
export const GBA_SCREEN: Viewport = { width: 240, height: 160 };

export function presetFor(v: Viewport): ScreenPreset | undefined {
  return SCREENS.find((s) => s.width === v.width && s.height === v.height);
}

export function validViewport(v: unknown): v is Viewport {
  const o = v as Viewport | null;
  return (
    !!o &&
    Number.isInteger(o.width) &&
    Number.isInteger(o.height) &&
    o.width >= MIN_SIDE &&
    o.height >= MIN_SIDE &&
    o.width <= MAX_SIDE &&
    o.height <= MAX_SIDE
  );
}

const KEY = (preset: string) => `microts-playground:viewport:${preset}`;

/** Resolution overrides for examples (projects keep theirs in the project record) */
export function loadExampleViewport(preset: string): Viewport | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(preset)) ?? "null");
    return validViewport(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveExampleViewport(preset: string, v: Viewport | null): void {
  try {
    if (v) localStorage.setItem(KEY(preset), JSON.stringify(v));
    else localStorage.removeItem(KEY(preset));
  } catch {
    // Storage unavailable: skip saving
  }
}
