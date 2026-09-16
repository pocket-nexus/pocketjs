// hosts/web/wasm-ops.js — the ONE wasm <-> HostOps binding, shared verbatim by
// the browser dev host (engine.js) and the headless golden harness
// (tests/golden.ts). Plain ES module, zero dependencies; needs only
// WebAssembly + TextEncoder (both exist in every browser and in Bun — the
// QuickJS "no TextEncoder" constraint applies only to framework/src/pak.ts, which
// this file is not).
//
// ABI (see engine/wasm/src/lib.rs): one export per ui.* op; strings/buffers cross
// via linear memory — ui_alloc(len) -> ptr, write bytes, call, ui_free.
// ui_render() returns the byte-exact RGBA8 framebuffer pointer at the
// logical viewport size; ui_render_scaled(n) renders the DrawList at n×.

export const FB_W = 480;
export const FB_H = 272;

const encoder = new TextEncoder();

/**
 * Instantiate pocketjs.wasm and return
 * { ops, init, tick, drawHash, render, renderScaled,
 *   renderIncremental, renderScaledIncremental, exports }.
 * `ops` is a complete HostOps (framework/src/host.ts) — hand it to the app bundle as
 * globalThis.ui before eval'ing it.
 *
 * @param {ArrayBuffer | Uint8Array | WebAssembly.Module} wasm
 */
