/** Geometry and motion for remote tile pyramids. Coordinates are level-zero
 * pixels; zoom is log2 magnification. IO and projection belong to the caller. */
export interface PageCameraOptions {
  width: number; height: number; x: number; y: number; zoom: number;
  minZoom: number; maxZoom: number;
  bounds?: { width: number; height: number;  };
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const finite = (...values: number[]) => { if (values.some(v => !Number.isFinite(v))) throw new Error("Invalid tile geometry"); };
export function createPageCamera(options: PageCameraOptions) {
  finite(options.width, options.height, options.x, options.y, options.zoom, options.minZoom, options.maxZoom);
  if (options.width <= 0 || options.height <= 0 || options.minZoom > options.maxZoom || options.minZoom < -20 || options.maxZoom > 24) throw new Error("Invalid tile camera bounds");
  if (options.bounds) { finite(options.bounds.width, options.bounds.height); if (options.bounds.width <= 0 || options.bounds.height <= 0) throw new Error("Invalid world bounds"); }
  let x = options.x, y = options.y, zoom = clamp(options.zoom, options.minZoom, options.maxZoom);
  const { minZoom, maxZoom, bounds } = options;
  let vx = 0, vy = 0, dragging = false;
  let tween: { start: number; end: number; elapsed: number; anchorX: number; anchorY: number } | undefined;
  function constrain() {
    const b = bounds; if (!b) return;
    const halfWidth = Math.min(b.width / 2, options.width / 2 / 2 ** zoom);
    x = clamp(x, halfWidth, b.width - halfWidth);
    const half = Math.min(b.height / 2, options.height / 2 / 2 ** zoom);
    y = clamp(y, half, b.height - half);
  }
  function pan(dx: number, dy: number) { finite(dx, dy); x -= dx / 2 ** zoom; y -= dy / 2 ** zoom; constrain(); }
  function setZoom(next: number, ax: number, ay: number) {
    next = clamp(next, minZoom, maxZoom);
    const before = 2 ** -zoom, after = 2 ** -next;
    x += (ax - options.width / 2) * (before - after); y += (ay - options.height / 2) * (before - after);
    zoom = next; constrain();
  }
  constrain();
  return {
    view: () => ({ x, y, zoom, scale: 2 ** zoom, targetZoom: tween?.end ?? zoom, moving: dragging || !!tween || Math.abs(vx) + Math.abs(vy) > 1 }),
    stop() { vx = vy = 0; dragging = false; tween = undefined; },
    beginDrag() { vx = vy = 0; dragging = true; tween = undefined; },
    drag: pan,
    endDrag(dx: number, dy: number) { finite(dx, dy); dragging = false; vx = clamp(dx, -1800, 1800); vy = clamp(dy, -1800, 1800); },
    zoomBy(delta: number, anchorX = options.width / 2, anchorY = options.height / 2) {
      finite(delta, anchorX, anchorY); vx = vy = 0;
      tween = { start: zoom, end: clamp((tween?.end ?? zoom) + delta, minZoom, maxZoom), elapsed: 0, anchorX, anchorY };
    },
    jump(nextX: number, nextY: number, nextZoom = zoom) {
      finite(nextX, nextY, nextZoom); x = nextX; y = nextY; zoom = clamp(nextZoom, minZoom, maxZoom);
      vx = vy = 0; tween = undefined; dragging = false; constrain();
    },
    /** Screen-space controller velocity (pixels/second); positive moves the page.
     * Caller supplies bounded elapsed time. */
    step(seconds: number, inputX = 0, inputY = 0) {
      finite(seconds, inputX, inputY); if (seconds <= 0 || seconds > 1 / 15 + 1e-8) throw new Error("Tile camera step exceeds budget");
      if (tween) {
        tween.elapsed += seconds; const t = Math.min(1, tween.elapsed / 0.18), eased = 1 - (1 - t) ** 3;
        setZoom(tween.start + (tween.end - tween.start) * eased, tween.anchorX, tween.anchorY);
        if (t === 1) tween = undefined;
      }
      if (!dragging) {
        const driven = inputX !== 0 || inputY !== 0;
        const decay = Math.exp(-(driven ? 18 : 4.2) * seconds);
        const tx = clamp(inputX, -1800, 1800), ty = clamp(inputY, -1800, 1800);
        // Exact integral of exponential velocity approaches. Sampling at 30/60
        // Hz gives the same distance for a held input and for a released fling.
        const k = driven ? 18 : 4.2;
        pan(tx * seconds + (vx - tx) * (1 - decay) / k, ty * seconds + (vy - ty) * (1 - decay) / k);
        vx = tx + (vx - tx) * decay; vy = ty + (vy - ty) * decay;
        if (Math.abs(vx) < 0.1) vx = 0; if (Math.abs(vy) < 0.1) vy = 0;
      }
    },
  };
}
