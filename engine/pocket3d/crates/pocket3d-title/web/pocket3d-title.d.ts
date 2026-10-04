/** Length of the card in ticks of 1/60 s. */
export const TICKS: number;
export const FADE_IN: number;
export const FADE_OUT: number;
/** The card's light at a tick, from 0 (black) to 256 (full). */
export function level(tick: number): number;
/** Decode the baked art to RGBA. */
export function art(base64?: string): { width: number; height: number; rgba: Uint8ClampedArray; ground: [number, number, number] };
/** Play the card over `parent` (the document body by default) and resolve when it has ended. */
export function playTitle(options?: { parent?: HTMLElement }): Promise<void>;