export async function createWasmUi(wasm, options = {}) {
  const source = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(source, {});
  const ex = instance.exports;

  function integerInRange(value, name, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`${name} must be an integer from ${min} through ${max}, got ${value}`);
    }
    return value;
  }

  let viewportWidth = integerInRange(options.width ?? FB_W, "viewport width", 1, 32000);
  let viewportHeight = integerInRange(options.height ?? FB_H, "viewport height", 1, 32000);
  const initialDensity = integerInRange(options.rasterDensity ?? 1, "rasterDensity", 1, 255);
  let auxiliary = options.auxiliary ? options.auxiliary.map((n) =>
    integerInRange(n, "auxiliary dimension", 1, 4096)) : null;
  if (auxiliary && auxiliary.length !== 2) throw new RangeError("auxiliary requires width and height");
  let auxiliaryRoot = 0;
  // node id -> { handle, focused }. The core owns geometry/painter order;
  // this mirror gives a browser AppSupervisor the complete lifecycle binding
  // set, including surfaces currently hidden by shell opacity.
  const compositorBindings = new Map();

  const init = (rasterDensity = initialDensity) => {
    compositorBindings.clear();
    ex.ui_init(integerInRange(rasterDensity, "rasterDensity", 1, 255));
    // Older wasm binaries predate ui_set_viewport (same convention as
    // drawHash): tolerate them at the stock size, fail loud otherwise.
    if (ex.ui_set_viewport) ex.ui_set_viewport(viewportWidth, viewportHeight);
    else if (viewportWidth !== FB_W || viewportHeight !== FB_H) {
      throw new Error("this pocketjs.wasm predates ui_set_viewport — rebuild it: bun tools/wasm.ts");
    }
    if (auxiliary) {
      if (!ex.ui_create_auxiliary_surface) throw new Error("Rebuild pocketjs.wasm for auxiliary output");
      auxiliaryRoot = ex.ui_create_auxiliary_surface(...auxiliary);
      if (!auxiliaryRoot) throw new Error("Could not create auxiliary output");
    }
  };
  init(initialDensity);

  // Copy bytes into wasm scratch, run fn(ptr, len), free. Views are rebuilt
  // per call: memory.buffer is detached whenever linear memory grows.
  function withBytes(u8, fn) {
    const len = u8.length;
    const ptr = ex.ui_alloc(len);
    if (len > 0) new Uint8Array(ex.memory.buffer, ptr, len).set(u8);
    try {
      return fn(ptr, len);
    } finally {
      ex.ui_free(ptr, len);
    }
  }
  const withStr = (s, fn) => withBytes(encoder.encode(String(s)), fn);

  /** @type {import("../../framework/src/host.ts").HostOps} */
  const ops = {
    __viewport: { w: viewportWidth, h: viewportHeight },
    get __auxiliarySurface() {
      return auxiliary ? { root: auxiliaryRoot, w: auxiliary[0], h: auxiliary[1] } : undefined;
    },
    createNode: (type) => ex.ui_create_node(type),
    destroyNode: (id) => {
      compositorBindings.delete(id);
      ex.ui_destroy_node(id);
    },
    insertBefore: (parent, child, anchor) => ex.ui_insert_before(parent, child, anchor),
    removeChild: (parent, child) => ex.ui_remove_child(parent, child),
    setStyle: (id, styleId) => ex.ui_set_style(id, styleId),
    setProp: (id, propId, value) => ex.ui_set_prop(id, propId, value),
    setPropBatch: (records) => {
      const values = new Float64Array(records);
      for (let i = 0; i + 2 < values.length; i += 3) {
        ex.ui_set_prop(values[i], values[i + 1], values[i + 2]);
      }
    },
    setText: (id, str) => withStr(str, (p, l) => ex.ui_set_text(id, p, l)),
    replaceText: (id, str) => withStr(str, (p, l) => ex.ui_replace_text(id, p, l)),
    uploadTexture: (buf, w, h, psm) => withBytes(buf, (p, l) => ex.ui_upload_texture(p, l, w, h, psm)),
    setImage: (id, tex) => ex.ui_set_image(id, tex),
    setCompositorSurface: (id, surface, focused) => {
      if (surface < 0) compositorBindings.delete(id);
      else compositorBindings.set(id, { handle: surface, focused: focused !== 0 });
      ex.ui_set_compositor_surface(id, surface, focused);
    },
    setSprite: (id, atlas, frames, cols, step) => ex.ui_set_sprite(id, atlas, frames, cols, step),
    animate: (id, propId, to, durMs, easing, delayMs) =>
      ex.ui_animate(id, propId, to, durMs, easing, delayMs),
    cancelAnim: (animId) => ex.ui_cancel_anim(animId),
    setFocus: (id) => ex.ui_set_focus(id),
    setActive: (id, active) => ex.ui_set_active(id, active ? 1 : 0),
    loadStyles: (buf) => {
      withBytes(buf, (p, l) => ex.ui_load_styles(p, l));
    },
    loadFontAtlas: (buf) => {
      withBytes(buf, (p, l) => ex.ui_load_font_atlas(p, l));
    },
    measureText: (str, fontSlot) => withStr(str, (p, l) => ex.ui_measure_text(p, l, fontSlot)),
    // DevTools ops (spec ops 18..22, docs/DEVTOOLS.md) — debug-only, default-off.
    debugInspect: (id) => ex.ui_debug_inspect(id),
    debugRectXY: () => ex.ui_debug_rect_xy(),
    debugRectWH: () => ex.ui_debug_rect_wh(),
    debugPause: (on) => ex.ui_debug_pause(on ? 1 : 0),
    debugStep: () => ex.ui_debug_step(),
  };
  if (auxiliary) {
    ops.hitTestAuxiliary = (x, y) => ex.ui_hit_test_auxiliary(x, y);
    ops.hitTestBoundsAuxiliary = (x, y) => ex.ui_hit_test_bounds_auxiliary(x, y);
  }

  // Streamed-texture ops (spec ops 24/25) — feature-detected so a stale
  // pocketjs.wasm predating them still boots (the runtime falls back to
  // plain uploadTexture in framework/src/tiles.ts).
  if (ex.ui_free_texture) ops.freeTexture = (handle) => ex.ui_free_texture(handle);
  if (ex.ui_upload_img_entry) {
    ops.uploadImgEntry = (blob) => withBytes(blob, (p, l) => ex.ui_upload_img_entry(p, l));
  }

  // Virtual cursor ops (spec ops 27..29, input.cursor) — feature-detected so
  // a stale pocketjs.wasm predating them still boots (enableCursor falls
  // back to the classic d-pad focus model when the host lacks them).
  if (ex.ui_hit_test) ops.hitTest = (x, y) => ex.ui_hit_test(x, y);
  // Touch hit facts (spec op 42): the bounds-only query twin. Same stale-wasm
  // tolerance — the gesture layer falls back to ink hitTest, then rects.
  if (ex.ui_hit_test_bounds) ops.hitTestBounds = (x, y) => ex.ui_hit_test_bounds(x, y);
  if (ex.ui_set_cursor) {
    ops.setCursor = (tex, hotX, hotY, w, h) => ex.ui_set_cursor(tex, hotX, hotY, w, h);
  }
  if (ex.ui_set_cursor_pos) ops.setCursorPos = (x, y) => ex.ui_set_cursor_pos(x, y);

  // Text wrap (spec op 43) — feature-detected; apps fall back to the same
  // greedy rules over measureText when absent. The staged columns must be
  // copied INSIDE the closure: the view over linear memory dies on the next
  // alloc/grow (and withStr frees its scratch right after fn returns).
  if (ex.ui_wrap_text) {
    ops.wrapText = (str, fontSlot, maxW) =>
      withStr(str, (p, l) => {
        const n = ex.ui_wrap_text(p, l, fontSlot, maxW);
        return Array.from(new Uint32Array(ex.memory.buffer, ex.ui_wrap_text_ptr(), n));
      });
  }

  function framebufferView(ptr, scale) {
    if (!ptr) throw new Error(`pocketjs.wasm rejected render scale ${scale}`);
    return new Uint8Array(
      ex.memory.buffer,
      ptr,
      viewportWidth * scale * viewportHeight * scale * 4,
    );
  }

  return {
    ops,
    exports: ex,
    createAuxiliarySurface(width, height) {
      width = integerInRange(width, "auxiliary width", 1, 4096);
      height = integerInRange(height, "auxiliary height", 1, 4096);
      if (!ex.ui_create_auxiliary_surface) throw new Error("Rebuild pocketjs.wasm for auxiliary output");
      const root = ex.ui_create_auxiliary_surface(width, height);
      if (!root) throw new Error("Auxiliary surface allocation failed");
      auxiliary = [width, height];
      auxiliaryRoot = root;
      ops.hitTestAuxiliary = (x, y) => ex.ui_hit_test_auxiliary(x, y);
      ops.hitTestBoundsAuxiliary = (x, y) => ex.ui_hit_test_bounds_auxiliary(x, y);
      return root;
    },
    renderAuxiliary() {
      if (!ops.__auxiliarySurface) throw new Error("This host has no auxiliary output");
      const { w, h } = ops.__auxiliarySurface;
      const ptr = ex.ui_render_auxiliary();
      if (!ptr) throw new Error("Auxiliary rasterization failed");
      return new Uint8Array(ex.memory.buffer, ptr, w * h * 4);
    },
    /** Reset the core and set raster samples per logical pixel (default 1). */
    init,
    /** Resize a dynamic browser viewport and keep the guest-visible fact aligned. */
    resizeViewport(width, height) {
      viewportWidth = integerInRange(width, "viewport width", 1, 32000);
      viewportHeight = integerInRange(height, "viewport height", 1, 32000);
      if (!ex.ui_set_viewport) {
        throw new Error("this pocketjs.wasm predates ui_set_viewport — rebuild it: bun tools/wasm.ts");
      }
      ex.ui_set_viewport(viewportWidth, viewportHeight);
      ops.__viewport.w = viewportWidth;
      ops.__viewport.h = viewportHeight;
    },
    /** Advance exactly one fixed-dt (1/60 s) frame. */
    tick: () => ex.ui_tick(),
    /** Hash the current DrawList without rasterizing it (BigInt, wasm i64). */
    drawHash: ex.ui_draw_hash ? () => ex.ui_draw_hash() : null,
    /** Every live shell binding, including hidden/minimized surface nodes. */
    compositorBindings() {
      return Array.from(compositorBindings.values(), (entry) => ({ ...entry }));
    },
    /** Visible child frames in exact shell painter order. */
    compositorFrames() {
      if (!ex.ui_compositor_frames || !ex.ui_compositor_frames_ptr) return [];
      const count = ex.ui_compositor_frames();
      const ptr = ex.ui_compositor_frames_ptr();
      const words = new Uint32Array(ex.memory.buffer, ptr, count * 10);
      const floats = new Float32Array(ex.memory.buffer, ptr, count * 10);
      const frames = [];
      for (let i = 0; i < count; i++) {
        const at = i * 10;
        frames.push({
          handle: words[at],
          full: [floats[at + 1], floats[at + 2], floats[at + 3], floats[at + 4]],
          clip: [floats[at + 5], floats[at + 6], floats[at + 7], floats[at + 8]],
          focused: words[at + 9] !== 0,
          order: i,
        });
      }
      return frames;
    },
    /** Retain one child RGBA8 framebuffer in the shell compositor. */
    uploadCompositorSurface(handle, pixels, width, height) {
      if (!ex.ui_compositor_upload_surface) return -1;
      return withBytes(pixels, (ptr, len) =>
        ex.ui_compositor_upload_surface(handle, ptr, len, width, height),
      );
    },
    freeCompositorSurface(handle) {
      if (ex.ui_compositor_free_surface) ex.ui_compositor_free_surface(handle);
    },
    /** Rasterize the byte-exact framebuffer at the logical viewport size. */
    render() {
      return framebufferView(ex.ui_render(), 1);
    },
    /** Rasterize the logical DrawList directly at an integer physical scale. */
    renderScaled(scale) {
      scale = integerInRange(scale, "render scale", 1, 4);
      return framebufferView(ex.ui_render_scaled(scale), scale);
    },
    /** Render shell chrome and child rasters in SURFACE_QUAD painter order. */
    renderComposited(scale = 1) {
      scale = integerInRange(scale, "render scale", 1, 4);
      const ptr = scale === 1
        ? ex.ui_render_composited?.()
        : ex.ui_render_composited_scaled?.(scale);
      return framebufferView(ptr || ex.ui_render_scaled(scale), scale);
    },
    /** Repaint only changed regions, falling back for older wasm builds. */
    renderIncremental() {
      const ptr = ex.ui_render_incremental
        ? ex.ui_render_incremental()
        : ex.ui_render();
      return framebufferView(ptr, 1);
    },
    /** Incremental equivalent of renderScaled(). */
    renderScaledIncremental(scale) {
      scale = integerInRange(scale, "render scale", 1, 4);
      const ptr = ex.ui_render_incremental_scaled
        ? ex.ui_render_incremental_scaled(scale)
        : ex.ui_render_scaled(scale);
      return framebufferView(ptr, scale);
    },
  };
}

/**
 * Upload every `ui:img.*` pak entry through ops.uploadTexture and return a
 * Map of image name (the JSX `src` key) -> texture handle. Blob layout is the
 * framework/compiler/pak.ts IMG entry: 8-byte header {u16 w, u16 h, u8 psm, 3B pad} +
 * raw pixels. `getEntry(key)` / `listEntries(prefix)` come from the runtime's
 * pak reader (or any equivalent).
 */
export function uploadPackImages(ops, listEntries, getEntry) {
  const IMG_PREFIX = "ui:img.";
  const handles = new Map();
  for (const key of listEntries(IMG_PREFIX)) {
    const blob = getEntry(key);
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const w = dv.getUint16(0, true);
    const h = dv.getUint16(2, true);
    const psm = blob[4];
    const handle = ops.uploadTexture(blob.subarray(8), w, h, psm);
    if (handle >= 0) handles.set(key.slice(IMG_PREFIX.length), handle);
  }
  return handles;
}
