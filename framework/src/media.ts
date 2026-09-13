import { MEDIA, validMediaSource, type MediaOps, type MediaSource, type MediaStatus } from "../../contracts/spec/media.ts";
export { MEDIA };
export type { MediaSource, MediaStatus, MediaPhase } from "../../contracts/spec/media.ts";

/** One native playback plane per realm. Surface placement is an ordinary
 * Image binding, independent of the number of displays and input devices. */
export function mediaPlayer(ops = (globalThis as unknown as { media?: MediaOps }).media) {
  if (!ops) throw new Error("Host does not implement media.playback");
  return {
    open(source: MediaSource): boolean {
      if (!validMediaSource(source)) throw new Error("Invalid companion media source");
      return ops.open(source.host, source.port, source.token);
    },
    close: () => ops.close(),
    pause: (value: boolean) => ops.paused(value),
    volume: (value: number) => ops.volume(Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0),
    texture: () => ops.texture(),
    status: (): MediaStatus => JSON.parse(ops.status()),
  };
}

/** Local seek preview shared by touch surfaces, cursors and directional input.
 * A drag issues one remote seek on release. Cancellation issues none. */
export function createMediaScrubber(seek: (seconds: number) => void) {
  let active = false, preview = 0;
  const position = (fraction: number, duration: number) =>
    Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * Math.max(0, duration);
  return {
    active: () => active,
    preview: () => preview,
    begin(fraction: number, duration: number) { active = true; preview = position(fraction, duration); },
    move(fraction: number, duration: number) { if (active) preview = position(fraction, duration); },
    commit() { if (!active) return; active = false; seek(preview); },
    cancel() { active = false; },
  };
}
