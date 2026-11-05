//! The DrawList -> gpui interpreter.
//!
//! Reference interpreter: engine/ui-wgpu/src/render.rs
//! `build_batches` — this file dispatches the same closed op set
//! (contracts/spec/spec.ts "DRAWLIST op format") into gpui paint calls
//! inside a `canvas` element's paint phase. Scissors become nested
//! `with_content_mask` scopes, which is why the walk is recursive where the
//! wgpu interpreter is flat.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use gpui::{
    App, Bounds, ContentMask, Hsla, Path, Pixels, Point, RenderImage, Rgba, ShapedLine,
    SharedString, Window, fill, linear_color_stop, linear_gradient, point, px, size,
};
use image::{Frame, ImageBuffer};
use pocketjs_core::{Ui, spec};
use smallvec::SmallVec;

use crate::fonts::{TextConfig, slot_line_height, slot_px};

/// u32 ABGR (the DrawList color packing) -> straight-alpha Rgba.
fn abgr(c: u32) -> Rgba {
    Rgba {
        r: (c & 0xff) as f32 / 255.0,
        g: ((c >> 8) & 0xff) as f32 / 255.0,
        b: ((c >> 16) & 0xff) as f32 / 255.0,
        a: (c >> 24) as f32 / 255.0,
    }
}

fn decode_xy(word: u32) -> (f32, f32) {
    (
        ((word & 0xffff) as u16 as i16) as f32,
        ((word >> 16) as u16 as i16) as f32,
    )
}

fn decode_wh(word: u32) -> (f32, f32) {
    ((word & 0xffff) as f32, ((word >> 16) & 0xffff) as f32)
}

