// Shared design tokens for the Edgi-Talk UI.
//
// Tailwind literals are resolved at build time, so reusable looks are exported
// as complete class strings instead of being assembled from parts at runtime.
// Runtime colors (style objects) use the hex constants in `color`.

export const TICK_HZ = 30;
export const SCREEN_W = 400;
export const SCREEN_H = 240;

export const color = {
  // Hub (light)
  bg: "#e6eff3",
  card: "#f7fafb",
  line: "#cbdde3",
  ink: "#1f3440",
  sub: "#5b7480",
  teal: "#1d7974",
  tealSoft: "#d5e8e9",
  sky: "#4fb8e8",
  coral: "#ff6f7d",
  amber: "#ffc857",
  mint: "#7be0c8",
  // Stage (dark)
  night: "#0b1622",
  nightMid: "#12304a",
  lane: "#16324a",
  laneLit: "#2b5f83",
  grid: "#1d3a52",
  floor: "#3b6e8f",
  white: "#ffffff",
} as const;

export type Tone = "soft" | "solid" | "light" | "warn" | "night" | "amber";

/** Background looks for pills and buttons (absolute-positioned). */
export function toneClass(tone: Tone): string {
  switch (tone) {
    case "solid": return "absolute items-center justify-center bg-[#1d7974]";
    case "light": return "absolute items-center justify-center bg-[#eef5f7] border border-[#cbdde3]";
    case "warn": return "absolute items-center justify-center bg-[#ff6f7d]";
    case "night": return "absolute items-center justify-center bg-[#1b3b57]";
    case "amber": return "absolute items-center justify-center bg-[#ffc857]";
    default: return "absolute items-center justify-center bg-[#d5e8e9]";
  }
}

/** Same looks with a pressed state for Focusable buttons. */
export function buttonClass(tone: Tone): string {
  switch (tone) {
    case "solid": return "absolute items-center justify-center bg-[#1d7974] active:bg-[#155e5a]";
    case "light": return "absolute items-center justify-center bg-[#eef5f7] border border-[#cbdde3] active:bg-[#d5e8e9]";
    case "warn": return "absolute items-center justify-center bg-[#ff6f7d] active:bg-[#e85a69]";
    case "night": return "absolute items-center justify-center bg-[#1b3b57] active:bg-[#2b5f83]";
    case "amber": return "absolute items-center justify-center bg-[#ffc857] active:bg-[#e6b040]";
    default: return "absolute items-center justify-center bg-[#d5e8e9] active:bg-[#bcd8da]";
  }
}