fn fnv64(words: &[u32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for w in words {
        for b in w.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

fn shaped_key(text: &str, slot: u8, color: u32) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |byte: u8| {
        h ^= byte as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    };
    for b in text.as_bytes() {
        mix(*b);
    }
    mix(slot);
    for b in color.to_le_bytes() {
        mix(b);
    }
    h
}

/// RGBA (straight) -> BGRA in place — gpui's RenderImage byte order.
fn rgba_to_bgra(pixels: &mut [u8]) {
    for px in pixels.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
}

fn render_image(width: u32, height: u32, bgra: Vec<u8>) -> Option<Arc<RenderImage>> {
    let buffer = ImageBuffer::from_raw(width, height, bgra)?;
    Some(Arc::new(RenderImage::new(SmallVec::from_elem(
        Frame::new(buffer),
        1,
    ))))
}

struct CachedImage {
    revision: u64,
    tint: u32,
    size: (u32, u32),
    image: Arc<RenderImage>,
}

struct CachedRaster {
    bounds: (f32, f32, f32, f32),
    image: Arc<RenderImage>,
}

/// The gpui render backend: one instance per surface, fed `&Ui` under
/// `UiSurface::with_ui` from a canvas paint closure. Pure DrawList replay —
/// never writes core state.
pub struct GpuiRenderer {
    cfg: TextConfig,
    /// Raster samples per logical px for the tri raster fallback (the plan's
    /// rasterDensity; 2 on macos-app).
    raster_scale: u32,
    /// (slot, gid, color) -> tinted glyph cell image (baked GLYPH_RUN path).
    glyphs: HashMap<(u8, u16, u32), Arc<RenderImage>>,
    /// Runtime atlas extension invalidation: glyph count per slot.
    glyph_counts: [u16; spec::MAX_FONT_SLOTS],
    /// Texture slot -> converted (and possibly tinted) image.
    images: HashMap<u32, CachedImage>,
    /// Tri-batch raster fallback cache, keyed by batch content hash.
    rasters: HashMap<u64, CachedRaster>,
    rasters_used: HashSet<u64>,
    /// Reusable full-viewport RGBA scratch for the raster fallback (the
    /// core rasterizer renders whole framebuffers).
    raster_scratch: Vec<u8>,
    /// Shaped-line cache: an editor keystroke or caret blink repaints the
    /// whole window, but only the edited line's shape changes — everything
    /// else replays. Keyed by (text, slot, color) hash, text-verified
    /// against collisions, swept to the lines the last paint used.
    shaped: HashMap<u64, (String, ShapedLine)>,
    shaped_used: HashSet<u64>,
}

/// Native SURFACE_QUAD painter. `full` is the shell node's unclipped bounds,
/// `clip` is its visible destination, and `focused` is the shell focus fact.
/// This path is independent of image textures and preserves DrawList order.
pub type CompositorPainter<'a> =
    dyn FnMut(u32, Bounds<Pixels>, Bounds<Pixels>, bool, &mut Window, &mut App) + 'a;

impl GpuiRenderer {
    pub fn new(cfg: TextConfig, raster_scale: u32) -> GpuiRenderer {
        GpuiRenderer {
            cfg,
            raster_scale: raster_scale.max(1),
            glyphs: HashMap::new(),
            glyph_counts: [0; spec::MAX_FONT_SLOTS],
            images: HashMap::new(),
            rasters: HashMap::new(),
            rasters_used: HashSet::new(),
            raster_scratch: Vec::new(),
            shaped: HashMap::new(),
            shaped_used: HashSet::new(),
        }
    }

    /// Drop every cached image (window/display change).
    pub fn clear_caches(&mut self) {
        self.glyphs.clear();
        self.images.clear();
        self.rasters.clear();
        self.shaped.clear();
    }

    /// Replay the current DrawList at `origin` (the canvas element's origin,
    /// window coordinates, logical px — gpui applies the display scale).
    pub fn paint(&mut self, ui: &Ui, origin: Point<Pixels>, window: &mut Window, cx: &mut App) {
        let mut none =
            |_: u32, _: Bounds<Pixels>, _: Bounds<Pixels>, _: bool, _: &mut Window, _: &mut App| {};
        self.paint_with_compositor(ui, origin, window, cx, &mut none);
    }

    /// Replay a DrawList and delegate explicit SURFACE_QUAD instructions to
    /// the native compositor at their exact place in painter order.
    pub fn paint_with_compositor(
        &mut self,
        ui: &Ui,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
        compositor: &mut CompositorPainter<'_>,
    ) {
        // Runtime atlas growth (loadFontAtlas reload) invalidates that
        // slot's glyph cells — same trigger the wgpu backend re-uploads on.
        for slot in 0..spec::MAX_FONT_SLOTS {
            let count = ui.font_atlas(slot as u8).map_or(0, |a| a.glyph_count);
            if count != self.glyph_counts[slot] {
                self.glyph_counts[slot] = count;
                self.glyphs.retain(|(s, _, _), _| *s as usize != slot);
            }
        }
        self.rasters_used.clear();
        self.shaped_used.clear();
        let words = &ui.current_draw_list().words;
        let mut i = 0usize;
        self.walk(ui, words, &mut i, origin, window, cx, compositor);
        let used = std::mem::take(&mut self.rasters_used);
        self.rasters.retain(|h, _| used.contains(h));
        self.rasters_used = used;
        let used = std::mem::take(&mut self.shaped_used);
        self.shaped.retain(|h, _| used.contains(h));
        self.shaped_used = used;
    }

    /// Interpret ops until the list ends or a SCISSOR_POP closes this scope.
    #[allow(clippy::too_many_arguments)]
    fn walk(
        &mut self,
        ui: &Ui,
        words: &[u32],
        i: &mut usize,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
        compositor: &mut CompositorPainter<'_>,
    ) {
        while *i < words.len() {
            match words[*i] {
                spec::draw_op::RECT => {
                    let (x, y) = decode_xy(words[*i + 1]);
                    let (w, h) = decode_wh(words[*i + 2]);
                    let color = abgr(words[*i + 3]);
                    window.paint_quad(fill(
                        Bounds::new(
                            point(px(x) + origin.x, px(y) + origin.y),
                            size(px(w), px(h)),
                        ),
                        color,
                    ));
                    *i += 4;
                }
                spec::draw_op::GRAD_RECT => {
                    let (x, y) = decode_xy(words[*i + 1]);
                    let (w, h) = decode_wh(words[*i + 2]);
                    let from: Hsla = abgr(words[*i + 3]).into();
                    let to: Hsla = abgr(words[*i + 4]).into();
                    // GradDir -> CSS gradient angle (0deg = to top). The core
                    // pins "from" at the bottom for ToTop etc. — see
                    // engine/core/src/draw.rs gradient corner mapping.
                    let angle = match words[*i + 5] {
                        d if d == spec::GradDir::ToTop as u32 => 0.0,
                        d if d == spec::GradDir::ToLeft as u32 => 270.0,
                        d if d == spec::GradDir::ToRight as u32 => 90.0,
                        _ => 180.0, // ToBottom
                    };
                    window.paint_quad(fill(
                        Bounds::new(
                            point(px(x) + origin.x, px(y) + origin.y),
                            size(px(w), px(h)),
                        ),
                        linear_gradient(
                            angle,
                            linear_color_stop(from, 0.0),
                            linear_color_stop(to, 1.0),
                        ),
                    ));
                    *i += 6;
                }
                spec::draw_op::GLYPH_RUN => {
                    let slot = (words[*i + 1] & 0xff) as u8;
                    let n = (words[*i + 1] >> 16) as usize;
                    let color = words[*i + 2];
                    self.paint_glyph_run(
                        ui,
                        slot,
                        color,
                        &words[*i + 3..*i + 3 + 2 * n],
                        origin,
                        window,
                        cx,
                    );
                    *i += 3 + 2 * n;
                }
                spec::draw_op::TEX_QUAD => {
                    self.paint_tex_quad(ui, &words[*i + 1..*i + 9], origin, window);
                    *i += 9;
                }
                spec::draw_op::SURFACE_QUAD => {
                    let full = Bounds::new(
                        point(
                            px(f32::from_bits(words[*i + 2])) + origin.x,
                            px(f32::from_bits(words[*i + 3])) + origin.y,
                        ),
                        size(
                            px(f32::from_bits(words[*i + 4])),
                            px(f32::from_bits(words[*i + 5])),
                        ),
                    );
                    let (x, y) = decode_xy(words[*i + 6]);
                    let (w, h) = decode_wh(words[*i + 7]);
                    let clip = Bounds::new(
                        point(px(x) + origin.x, px(y) + origin.y),
                        size(px(w), px(h)),
                    );
                    compositor(
                        words[*i + 1],
                        full,
                        clip,
                        words[*i + 8] & 1 != 0,
                        window,
                        cx,
                    );
                    *i += 9;
                }
                spec::draw_op::SCISSOR => {
                    let (x, y) = decode_xy(words[*i + 1]);
                    let (w, h) = decode_wh(words[*i + 2]);
                    *i += 3;
                    let mask = ContentMask {
                        bounds: Bounds::new(
                            point(px(x) + origin.x, px(y) + origin.y),
                            size(px(w), px(h)),
                        ),
                    };
                    // with_content_mask intersects with the enclosing mask,
                    // matching the core's already-intersected scissor rects.
                    window.with_content_mask(Some(mask), |window| {
                        self.walk(ui, words, i, origin, window, cx, compositor)
                    });
                }
                spec::draw_op::SCISSOR_POP => {
                    *i += 1;
                    return;
                }
                spec::draw_op::TRI | spec::draw_op::TEX_TRI => {
                    self.paint_tri_batch(ui, words, i, origin, window, cx);
                }
                spec::draw_op::TEXT_RUN => {
                    let len = 8 + (words[*i + 7] as usize).div_ceil(4);
                    self.paint_text_run(&words[*i..*i + len], origin, window, cx);
                    *i += len;
                }
                // The op set is closed per DrawList version; anything else
                // means corrupt data — stop instead of misinterpreting.
                _ => return,
            }
        }
    }

    // ---- text ---------------------------------------------------------------

    /// Paint one TEXT_RUN from its op words (`words[0]` = the op word; the
    /// run string's UTF-8 bytes ride in the stream — spec.ts word format).
    fn paint_text_run(
        &mut self,
        words: &[u32],
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let slot = (words[1] & 0xff) as u8;
        let align = ((words[1] >> 8) & 0xff) as u8;
        let ox = f32::from_bits(words[2]);
        let oy = f32::from_bits(words[3]);
        let box_w = f32::from_bits(words[4]);
        let line_height = f32::from_bits(words[5]);
        let color_word = words[6];
        let byte_len = words[7] as usize;
        let mut bytes = Vec::with_capacity(byte_len);
        for w in &words[8..8 + byte_len.div_ceil(4)] {
            bytes.extend_from_slice(&w.to_le_bytes());
        }
        bytes.truncate(byte_len);
        let text = String::from_utf8_lossy(&bytes);
        let color: Hsla = abgr(color_word).into();
        let (size_px, bold, mono) = slot_px(slot);
        let ts = window.text_system().clone();
        let lh = if line_height.is_nan() {
            slot_line_height(&ts, &self.cfg, slot)
        } else {
            line_height
        };
        let mut y = oy;
        for line in text.split('\n') {
            if !line.is_empty() {
                let key = shaped_key(line, slot, color_word);
                self.shaped_used.insert(key);
                let cached = self
                    .shaped
                    .get(&key)
                    .filter(|(text, _)| text == line)
                    .map(|(_, s)| s.clone());
                let shaped = match cached {
                    Some(s) => s,
                    None => {
                        let run = self.cfg.run(line.len(), bold, mono, color);
                        let s = ts.shape_line(
                            SharedString::from(line.to_string()),
                            px(size_px),
                            &[run],
                            None,
                        );
                        self.shaped.insert(key, (line.to_string(), s.clone()));
                        s
                    }
                };
                let dx = match align {
                    a if a == spec::TextAlign::Center as u8 => {
                        (box_w - f32::from(shaped.width)) * 0.5
                    }
                    a if a == spec::TextAlign::Right as u8 => box_w - f32::from(shaped.width),
                    _ => 0.0,
                };
                let _ = shaped.paint(
                    point(px(ox + dx) + origin.x, px(y) + origin.y),
                    px(lh),
                    window,
                    cx,
                );
            }
            y += lh;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn paint_glyph_run(
        &mut self,
        ui: &Ui,
        slot: u8,
        color: u32,
        cells: &[u32],
        origin: Point<Pixels>,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let Some(atlas) = ui.font_atlas(slot) else {
            return;
        };
        let (cell_w, cell_h) = (atlas.cell_w as f32, atlas.cell_h as f32);
        for cell in cells.as_chunks::<2>().0 {
            let (x, y) = decode_xy(cell[0]);
            let gid = (cell[1] & 0xffff) as u16;
            let image = match self.glyphs.get(&(slot, gid, color)) {
                Some(image) => image.clone(),
                None => {
                    let (cw, ch) = (atlas.coverage_width(), atlas.coverage_height());
                    let rows = atlas.glyph_rows(gid);
                    let tint = abgr(color);
                    let (r, g, b) = (
                        (tint.r * 255.0) as u8,
                        (tint.g * 255.0) as u8,
                        (tint.b * 255.0) as u8,
                    );
                    let mut bgra = Vec::with_capacity((cw * ch * 4) as usize);
                    for &cov in rows.iter().take((cw * ch) as usize) {
                        let a = (cov as f32 * tint.a) as u8;
                        bgra.extend_from_slice(&[b, g, r, a]);
                    }
                    let Some(image) = render_image(cw, ch, bgra) else {
                        continue;
                    };
                    self.glyphs.insert((slot, gid, color), image.clone());
                    image
                }
            };
            let bounds = Bounds::new(
                point(px(x) + origin.x, px(y) + origin.y),
                size(px(cell_w), px(cell_h)),
            );
            let _ = window.paint_image(bounds, Default::default(), image, 0, false);
        }
    }

    // ---- textures -------------------------------------------------------------

    /// Convert (and tint) a live core texture into the image cache.
    fn texture_image(
        &mut self,
        ui: &Ui,
        handle: u32,
        tint: u32,
    ) -> Option<(Arc<RenderImage>, (u32, u32))> {
        let slot = handle & spec::TEX_SLOT_MASK;
        let (live, revision, view) = ui.texture_at_versioned(slot)?;
        if live as u32 != handle {
            return None; // stale generation-tagged handle
        }
        if let Some(c) = self.images.get(&slot)
            && c.revision == revision
            && c.tint == tint
        {
            return Some((c.image.clone(), c.size));
        }
        let mut rgba = to_rgba8(&view)?;
        if tint != 0xffff_ffff {
            let t = abgr(tint);
            for p in rgba.as_chunks_mut::<4>().0 {
                p[0] = (p[0] as f32 * t.r) as u8;
                p[1] = (p[1] as f32 * t.g) as u8;
                p[2] = (p[2] as f32 * t.b) as u8;
                p[3] = (p[3] as f32 * t.a) as u8;
            }
        }
        rgba_to_bgra(&mut rgba);
        let image = render_image(view.w, view.h, rgba)?;
        self.images.insert(
            slot,
            CachedImage {
                revision,
                tint,
                size: (view.w, view.h),
                image: image.clone(),
            },
        );
        Some((image, (view.w, view.h)))
    }

    fn paint_tex_quad(
        &mut self,
        ui: &Ui,
        words: &[u32],
        origin: Point<Pixels>,
        window: &mut Window,
    ) {
        let handle = words[0];
        let (x, y) = decode_xy(words[1]);
        let (w, h) = decode_wh(words[2]);
        let (u0, v0) = (f32::from_bits(words[3]), f32::from_bits(words[4]));
        let (u1, v1) = (f32::from_bits(words[5]), f32::from_bits(words[6]));
        let tint = words[7];
        let dst = Bounds::new(
            point(px(x) + origin.x, px(y) + origin.y),
            size(px(w), px(h)),
        );
        let (du, dv) = (u1 - u0, v1 - v0);
        let full = if du > 0.0 && dv > 0.0 {
            let full_w = w / du;
            let full_h = h / dv;
            Bounds::new(
                point(
                    px(x - u0 * full_w) + origin.x,
                    px(y - v0 * full_h) + origin.y,
                ),
                size(px(full_w), px(full_h)),
            )
        } else {
            dst
        };
        let Some((image, _)) = self.texture_image(ui, handle, tint) else {
            return;
        };
        if (u0, v0, u1, v1) == (0.0, 0.0, 1.0, 1.0) {
            let _ = window.paint_image(dst, Default::default(), image, 0, false);
        } else if du > 0.0 && dv > 0.0 {
            // Sub-rect sampling (sprite cells, tilesets): paint the full
            // image scaled so the UV window lands exactly on `dst`, masked
            // to `dst` (with_content_mask intersects the enclosing mask).
            window.with_content_mask(Some(ContentMask { bounds: dst }), |window| {
                let _ = window.paint_image(full, Default::default(), image, 0, false);
            });
        }
        // Mirrored UV windows (u1 < u0) never leave the core: flips become
        // TEX_TRIs, which take the raster fallback below.
    }

    // ---- triangle batches (raster fallback) -----------------------------------

    /// Paint one consecutive TRI/TEX_TRI batch starting at `*i`. Flat solid
    /// TRIs alone stay vector paths; any gouraud or textured member sends
    /// the WHOLE batch through the core software rasterizer so painter
    /// order inside the batch (3D subtrees sort by depth) is preserved.
    fn paint_tri_batch(
        &mut self,
        ui: &Ui,
        words: &[u32],
        i: &mut usize,
        origin: Point<Pixels>,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let start = *i;
        let mut end = start;
        let mut needs_raster = false;
        while end < words.len() {
            match words[end] {
                spec::draw_op::TRI => {
                    if words[end + 4] != words[end + 5] || words[end + 5] != words[end + 6] {
                        needs_raster = true; // gouraud
                    }
                    end += 7;
                }
                spec::draw_op::TEX_TRI => {
                    needs_raster = true;
                    end += 12;
                }
                _ => break,
            }
        }
        *i = end;
        let batch = &words[start..end];
        if !needs_raster {
            for tri in batch.as_chunks::<7>().0 {
                let color = abgr(tri[4]);
                let (x0, y0) = decode_xy(tri[1]);
                let (x1, y1) = decode_xy(tri[2]);
                let (x2, y2) = decode_xy(tri[3]);
                let mut path = Path::new(point(px(x0) + origin.x, px(y0) + origin.y));
                path.line_to(point(px(x1) + origin.x, px(y1) + origin.y));
                path.line_to(point(px(x2) + origin.x, px(y2) + origin.y));
                window.paint_path(path, color);
            }
            return;
        }
        self.paint_rastered_batch(ui, batch, origin, window);
    }

    fn paint_rastered_batch(
        &mut self,
        ui: &Ui,
        batch: &[u32],
        origin: Point<Pixels>,
        window: &mut Window,
    ) {
        // Content hash: the ops plus the revision of every referenced
        // texture (generation-tagged handles make stale reuse impossible).
        let mut key_words: Vec<u32> = batch.to_vec();
        let mut j = 0usize;
        while j < batch.len() {
            if batch[j] == spec::draw_op::TEX_TRI {
                let slot = batch[j + 1] & spec::TEX_SLOT_MASK;
                if let Some((_, revision, _)) = ui.texture_at_versioned(slot) {
                    key_words.push(revision as u32);
                    key_words.push((revision >> 32) as u32);
                }
                j += 12;
            } else {
                j += 7;
            }
        }
        let hash = fnv64(&key_words);
        self.rasters_used.insert(hash);
        if let Some(cached) = self.rasters.get(&hash) {
            let (bx, by, bw, bh) = cached.bounds;
            let bounds = Bounds::new(
                point(px(bx) + origin.x, px(by) + origin.y),
                size(px(bw), px(bh)),
            );
            let _ = window.paint_image(bounds, Default::default(), cached.image.clone(), 0, false);
            return;
        }

        // Batch bbox over vertices (integer logical px; coords pre-clipped).
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        let mut j = 0usize;
        while j < batch.len() {
            let idxs: &[usize] = if batch[j] == spec::draw_op::TEX_TRI {
                &[j + 2, j + 5, j + 8]
            } else {
                &[j + 1, j + 2, j + 3]
            };
            for &k in idxs {
                let (x, y) = decode_xy(batch[k]);
                min_x = min_x.min(x as i32);
                min_y = min_y.min(y as i32);
                max_x = max_x.max(x.ceil() as i32);
                max_y = max_y.max(y.ceil() as i32);
            }
            j += if batch[j] == spec::draw_op::TEX_TRI {
                12
            } else {
                7
            };
        }
        if min_x >= max_x || min_y >= max_y {
            return;
        }
        // The core rasterizer renders full-viewport framebuffers (it
        // asserts the pixel count), so raster the batch into a reusable
        // viewport-sized scratch at density and crop the bbox out. The
        // batch words are already viewport-space — no translation needed.
        // The OVER variant leaves the zeroed scratch's uncovered pixels
        // fully transparent (the clearing variant paints the full-frame
        // opaque-black background — the ROOM-card black-edge bug).
        let (bw, bh) = ((max_x - min_x) as u32, (max_y - min_y) as u32);
        let scale = self.raster_scale;
        let (vw, vh) = ui.viewport();
        let (fw, fh) = (
            (vw.ceil() as u32).max(1) * scale,
            (vh.ceil() as u32).max(1) * scale,
        );
        let full = (fw * fh * 4) as usize;
        self.raster_scratch.resize(full, 0);
        self.raster_scratch[..full].fill(0);
        pocket_raster::render_scaled_over(ui, batch, &mut self.raster_scratch, scale);
        let (pw, ph) = (bw * scale, bh * scale);
        let mut bgra = Vec::with_capacity((pw * ph * 4) as usize);
        let (ox_px, oy_px) = (min_x as u32 * scale, min_y as u32 * scale);
        for row in 0..ph {
            let start = (((oy_px + row) * fw + ox_px) * 4) as usize;
            bgra.extend_from_slice(&self.raster_scratch[start..start + (pw * 4) as usize]);
        }
        rgba_to_bgra(&mut bgra);
        let Some(image) = render_image(pw, ph, bgra) else {
            return;
        };
        self.rasters.insert(
            hash,
            CachedRaster {
                bounds: (min_x as f32, min_y as f32, bw as f32, bh as f32),
                image: image.clone(),
            },
        );
        let bounds = Bounds::new(
            point(px(min_x as f32) + origin.x, px(min_y as f32) + origin.y),
            size(px(bw as f32), px(bh as f32)),
        );
        let _ = window.paint_image(bounds, Default::default(), image, 0, false);
    }
}

/// Expand a core texture (PSM 5650/8888/4444/T8) to tightly-packed RGBA8 —
/// the same conversion pocket-ui-wgpu ships (render.rs `to_rgba8`).
fn to_rgba8(view: &pocketjs_core::TexView) -> Option<Vec<u8>> {
    let count = (view.w * view.h) as usize;
    let pixels = view.pixels;
    match view.psm {
        spec::psm::PSM_5650 => {
            if pixels.len() < count * 2 {
                return None;
            }
            let mut out = Vec::with_capacity(count * 4);
            for px in pixels[..count * 2].as_chunks::<2>().0 {
                let v = u16::from_le_bytes([px[0], px[1]]) as u32;
                let r = v & 0x1f;
                let g = (v >> 5) & 0x3f;
                let b = (v >> 11) & 0x1f;
                out.push(((r << 3) | (r >> 2)) as u8);
                out.push(((g << 2) | (g >> 4)) as u8);
                out.push(((b << 3) | (b >> 2)) as u8);
                out.push(255);
            }
            Some(out)
        }
        spec::psm::PSM_8888 => {
            let bytes = count * 4;
            (pixels.len() >= bytes).then(|| pixels[..bytes].to_vec())
        }
        spec::psm::PSM_4444 => {
            if pixels.len() < count * 2 {
                return None;
            }
            let mut out = Vec::with_capacity(count * 4);
            for px in pixels[..count * 2].as_chunks::<2>().0 {
                let v = u16::from_le_bytes([px[0], px[1]]) as u32;
                out.push(((v & 0xf) * 17) as u8);
                out.push((((v >> 4) & 0xf) * 17) as u8);
                out.push((((v >> 8) & 0xf) * 17) as u8);
                out.push((((v >> 12) & 0xf) * 17) as u8);
            }
            Some(out)
        }
        spec::psm::PSM_T8 => {
            let palette = view.palette?;
            if palette.len() < 1024 || pixels.len() < count {
                return None;
            }
            let mut out = Vec::with_capacity(count * 4);
            for &idx in &pixels[..count] {
                let p = idx as usize * 4;
                out.extend_from_slice(&palette[p..p + 4]);
            }
            Some(out)
        }
        _ => None,
    }
}
