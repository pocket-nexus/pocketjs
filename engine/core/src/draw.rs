//! Tree walk -> DrawList + the CPU CLIP STAGE [R].
//!
//! Word/byte layout is pinned in contracts/spec/spec.ts ("DRAWLIST op format"); op
//! codes in spec::draw_op. GUARANTEE upheld here: every coordinate emitted is
//! inside [0, viewport w] x [0, viewport h] — never negative, never off-screen —
//! because the PSP GE wraps i16 coordinates. Clipping re-interpolates UVs
//! (TEX_QUAD) and gradient endpoint colors (GRAD_RECT).
//!
//! Transforms (translate/scale/rotate) compose down the walk as 2D affines.
//! Axis-aligned content uses RECT/GRAD_RECT/TEX_QUAD; ROTATED solid/gradient
//! boxes are corner-transformed, Sutherland-Hodgman-clipped and emitted as
//! TRI ops. v1 degradations (documented):
//!   - rotated IMAGE quads are conservatively culled (no textured-tri op);
//!   - glyph cells position along the rotated/scaled frame but stay upright
//!     and unscaled (bitmap cells); glyphs whose cell top-left leaves the
//!     screen range or whose cell leaves the clip rect are dropped;
//!   - rounded corners and shadows are emitted for axis-aligned boxes as
//!     deterministic alpha-covered RECT spans; rotated rounded boxes degrade
//!     to square fills;
//!   - opacity multiplies vertex alpha down the subtree (wrong on overlap,
//!     per docs/DESIGN.md punt list).

use alloc::vec::Vec;

use crate::layout::{floorf, roundf};
use crate::spec;
use crate::style::{self, StyleTable, NO_GRADIENT};
use crate::text::Fonts;
use crate::tree::Tree;

/// The core -> backend command list: flat little-endian u32 words.
/// Format pinned in contracts/spec/spec.ts ("DRAWLIST op format"); op codes in
/// spec::draw_op. On wasm the host reads this as a Uint32Array; on PSP,
/// hosts/psp/src/ge.rs walks it into sceGu calls. The words are the COMPLETE
/// pixel truth — TEXT_RUN packs its run string's UTF-8 bytes into the stream,
/// so snapshots, hashes and damage diffs never need side data.
pub struct DrawList {
    pub words: Vec<u32>,
}

impl DrawList {
    pub fn new() -> Self {
        DrawList { words: Vec::new() }
    }
}

impl Default for DrawList {
    fn default() -> Self {
        Self::new()
    }
}

// ---- small math (no_std: no libm, no micromath — local polyfills) -----------

const PI: f32 = core::f32::consts::PI;

#[inline]
fn clampf(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

/// sin for rotate: range-reduce to [-pi/2, pi/2], 5-term Taylor (max error
/// well under a hundredth of a pixel at screen scale). Deterministic f32.
fn sinf(x: f32) -> f32 {
    // reduce to [-pi, pi]
    let mut r = x - (2.0 * PI) * floorf((x + PI) / (2.0 * PI));
    // fold into [-pi/2, pi/2]
    if r > PI / 2.0 {
        r = PI - r;
    } else if r < -PI / 2.0 {
        r = -PI - r;
    }
    let x2 = r * r;
    r * (1.0 + x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 * (-1.0 / 5040.0 + x2 * (1.0 / 362880.0)))))
}

#[inline]
fn cosf(x: f32) -> f32 {
    sinf(x + PI / 2.0)
}

/// Row-major 2D affine: p' = (a*x + c*y + tx, b*x + d*y + ty).
#[derive(Clone, Copy, Debug)]
pub struct Affine {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub tx: f32,
    pub ty: f32,
}

impl Affine {
    pub const IDENTITY: Affine = Affine { a: 1.0, b: 0.0, c: 0.0, d: 1.0, tx: 0.0, ty: 0.0 };

    #[inline]
    fn translate(tx: f32, ty: f32) -> Affine {
        Affine { tx, ty, ..Affine::IDENTITY }
    }

    /// self ∘ other (apply `other` first, then `self`).
    fn then(&self, o: &Affine) -> Affine {
        Affine {
            a: self.a * o.a + self.c * o.b,
            b: self.b * o.a + self.d * o.b,
            c: self.a * o.c + self.c * o.d,
            d: self.b * o.c + self.d * o.d,
            tx: self.a * o.tx + self.c * o.ty + self.tx,
            ty: self.b * o.tx + self.d * o.ty + self.ty,
        }
    }

    #[inline]
    fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        (self.a * x + self.c * y + self.tx, self.b * x + self.d * y + self.ty)
    }

    /// True when the transform maps axis-aligned rects to axis-aligned,
    /// non-mirrored rects.
    #[inline]
    fn is_axis_aligned(&self) -> bool {
        self.b == 0.0 && self.c == 0.0 && self.a > 0.0 && self.d > 0.0
    }

}

// ---- 3D transforms (perspective subtrees) ---------------------------------------
//
// A node with `perspective > 0` becomes a 3D CONTEXT ROOT: its subtree
// composes 3x4 affine matrices (implicit preserve-3d), every painted box is
// projected through the root's perspective distance about the root center,
// and the projected quads are painter-sorted by camera-space depth before
// being clipped and emitted as TRIs. Glyph runs project their anchor and draw
// upright/unscaled (same contract as 2D rotation); images and box decoration
// (radius/border/shadow) are not part of the 3D contract.

/// Row-major 3x4 affine 3D matrix (the w row is implicitly [0,0,0,1] — all
/// composed ops are affine; perspective happens at projection time).
#[derive(Clone, Copy)]
struct Mat34 {
    m: [f32; 12],
}

impl Mat34 {
    const IDENTITY: Mat34 = Mat34 { m: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0] };

    /// self ∘ other (apply `other` first, then `self`).
    fn then(&self, o: &Mat34) -> Mat34 {
        let a = &self.m;
        let b = &o.m;
        let mut out = [0.0f32; 12];
        for row in 0..3 {
            for col in 0..4 {
                let mut v = a[row * 4] * b[col] + a[row * 4 + 1] * b[4 + col] + a[row * 4 + 2] * b[8 + col];
                if col == 3 {
                    v += a[row * 4 + 3];
                }
                out[row * 4 + col] = v;
            }
        }
        Mat34 { m: out }
    }

    #[inline]
    fn apply(&self, x: f32, y: f32, z: f32) -> (f32, f32, f32) {
        let m = &self.m;
        (
            m[0] * x + m[1] * y + m[2] * z + m[3],
            m[4] * x + m[5] * y + m[6] * z + m[7],
            m[8] * x + m[9] * y + m[10] * z + m[11],
        )
    }

    fn translate(x: f32, y: f32, z: f32) -> Mat34 {
        Mat34 { m: [1.0, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, 1.0, z] }
    }

    fn rot_x(deg: f32) -> Mat34 {
        let r = deg * (PI / 180.0);
        let (s, c) = (sinf(r), cosf(r));
        // Screen y grows DOWN: positive rotateX tips the top edge away, like CSS.
        Mat34 { m: [1.0, 0.0, 0.0, 0.0, 0.0, c, s, 0.0, 0.0, -s, c, 0.0] }
    }

    fn rot_y(deg: f32) -> Mat34 {
        let r = deg * (PI / 180.0);
        let (s, c) = (sinf(r), cosf(r));
        Mat34 { m: [c, 0.0, s, 0.0, 0.0, 1.0, 0.0, 0.0, -s, 0.0, c, 0.0] }
    }

    fn rot_z(deg: f32) -> Mat34 {
        let r = deg * (PI / 180.0);
        let (s, c) = (sinf(r), cosf(r));
        Mat34 { m: [c, -s, 0.0, 0.0, s, c, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0] }
    }

    fn scale(sx: f32, sy: f32) -> Mat34 {
        Mat34 { m: [sx, 0.0, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0] }
    }
}

/// One projected subdivision cell inside a textured 3D image. Cells stay in
/// one shared scratch vector instead of allocating a separate Vec per image.
struct TexCell {
    depth: f32,
    pts: [(f32, f32); 4],
    uv: [(f32, f32); 4],
}

/// One depth-sorted paintable inside a 3D context.
enum Item3 {
    /// Projected flat-color quad (screen space, pre-clip).
    Quad { pts: [(f32, f32); 4], color: u32 },
    /// One image node's projected cells. The mesh is the painter-sort unit so
    /// all TEX_TRIs for its texture remain consecutive for host batching.
    TexMesh { cell_start: usize, cell_end: usize, tex: u32, modulate: u32 },
    /// A text node's glyph run, anchored at its projected origin.
    Run { slot: u32, origin: (f32, f32), opacity: f32 },
}

/// Screen-space clip rect (x0 <= x1, y0 <= y1), f32 but integer-valued.
#[derive(Clone, Copy, Debug)]
struct Clip {
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
}

impl Clip {
    /// The full-viewport clip (the PSP screen, or whatever `Ui::set_viewport`
    /// established).
    fn viewport(screen: (f32, f32)) -> Clip {
        Clip { x0: 0.0, y0: 0.0, x1: screen.0, y1: screen.1 }
    }

    fn intersect(&self, o: &Clip) -> Clip {
        Clip {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        }
    }

    #[inline]
    fn is_empty(&self) -> bool {
        self.x1 <= self.x0 || self.y1 <= self.y0
    }

    /// Half-open containment ([x0, x1) x [y0, y1)) — matches the pixel span
    /// a painted rect covers, so the viewport edge is outside.
    #[inline]
    fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x0 && x < self.x1 && y >= self.y0 && y < self.y1
    }
}

// ---- word packing -------------------------------------------------------------

#[inline]
fn xy_word(x: f32, y: f32) -> u32 {
    let xi = roundf(x) as i32 as i16 as u16 as u32;
    let yi = roundf(y) as i32 as i16 as u16 as u32;
    xi | (yi << 16)
}

#[inline]
fn wh_word(w: f32, h: f32) -> u32 {
    let wi = roundf(w) as i32 as u16 as u32;
    let hi = roundf(h) as i32 as u16 as u32;
    wi | (hi << 16)
}

/// Multiply a packed ABGR color's alpha by `opacity` (0..1).
fn scale_alpha(color: u32, opacity: f32) -> u32 {
    if opacity >= 1.0 {
        return color;
    }
    let a = ((color >> 24) & 0xff) as f32 * clampf(opacity, 0.0, 1.0);
    (color & 0x00ff_ffff) | ((((a + 0.5) as u32) & 0xff) << 24)
}

#[inline]
fn alpha(color: u32) -> u32 {
    color >> 24
}

#[inline]
fn with_alpha_abgr(color: u32, a: u32) -> u32 {
    (color & 0x00ff_ffff) | ((a & 0xff) << 24)
}

#[inline]
fn scale_alpha_coverage(color: u32, coverage: u32) -> u32 {
    let a = ((alpha(color) * coverage.min(255) + 127) / 255).min(255);
    with_alpha_abgr(color, a)
}

#[inline]
fn ceilf(x: f32) -> f32 {
    -floorf(-x)
}

// ---- fills ---------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Fill {
    Flat(u32),
    /// Colors already opacity-scaled; dir = spec::GradDir ordinal. The
    /// optional middle stop is `(color, position)` along from -> to.
    Grad { from: u32, via: Option<(u32, f32)>, to: u32, dir: u32 },
}

fn gradient_color(from: u32, via: Option<(u32, f32)>, to: u32, f: f32) -> u32 {
    let f = clampf(f, 0.0, 1.0);
    if let Some((middle, position)) = via {
        let position = clampf(position, 0.0, 1.0);
        if position > 0.0 && position < 1.0 {
            return if f <= position {
                lerp_color(from, middle, f / position)
            } else {
                lerp_color(middle, to, (f - position) / (1.0 - position))
            };
        }
    }
    lerp_color(from, to, f)
}

/// Color of a local-rect corner under a fill. Corner order: 0 TL, 1 TR,
/// 2 BR, 3 BL.
fn corner_color(fill: &Fill, corner: usize) -> u32 {
    match *fill {
        Fill::Flat(c) => c,
        Fill::Grad { from, to, dir, .. } => {
            let at_from = match dir {
                d if d == spec::GradDir::ToTop as u32 => corner == 2 || corner == 3, // from at bottom
                d if d == spec::GradDir::ToLeft as u32 => corner == 1 || corner == 2, // from at right
                d if d == spec::GradDir::ToRight as u32 => corner == 0 || corner == 3, // from at left
                _ => corner == 0 || corner == 1, // ToBottom: from at top
            };
            if at_from {
                from
            } else {
                to
            }
        }
    }
}

fn lerp_color(a: u32, b: u32, f: f32) -> u32 {
    crate::anim::interp(a, b, f, true)
}

#[inline]
fn sqrtf(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut y = f32::from_bits((x.to_bits() >> 1) + 0x1fc0_0000);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y = 0.5 * (y + x / y);
    y
}

#[inline]
fn coverage_from_unit(x: f32) -> u32 {
    let v = clampf(x, 0.0, 1.0);
    (v * 255.0 + 0.5) as u32
}

#[inline]
fn coverage_mul(a: u32, b: u32) -> u32 {
    ((a.min(255) * b.min(255) + 127) / 255).min(255)
}

fn pixel_interval_coverage(pixel: i32, start: f32, end: f32) -> u32 {
    let a = (pixel as f32).max(start);
    let b = ((pixel + 1) as f32).min(end);
    if b <= a {
        0
    } else {
        coverage_from_unit(b - a)
    }
}

fn gradient_run_limit(fill: &Fill) -> i32 {
    match *fill {
        Fill::Grad { dir, .. } if dir == spec::GradDir::ToLeft as u32 || dir == spec::GradDir::ToRight as u32 => 4,
        _ => 1_000_000,
    }
}

fn vertical_gradient(fill: &Fill) -> bool {
    match *fill {
        Fill::Grad { dir, .. } => dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToBottom as u32,
        _ => false,
    }
}

fn fill_color_at(fill: &Fill, x0: f32, y0: f32, x1: f32, y1: f32, sx0: i32, sy: i32, sx1: i32, coverage: u32) -> u32 {
    let color = match *fill {
        Fill::Flat(color) => color,
        Fill::Grad { from, via, to, dir } => {
            let horizontal = dir == spec::GradDir::ToLeft as u32 || dir == spec::GradDir::ToRight as u32;
            let (p, denom) = if horizontal {
                (((sx0 + sx1) as f32 * 0.5) - x0, x1 - x0)
            } else {
                (sy as f32 + 0.5 - y0, y1 - y0)
            };
            let f = if denom <= 0.0 { 0.0 } else { clampf(p / denom, 0.0, 1.0) };
            let directed = if dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToLeft as u32 {
                1.0 - f
            } else {
                f
            };
            gradient_color(from, via, to, directed)
        }
    };
    scale_alpha_coverage(color, coverage)
}

// ---- the walker ------------------------------------------------------------------

/// Baked antialiased disc sprites keyed by integer radius — rounded corners
/// render as four O(1) corner TEX_QUADs + three RECTs instead of per-row
/// coverage spans (the spans measured ~7 ms/frame of CPU on real PSP
/// hardware for rounded-heavy screens).
pub struct DiscCache {
    /// (logical radius px, generation-tagged texture handle). Handles re-validate
    /// through `tex_resolve` on every use: `free_texture` is allowed to free
    /// a disc slot (JS misuse), which simply goes stale here and re-bakes.
    entries: Vec<(u32, i32)>,
}

impl DiscCache {
    pub const fn new() -> DiscCache {
        DiscCache { entries: Vec::new() }
    }
}

impl Default for DiscCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Get (or bake + upload) the AA disc texture for logical `r_px`. The disc is
/// a density-scaled 2r x 2r circle, supersampled 4x4, white RGB with coverage alpha
/// (PSM_8888), padded to pow2 — corners sample their quadrant and modulate
/// by the fill color, which matches the old span math's scale_alpha exactly
/// up to AA rounding.
fn disc_texture(
    cache: &mut DiscCache,
    textures: &mut Vec<crate::TexSlot>,
    tex_free: &mut Vec<u32>,
    r_px: u32,
    raster_density: u32,
) -> Option<(u32, u32)> {
    let raster_radius = r_px.checked_mul(raster_density)?;
    let size = 2u32.checked_mul(raster_radius)?;
    let dim = pow2_at_least(size);
    if dim > spec::TEX_MAX_DIM {
        return None;
    }
    if let Some(&(_, handle)) = cache.entries.iter().find(|&&(r, _)| r == r_px) {
        // Re-validate: a freed disc slot (free_texture on our handle) goes
        // stale here; drop the entry and re-bake below.
        if crate::tex_resolve(textures, handle).is_some() {
            return Some((handle as u32, dim));
        }
        cache.entries.retain(|&(r, _)| r != r_px);
    }
    let byte_len = (dim * dim * 4) as usize;
    let mut px = alloc::vec![0u8; byte_len];
    // Solid white RGB everywhere (alpha carries coverage): bilinear sampling
    // must never blend the fill toward black padding texels, or corners grow
    // a dark fringe on light fills.
    let mut i = 0;
    while i < byte_len {
        px[i] = 255;
        px[i + 1] = 255;
        px[i + 2] = 255;
        i += 4;
    }
    let c = raster_radius as f32; // disc center in raster pixels
    let rr = c * c;
    for y in 0..size {
        for x in 0..size {
            let mut covered = 0u32;
            for sy in 0..4u32 {
                for sx in 0..4u32 {
                    let fx = x as f32 + (sx as f32 + 0.5) / 4.0;
                    let fy = y as f32 + (sy as f32 + 0.5) / 4.0;
                    let dx = fx - c;
                    let dy = fy - c;
                    if dx * dx + dy * dy <= rr {
                        covered += 1;
                    }
                }
            }
            if covered > 0 {
                let o = ((y * dim + x) * 4) as usize;
                px[o + 3] = ((covered * 255 + 8) / 16) as u8;
            }
        }
    }
    let mut chunks = alloc::vec![0u128; byte_len.div_ceil(16)];
    unsafe {
        core::ptr::copy_nonoverlapping(px.as_ptr(), chunks.as_mut_ptr() as *mut u8, byte_len);
    }
    let handle = crate::tex_alloc(
        textures,
        tex_free,
        crate::Texture {
            data: chunks,
            byte_len,
            w: dim,
            h: dim,
            psm: spec::psm::PSM_8888,
            palette: None,
            // Linear: GL hosts sample the AA coverage smoothly under the
            // fixed-function interpolators' sub-texel drift (SGX-class ES1.1
            // parts turn NEAREST drift into staircased corners); at exact
            // 1:1 texel alignment — every density-1 software raster — linear
            // collapses to the nearest texel, so golden-pinned output is
            // byte-identical.
            linear: true,
            revision: 0,
        },
    );
    if handle < 0 {
        return None;
    }
    cache.entries.push((r_px, handle));
    Some((handle as u32, dim))
}

#[inline]
fn pow2_at_least(n: u32) -> u32 {
    let mut p = 1u32;
    while p < n {
        p <<= 1;
    }
    p
}

/// A node's local frame: layout position + translate, then rotate/scale
/// about its transform origin. Shared by paint and hit_test so pointer
/// geometry can never drift from painted geometry.
fn local_affine(l: &crate::tree::LayoutRect, r: &style::Resolved) -> Affine {
    let mut local = Affine::translate(l.x + r.translate_x, l.y + r.translate_y);
    if r.rotate != 0.0 || r.scale != 1.0 || r.scale_x != 1.0 || r.scale_y != 1.0 {
        // Transform origin: node center offset by the origin fractions
        // (`origin-*` utilities; e.g. origin-bottom = (0, +0.5)).
        let (cx, cy) = (l.w * (0.5 + r.origin_x), l.h * (0.5 + r.origin_y));
        let rad = r.rotate * (PI / 180.0);
        // rotate == 0 keeps EXACT axis alignment (the trig polyfill is a
        // few ulp off at multiples of pi/2, which would silently demote
        // scale-only transforms to the TRI path).
        let (s, c) = if r.rotate == 0.0 { (0.0, 1.0) } else { (sinf(rad), cosf(rad)) };
        let sx = r.scale * r.scale_x;
        let sy = r.scale * r.scale_y;
        // translate(c) * rotate * scale * translate(-c)
        let m = Affine {
            a: c * sx,
            b: s * sx,
            c: -s * sy,
            d: c * sy,
            tx: cx - (c * sx * cx - s * sy * cy),
            ty: cy - (s * sx * cx + c * sy * cy),
        };
        local = local.then(&m);
    }
    local
}

/// AABB (intersected with the screen) of a local rect under `world` —
/// conservative integer bounds: floor mins, ceil maxes.
fn world_aabb_of(screen: (f32, f32), world: &Affine, w: f32, h: f32) -> Clip {
    let pts = [
        world.apply(0.0, 0.0),
        world.apply(w, 0.0),
        world.apply(w, h),
        world.apply(0.0, h),
    ];
    let mut c = Clip { x0: pts[0].0, y0: pts[0].1, x1: pts[0].0, y1: pts[0].1 };
    for &(x, y) in &pts[1..] {
        c.x0 = c.x0.min(x);
        c.y0 = c.y0.min(y);
        c.x1 = c.x1.max(x);
        c.y1 = c.y1.max(y);
    }
    Clip {
        x0: floorf(clampf(c.x0, 0.0, screen.0)),
        y0: floorf(clampf(c.y0, 0.0, screen.1)),
        x1: ceilf(clampf(c.x1, 0.0, screen.0)),
        y1: ceilf(clampf(c.y1, 0.0, screen.1)),
    }
}

/// A screen point mapped into a node's local space under an invertible
/// world transform; None for degenerate transforms (which hit nothing).
fn local_point(world: &Affine, px: f32, py: f32) -> Option<(f32, f32)> {
    let det = world.a * world.d - world.b * world.c;
    if det == 0.0 {
        return None;
    }
    let dx = px - world.tx;
    let dy = py - world.ty;
    Some(((world.d * dx - world.c * dy) / det, (world.a * dy - world.b * dx) / det))
}

/// Visit `slot`'s children in PAINT ORDER: document order, stable-sorted by
/// z-index only when a child actually carries one (the hot path is a
/// straight index walk with zero allocations). Shared by `Walker::paint` and
/// `hit_walk` so hit testing can never disagree with painted stacking.
fn for_children_in_paint_order(
    tree: &Tree,
    styles: &StyleTable,
    slot: u32,
    mut f: impl FnMut(u32),
) {
    let node = &tree.slots[slot as usize];
    let mut needs_sort = false;
    for &cid in &node.children {
        if let Some(cs) = tree.resolve(cid) {
            if style::resolve_z(&tree.slots[cs as usize], styles) != 0 {
                needs_sort = true;
                break;
            }
        }
    }
    if !needs_sort {
        for i in 0..node.children.len() {
            let cid = tree.slots[slot as usize].children[i];
            if let Some(cs) = tree.resolve(cid) {
                f(cs);
            }
        }
    } else {
        let mut order: Vec<(i32, u32)> = Vec::with_capacity(node.children.len());
        for &cid in &node.children {
            if let Some(cs) = tree.resolve(cid) {
                order.push((style::resolve_z(&tree.slots[cs as usize], styles), cs));
            }
        }
        // Stable by construction: sort_by_key on Vec preserves insertion
        // order of equal keys (alloc's stable merge sort).
        order.sort_by_key(|&(z, _)| z);
        for (_, cs) in order {
            f(cs);
        }
    }
}

/// Whether a node CLAIMS a hit at LOCAL point (lx, ly) inside its border
/// box: only nodes that actually paint there do. A background, gradient,
/// bound image, text run — or any `focus:`/`active:` variant styling —
/// claims the whole box; a node whose only ink is a border or bevel ring
/// claims just that visible edge band, so an inset-0 frame overlay (the
/// classic-chrome window edge) decorates its window without swallowing
/// every press inside it. Pure layout containers (and the framework's
/// full-screen overlay/portal layers) pass hits through to whatever paints
/// beneath them, which is what a pointer steered by eye expects: you can
/// press what you can see. This is the engine's stand-in (and the DEFAULT,
/// until a hit-behavior style bit exists) for CSS `pointer-events`.
///
/// Variant records claim even while the CURRENT variant paints nothing —
/// hover-styled hotspots must be reachable before they are hovered, and a
/// hit result must not flip with the focus state it itself produces (no
/// hysteresis). A focusable with no paint in ANY variant gives no visual
/// feedback either — give it a bg (any alpha > 0) to make it a hit target.
/// Rounded/arc shapes claim their full box (corner approximation).
#[allow(clippy::too_many_arguments)]
fn claims_hit(
    node: &crate::tree::Node,
    r: &style::Resolved,
    styles: &StyleTable,
    lx: f32,
    ly: f32,
    w: f32,
    h: f32,
) -> bool {
    if node.node_type == spec::NodeType::Text as u8 {
        return true; // the glyph run
    }
    if node.node_type == spec::NodeType::Image as u8 && node.tex >= 0 {
        return true;
    }
    if alpha(r.bg_color) > 0
        || (r.grad_dir != NO_GRADIENT && r.grad_dir <= spec::GradDir::ToRight as u32)
        || styles
            .record(node.style_id)
            .is_some_and(|rec| !rec.focus.is_empty() || !rec.active.is_empty())
    {
        return true;
    }
    // Border/bevel-only ink: claim the edge band it actually paints.
    let mut band = 0.0f32;
    if r.border_width > 0.0 && alpha(r.border_color) > 0 {
        band = band.max(r.border_width);
    }
    if (r.bevel_outer_light | r.bevel_outer_dark | r.bevel_inner_light | r.bevel_inner_dark) != 0
        && r.bevel_width > 0.0
    {
        band = band.max(r.bevel_width * 2.0); // two nested rings
    }
    band > 0.0 && (lx < band || ly < band || lx >= w - band || ly >= h - band)
}

/// Topmost node at a logical point (spec op hitTest) — paint-order hit
/// testing over the laid-out tree: the winner is the LAST node in paint
/// order (document order + z-index) whose border box contains the point AND
/// that paints there (see `claims_hit` — pure layout containers are
/// hit-transparent, but their children are still tested). `display:none`
/// subtrees are skipped, and so are subtrees at effective opacity 0 —
/// paint culls them entirely, and what cannot be seen must not eat hits (a
/// faded-out-but-mounted toast). Partially transparent nodes still claim.
/// `overflow-hidden` clips descendants. A perspective (3D) subtree hits as
/// its context root's border box — only the 2D walk composes a world affine
/// per node (the DevTools inspector shares this limit), and swallowing the
/// hit beats clicking whatever sits BEHIND visible 3D content.
/// Returns the generation-tagged id, or 0.
pub fn hit_test(tree: &Tree, styles: &StyleTable, screen: (f32, f32), x: f32, y: f32) -> i32 {
    hit_test_root(tree, styles, spec::ROOT_ID, screen, x, y)
}

pub fn hit_test_root(
    tree: &Tree,
    styles: &StyleTable,
    root_id: i32,
    screen: (f32, f32),
    x: f32,
    y: f32,
) -> i32 {
    hit_point(tree, styles, root_id, screen, x, y, true)
}

/// Topmost node at a logical point by LAYOUT BOX alone (spec op
/// hitTestBounds; the touch hit FACT resolver). The identical walk minus the
/// `claims_hit` ink requirement: pure layout containers claim their box, so
/// a finger in a list's row gap still resolves to the list — UIKit bounds
/// semantics. Everything else (paint order, clips, transforms, opacity
/// culling, 3D contexts) matches `hit_test` exactly.
pub fn hit_test_bounds(tree: &Tree, styles: &StyleTable, screen: (f32, f32), x: f32, y: f32) -> i32 {
    hit_test_bounds_root(tree, styles, spec::ROOT_ID, screen, x, y)
}

pub fn hit_test_bounds_root(
    tree: &Tree,
    styles: &StyleTable,
    root_id: i32,
    screen: (f32, f32),
    x: f32,
    y: f32,
) -> i32 {
    hit_point(tree, styles, root_id, screen, x, y, false)
}

fn hit_point(
    tree: &Tree,
    styles: &StyleTable,
    root_id: i32,
    screen: (f32, f32),
    x: f32,
    y: f32,
    ink: bool,
) -> i32 {
    let Some(root_slot) = tree.resolve(root_id) else { return 0 };
    let mut hit = 0i32;
    hit_walk(tree, styles, screen, root_slot, Affine::IDENTITY, 1.0, Clip::viewport(screen), x, y, ink, &mut hit);
    hit
}

#[allow(clippy::too_many_arguments)]
fn hit_walk(
    tree: &Tree,
    styles: &StyleTable,
    screen: (f32, f32),
    slot: u32,
    parent_world: Affine,
    opacity: f32,
    clip: Clip,
    px: f32,
    py: f32,
    ink: bool,
    hit: &mut i32,
) {
    // The point is fixed, so a clip that excludes it excludes the node AND
    // every descendant (child clips only shrink).
    if !clip.contains(px, py) {
        return;
    }
    let node = &tree.slots[slot as usize];
    let r = style::resolve(node, styles, true);
    if r.display == spec::Display::None as u8 {
        return;
    }
    let l = node.layout;
    let world = parent_world.then(&local_affine(&l, &r));
    // Effective-opacity-0 subtrees are culled exactly like paint culls them.
    let op = clampf(opacity * r.opacity, 0.0, 1.0);
    if op <= 0.0 {
        return;
    }
    let local = local_point(&world, px, py);
    let inside = local.is_some_and(|(lx, ly)| lx >= 0.0 && lx < l.w && ly >= 0.0 && ly < l.h);
    if inside && r.hit_pass == 0 {
        let (lx, ly) = local.unwrap();
        if !ink || claims_hit(node, &r, styles, lx, ly, l.w, l.h) {
            *hit = node.id(slot);
        }
    }
    // Text children are absorbed into the node's glyph run (mirrors paint).
    if node.node_type == spec::NodeType::Text as u8 {
        return;
    }
    let mut child_clip = clip;
    if r.overflow == spec::Overflow::Hidden as u8 {
        child_clip = clip.intersect(&world_aabb_of(screen, &world, l.w, l.h));
        if !child_clip.contains(px, py) {
            return;
        }
    }
    if r.perspective > 0.0 {
        // 3D context: projected geometry is not point-testable from the 2D
        // walk — the context root claims its own box so clicks never fall
        // through to content painted BEHIND the visible 3D subtree.
        if inside && r.hit_pass == 0 {
            *hit = node.id(slot);
        }
        return;
    }
    for_children_in_paint_order(tree, styles, slot, |cs| {
        hit_walk(tree, styles, screen, cs, world, op, child_clip, px, py, ink, hit);
    });
}

struct Walker<'a> {
    tree: &'a Tree,
    styles: &'a StyleTable,
    fonts: &'a Fonts,
    /// Global vblank counter — drives deterministic sprite frame selection.
    frame: u64,
    /// Viewport bounds in px — every emitted coordinate is clipped to
    /// [0, screen.0] x [0, screen.1] (i16-safe; hosts cap it well under 32k).
    screen: (f32, f32),
    glyph_scratch: Vec<crate::text::GlyphPos>,
    /// Inside a perspective subtree (paint_3d): text always uses the baked
    /// pair there, so the provider-divergence check must not fire.
    in_3d: bool,
    /// Set when a text node's RECORDED provider no longer matches what the
    /// declared-transform path calls for (a paint-only transform changed
    /// since the last relayout, in either direction). Ui::draw() re-decides
    /// and REPAINTS before returning, so no frame with a stale pair ever
    /// leaves draw() (see lib.rs draw()).
    provider_stale: bool,
    /// Core texture slots + free list (baked corner discs allocate lazily
    /// during the walk, through the same slot storage as uploads).
    textures: &'a mut Vec<crate::TexSlot>,
    tex_free: &'a mut Vec<u32>,
    discs: &'a mut DiscCache,
    raster_density: u32,
    /// DevTools: slot to capture the world AABB of (u32::MAX = none).
    inspect_slot: u32,
    /// World AABB of `inspect_slot`, set when the walk reaches it.
    inspect_hit: Option<Clip>,
}

/// Build the full DrawList for the current (laid-out) tree. `frame` is the
/// core's vblank counter (Ui.frame); animated sprites pick their cell from it.
/// `screen` is the viewport every coordinate is clipped to. `cursor` is the
/// virtual cursor sprite as (tex handle, x, y, w, h) — its TEX_QUAD is
/// appended after everything else (topmost), outside layout and hit_test.
#[allow(clippy::too_many_arguments)]
pub fn build(
    tree: &Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    frame: u64,
    screen: (f32, f32),
    textures: &mut Vec<crate::TexSlot>,
    tex_free: &mut Vec<u32>,
    discs: &mut DiscCache,
    raster_density: u32,
    dl: &mut DrawList,
    inspect_id: i32,
    inspect_prev: Option<(f32, f32, f32, f32)>,
    cursor: Option<(u32, f32, f32, f32, f32)>,
) -> (Option<(f32, f32, f32, f32)>, Option<(f32, f32, f32, f32)>, bool) {
    build_root(
        tree,
        styles,
        fonts,
        frame,
        spec::ROOT_ID,
        screen,
        textures,
        tex_free,
        discs,
        raster_density,
        dl,
        inspect_id,
        inspect_prev,
        cursor,
    )
}

/// Build one independent output root into its own DrawList while sharing the
/// Ui resource tables and frame clock.
#[allow(clippy::too_many_arguments)]
pub fn build_root(
    tree: &Tree,
    styles: &StyleTable,
    fonts: &Fonts,
    frame: u64,
    root_id: i32,
    screen: (f32, f32),
    textures: &mut Vec<crate::TexSlot>,
    tex_free: &mut Vec<u32>,
    discs: &mut DiscCache,
    raster_density: u32,
    dl: &mut DrawList,
    inspect_id: i32,
    inspect_prev: Option<(f32, f32, f32, f32)>,
    cursor: Option<(u32, f32, f32, f32, f32)>,
) -> (Option<(f32, f32, f32, f32)>, Option<(f32, f32, f32, f32)>, bool) {
    dl.words.clear();
    // DevTools (docs/DEVTOOLS.md): slot of the inspected node, u32::MAX = none.
    // Nodes inside a perspective subtree take the paint_3d path and are not
    // captured (only the 2D walk composes a world Affine per node).
    let inspect_slot = if inspect_id != 0 {
        tree.resolve(inspect_id).unwrap_or(u32::MAX)
    } else {
        u32::MAX
    };
    let mut w = Walker {
        tree,
        styles,
        fonts,
        frame,
        screen,
        glyph_scratch: Vec::new(),
        textures,
        tex_free,
        discs,
        raster_density,
        inspect_slot,
        inspect_hit: None,
        in_3d: false,
        provider_stale: false,
    };
    let Some(root_slot) = tree.resolve(root_id) else {
        return (None, None, false);
    };
    w.paint(root_slot, Affine::IDENTITY, 1.0, Clip::viewport(screen), false, dl);
    let provider_stale = w.provider_stale;
    let target = w.inspect_hit.map(|c| (c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0));
    // Highlight glide: the drawn box exponentially approaches the target
    // (~0.35/draw ≈ converged in 6 draws), so switching the inspected node
    // slides the box across the screen instead of teleporting it. draw()
    // runs every vblank even while debug-paused, so the glide stays live in
    // a frozen world. Purely visual — debugRectXY/WH report the target.
    let drawn = match (target, inspect_prev) {
        (Some(t), Some(p)) => {
            const K: f32 = 0.35;
            let d = (
                p.0 + (t.0 - p.0) * K,
                p.1 + (t.1 - p.1) * K,
                p.2 + (t.2 - p.2) * K,
                p.3 + (t.3 - p.3) * K,
            );
            let close = (d.0 - t.0).abs() < 0.5
                && (d.1 - t.1).abs() < 0.5
                && (d.2 - t.2).abs() < 0.5
                && (d.3 - t.3).abs() < 0.5;
            Some(if close { t } else { d })
        }
        (Some(t), None) => Some(t), // first appearance: no glide-from-nowhere
        (None, _) => None,
    };
    if let Some((x, y, bw, bh)) = drawn {
        w.emit_highlight(dl, &Clip { x0: x, y0: y, x1: x + bw, y1: y + bh });
    }
    // Virtual cursor sprite: appended last so nothing paints over it (even
    // the DevTools highlight sits under the pointer the user is steering).
    if let Some((tex, cx, cy, cw, ch)) = cursor {
        w.emit_tex_quad(
            dl,
            &Affine::translate(cx, cy),
            cw,
            ch,
            tex,
            1.0,
            &Clip::viewport(screen),
            0.0,
            0.0,
            1.0,
            1.0,
        );
    }
    (target, drawn, provider_stale)
}

impl<'a> Walker<'a> {
    fn paint(
        &mut self,
        slot: u32,
        parent_world: Affine,
        opacity: f32,
        clip: Clip,
        in_transform: bool,
        dl: &mut DrawList,
    ) {
        let node = &self.tree.slots[slot as usize];
        let r = style::resolve(node, self.styles, true);
        // The provider gate accumulates EXACTLY like layout.rs build() —
        // one shared predicate (Resolved::declares_transform), so the draw
        // walk and the layout record can only diverge when a transform
        // VALUE changed since the last relayout, never on equivalent-but-
        // differently-composed matrices (a scale canceled by a child's
        // inverse must not oscillate the record).
        let in_transform = in_transform || r.declares_transform();
        if r.display == spec::Display::None as u8 {
            return;
        }
        let l = node.layout;
        let world = parent_world.then(&local_affine(&l, &r));
        // DevTools: capture the inspected node's border-box world AABB
        // (before the opacity cull so transparent nodes still highlight).
        if slot == self.inspect_slot {
            self.inspect_hit = Some(self.world_aabb(&world, l.w, l.h));
        }
        let op = clampf(opacity * r.opacity, 0.0, 1.0);
        if op <= 0.0 {
            return;
        }

        // -- background + shadow --------------------------------------------
        let has_grad = r.grad_dir != NO_GRADIENT && r.grad_dir <= spec::GradDir::ToRight as u32;
        let bg_color = scale_alpha(r.bg_color, op);
        let border_color = scale_alpha(r.border_color, op);
        let rounded_border = r.radius > 0.0 && r.border_width > 0.0 && alpha(border_color) > 0;
        let rounded_ring = rounded_border && (has_grad || alpha(bg_color) > 0);

        if r.shadow > 0 && (alpha(bg_color) > 0 || has_grad) {
            self.emit_shadow(dl, &world, l.w, l.h, r.radius, r.shadow, op, &clip);
        }

        let is_arc = r.arc_width > 0.0 && r.arc_sweep != 0.0;
        if is_arc {
            // Arc primitive: the bg color strokes an annular sector instead
            // of filling the box (spec.ts PROP.arcStart/arcSweep/arcWidth).
            if alpha(bg_color) > 0 {
                self.emit_arc(dl, &world, l.w, l.h, &r, bg_color, &clip);
            }
        } else if rounded_ring {
            self.emit_rounded_box(dl, &world, 0.0, 0.0, l.w, l.h, r.radius, Fill::Flat(border_color), &clip);
            let bw = r.border_width.min(l.w * 0.5).min(l.h * 0.5);
            if has_grad {
                let fill = Fill::Grad {
                    from: scale_alpha(r.grad_from, op),
                    via: r.grad_via_pos.is_finite().then(|| (scale_alpha(r.grad_via, op), clampf(r.grad_via_pos, 0.0, 1.0))),
                    to: scale_alpha(r.grad_to, op),
                    dir: r.grad_dir,
                };
                self.emit_rounded_box(dl, &world, bw, bw, l.w - bw, l.h - bw, (r.radius - bw).max(0.0), fill, &clip);
            } else {
                self.emit_rounded_box(
                    dl,
                    &world,
                    bw,
                    bw,
                    l.w - bw,
                    l.h - bw,
                    (r.radius - bw).max(0.0),
                    Fill::Flat(bg_color),
                    &clip,
                );
            }
        } else if has_grad {
            let fill = Fill::Grad {
                from: scale_alpha(r.grad_from, op),
                via: r.grad_via_pos.is_finite().then(|| (scale_alpha(r.grad_via, op), clampf(r.grad_via_pos, 0.0, 1.0))),
                to: scale_alpha(r.grad_to, op),
                dir: r.grad_dir,
            };
            self.emit_rounded_box(dl, &world, 0.0, 0.0, l.w, l.h, r.radius, fill, &clip);
        } else if alpha(bg_color) > 0 {
            self.emit_rounded_box(dl, &world, 0.0, 0.0, l.w, l.h, r.radius, Fill::Flat(bg_color), &clip);
        }

        // -- border: 4 inset strips ------------------------------------------
        let bw = r.border_width;
        if !rounded_ring && bw > 0.0 && alpha(border_color) > 0 {
            if rounded_border {
                self.emit_rounded_border(dl, &world, 0.0, 0.0, l.w, l.h, r.radius, bw, Fill::Flat(border_color), &clip);
            } else {
                let bc = Fill::Flat(border_color);
                let bwx = bw.min(l.w * 0.5);
                let bwy = bw.min(l.h * 0.5);
                self.emit_box(dl, &world, 0.0, 0.0, l.w, bwy, bc, &clip); // top
                self.emit_box(dl, &world, 0.0, l.h - bwy, l.w, l.h, bc, &clip); // bottom
                self.emit_box(dl, &world, 0.0, bwy, bwx, l.h - bwy, bc, &clip); // left
                self.emit_box(dl, &world, l.w - bwx, bwy, l.w, l.h - bwy, bc, &clip); // right
            }
        }

        // -- bevel rings: classic-chrome 3D edges (spec.ts PROP.bevelOuter*..) --
        // Two nested inset rings of 4 strips each. Per ring, light paints
        // top+left first, then dark paints bottom+right FULL-LENGTH, so dark
        // owns the shared corners (98.css box-shadow stacking). Square only:
        // radius > 0 disables bevels (the compiler rejects the combination).
        if (r.bevel_outer_light | r.bevel_outer_dark | r.bevel_inner_light | r.bevel_inner_dark)
            != 0
            && r.bevel_width > 0.0
            && r.radius <= 0.0
            && !is_arc
        {
            let bvw = r.bevel_width;
            let rings = [
                (0.0, r.bevel_outer_light, r.bevel_outer_dark),
                (bvw, r.bevel_inner_light, r.bevel_inner_dark),
            ];
            for &(inset, light, dark) in rings.iter() {
                let light = scale_alpha(light, op);
                let dark = scale_alpha(dark, op);
                if alpha(light) == 0 && alpha(dark) == 0 {
                    continue;
                }
                let (x0, y0, x1, y1) = (inset, inset, l.w - inset, l.h - inset);
                // Skip rings the box is too small to hold (deterministic guard).
                if x1 - x0 < bvw * 2.0 || y1 - y0 < bvw * 2.0 {
                    continue;
                }
                if alpha(light) > 0 {
                    let fl = Fill::Flat(light);
                    self.emit_box(dl, &world, x0, y0, x1, y0 + bvw, fl, &clip); // top
                    self.emit_box(dl, &world, x0, y0, x0 + bvw, y1, fl, &clip); // left
                }
                if alpha(dark) > 0 {
                    let fd = Fill::Flat(dark);
                    self.emit_box(dl, &world, x0, y1 - bvw, x1, y1, fd, &clip); // bottom
                    self.emit_box(dl, &world, x1 - bvw, y0, x1, y1, fd, &clip); // right
                }
            }
        }

        // -- text run ----------------------------------------------------------
        if node.node_type == spec::NodeType::Text as u8 {
            self.emit_text(dl, node, &r, &world, op, &clip, l.w, in_transform);
            // Text children are absorbed into the run — do not recurse.
            return;
        }

        // -- image / animated sprite -------------------------------------------
        if node.node_type == spec::NodeType::Image as u8 && node.tex >= 0 {
            // Plain image samples the whole texture; a sprite samples the
            // current frame's atlas cell (auto-played from the vblank counter).
            let (fu0, fv0, fu1, fv1) = if node.sprite_frames > 0 {
                let cols = node.sprite_cols.max(1) as u32;
                let rows = (node.sprite_frames as u32).div_ceil(cols);
                let step = node.sprite_step.max(1) as u64;
                let elapsed = self.frame.wrapping_sub(node.sprite_start);
                let idx = ((elapsed / step) % node.sprite_frames as u64) as u32;
                let (cx, cy) = (idx % cols, idx / cols);
                (
                    cx as f32 / cols as f32,
                    cy as f32 / rows as f32,
                    (cx + 1) as f32 / cols as f32,
                    (cy + 1) as f32 / rows as f32,
                )
            } else {
                (0.0, 0.0, 1.0, 1.0)
            };
            self.emit_tex_quad(dl, &world, l.w, l.h, node.tex as u32, op, &clip, fu0, fv0, fu1, fv1);
        }

        // -- installed application surface -----------------------------------
        if node.node_type == spec::NodeType::Surface as u8 && node.compositor_surface >= 0 {
            self.emit_compositor_surface(
                dl,
                &world,
                l.w,
                l.h,
                node.compositor_surface as u32,
                node.compositor_focused,
                &clip,
            );
        }

        // -- children (overflow-hidden scissor around them; z-index stable
        //    sort within siblings) ---------------------------------------------
        let mut child_clip = clip;
        let mut scissored = false;
        if r.overflow == spec::Overflow::Hidden as u8 {
            // Scissor rects are axis-aligned: rotated clip boxes use the AABB
            // of the transformed rect (conservative).
            let rect = self.world_aabb(&world, l.w, l.h);
            child_clip = clip.intersect(&rect);
            if child_clip.is_empty() {
                return; // nothing of the subtree can be visible
            }
            dl.words.push(spec::draw_op::SCISSOR);
            dl.words.push(xy_word(child_clip.x0, child_clip.y0));
            dl.words.push(wh_word(child_clip.x1 - child_clip.x0, child_clip.y1 - child_clip.y0));
            scissored = true;
        }

        if r.perspective > 0.0 {
            // 3D context root: the subtree composes 3x4 matrices, projects
            // through r.perspective about this node's center and painter-sorts.
            self.paint_3d(slot, &world, op, &child_clip, dl, r.perspective, l.w, l.h);
            if scissored {
                dl.words.push(spec::draw_op::SCISSOR_POP);
            }
            return;
        }

        // Children in paint order — shared with hit_walk so pointer hits can
        // never disagree with painted stacking.
        let (tree, styles) = (self.tree, self.styles);
        for_children_in_paint_order(tree, styles, slot, |cs| {
            self.paint(cs, world, op, child_clip, in_transform, dl);
        });

        if scissored {
            dl.words.push(spec::draw_op::SCISSOR_POP);
        }
    }

    // ---- 3D context ---------------------------------------------------------

    /// Paint the subtree of a perspective root: collect projected quads and
    /// glyph runs depth-first, painter-sort by camera-space depth (far first),
    /// then clip + emit. `w`/`h` are the root's layout size (the perspective
    /// origin sits at its center, CSS default).
    #[allow(clippy::too_many_arguments)]
    fn paint_3d(
        &mut self,
        root_slot: u32,
        root_world: &Affine,
        opacity: f32,
        clip: &Clip,
        dl: &mut DrawList,
        distance: f32,
        w: f32,
        h: f32,
    ) {
        // Text under a perspective root always uses the baked pair; the
        // provider-divergence check is suspended for the subtree.
        let was_3d = self.in_3d;
        self.in_3d = true;
        let (cx, cy) = (w * 0.5, h * 0.5);
        let mut items: Vec<(f32, Item3)> = Vec::new();
        let mut tex_cells: Vec<TexCell> = Vec::new();
        let root = &self.tree.slots[root_slot as usize];
        let children: Vec<i32> = root.children.clone();
        for cid in children {
            if let Some(cs) = self.tree.resolve(cid) {
                self.collect_3d(
                    cs, &Mat34::IDENTITY, opacity, root_world, distance, cx, cy,
                    &mut items, &mut tex_cells,
                );
            }
        }
        // Painter's algorithm: farthest (smallest camera z) first. total_cmp
        // keeps this deterministic; stable sort preserves tree order for ties.
        items.sort_by(|a, b| a.0.total_cmp(&b.0));
        for (_, item) in items {
            match item {
                Item3::Quad { pts, color } => {
                    let poly: Vec<ClipVert> = pts
                        .iter()
                        .map(|&(x, y)| ClipVert { x, y, color: unpack(color), u: 0.0, v: 0.0 })
                        .collect();
                    let clipped = sutherland_hodgman(&poly, clip);
                    for i in 1..clipped.len().saturating_sub(1) {
                        emit_tri(dl, &clipped[0], &clipped[i], &clipped[i + 1], clip, self.screen);
                    }
                }
                Item3::TexMesh { cell_start, cell_end, tex, modulate } => {
                    for cell in &tex_cells[cell_start..cell_end] {
                        let poly: Vec<ClipVert> = cell.pts
                            .iter()
                            .zip(cell.uv.iter())
                            .map(|(&(x, y), &(u, v))| ClipVert { x, y, color: [255.0; 4], u, v })
                            .collect();
                        let clipped = sutherland_hodgman(&poly, clip);
                        for i in 1..clipped.len().saturating_sub(1) {
                            emit_tex_tri(dl, tex, modulate, &clipped[0], &clipped[i], &clipped[i + 1], clip, self.screen);
                        }
                    }
                }
                Item3::Run { slot, origin, opacity } => {
                    // (borrows through the walker's &'a Tree field, so the
                    // node ref is not tied to &mut self)
                    let node = &self.tree.slots[slot as usize];
                    let r = style::resolve(node, self.styles, true);
                    let anchor = Affine::translate(origin.0, origin.1);
                    self.emit_text(dl, node, &r, &anchor, opacity, clip, node.layout.w, true);
                }
            }
        }
        self.in_3d = was_3d;
    }

    /// Depth-first 3D collection. `m` maps node-local 3D coords into the
    /// context root's local space; projection happens here so every painted
    /// box becomes one projected painter item + depth key; textured images
    /// retain their subdivided cells inside one mesh item for host batching.
    #[allow(clippy::too_many_arguments)]
    fn collect_3d(
        &self,
        slot: u32,
        m: &Mat34,
        opacity: f32,
        root_world: &Affine,
        distance: f32,
        cx: f32,
        cy: f32,
        items: &mut Vec<(f32, Item3)>,
        tex_cells: &mut Vec<TexCell>,
    ) {
        let node = &self.tree.slots[slot as usize];
        let r = style::resolve(node, self.styles, true);
        if r.display == spec::Display::None as u8 {
            return;
        }
        let op = opacity * clampf(r.opacity, 0.0, 1.0);
        if op <= 0.0 {
            return;
        }
        let l = node.layout;
        // Local matrix, canonical function order (matches the CSS transform
        // lists this models: translate/translateZ leftmost, then rotate,
        // rotateX, rotateY, with 2D scale innermost), conjugated around the
        // transform origin.
        let (ox, oy) = (l.w * (0.5 + r.origin_x), l.h * (0.5 + r.origin_y));
        let mut local = Mat34::translate(l.x + r.translate_x, l.y + r.translate_y, r.translate_z)
            .then(&Mat34::translate(ox, oy, 0.0));
        if r.rotate != 0.0 {
            local = local.then(&Mat34::rot_z(r.rotate));
        }
        if r.rotate_x != 0.0 {
            local = local.then(&Mat34::rot_x(r.rotate_x));
        }
        if r.rotate_y != 0.0 {
            local = local.then(&Mat34::rot_y(r.rotate_y));
        }
        let (sx, sy) = (r.scale * r.scale_x, r.scale * r.scale_y);
        if sx != 1.0 || sy != 1.0 {
            local = local.then(&Mat34::scale(sx, sy));
        }
        local = local.then(&Mat34::translate(-ox, -oy, 0.0));
        let m2 = m.then(&local);

        let project = |x: f32, y: f32| -> ((f32, f32), f32) {
            let (px, py, pz) = m2.apply(x, y, 0.0);
            let denom = (distance - pz).max(1.0); // near guard
            let f = distance / denom;
            let lx = cx + (px - cx) * f;
            let ly = cy + (py - cy) * f;
            (root_world.apply(lx, ly), pz)
        };

        // Background -> one flat quad (gradients flatten to the mid-blend;
        // radius/border/shadow are outside the 3D contract).
        let color = if r.grad_dir != NO_GRADIENT && r.grad_dir <= spec::GradDir::ToRight as u32 {
            gradient_color(
                r.grad_from,
                r.grad_via_pos.is_finite().then(|| (r.grad_via, clampf(r.grad_via_pos, 0.0, 1.0))),
                r.grad_to,
                0.5,
            )
        } else {
            r.bg_color
        };
        let color = scale_alpha(color, op);
        if alpha(color) > 0 && l.w > 0.0 && l.h > 0.0 {
            let c0 = project(0.0, 0.0);
            let c1 = project(l.w, 0.0);
            let c2 = project(l.w, l.h);
            let c3 = project(0.0, l.h);
            let depth = (c0.1 + c1.1 + c2.1 + c3.1) * 0.25;
            items.push((depth, Item3::Quad { pts: [c0.0, c1.0, c2.0, c3.0], color }));
        }
        if node.node_type == spec::NodeType::Image as u8 && node.tex >= 0 && l.w > 0.0 && l.h > 0.0 {
            let (fu0, fv0, fu1, fv1) = if node.sprite_frames > 0 {
                let cols = node.sprite_cols.max(1) as u32;
                let rows = (node.sprite_frames as u32).div_ceil(cols);
                let step = node.sprite_step.max(1) as u64;
                let elapsed = self.frame.wrapping_sub(node.sprite_start);
                let idx = ((elapsed / step) % node.sprite_frames as u64) as u32;
                let (cx2, cy2) = (idx % cols, idx / cols);
                (
                    cx2 as f32 / cols as f32,
                    cy2 as f32 / rows as f32,
                    (cx2 + 1) as f32 / cols as f32,
                    (cy2 + 1) as f32 / rows as f32,
                )
            } else {
                (0.0, 0.0, 1.0, 1.0)
            };
            let c0 = project(0.0, 0.0);
            let c1 = project(l.w, 0.0);
            let c2 = project(l.w, l.h);
            let c3 = project(0.0, l.h);
            // Perspective-correct subdivision. TEX_TRI sampling is affine in
            // screen space (spec, PSP-authentic): exact when the projection
            // factor is constant across the quad, but a foreshortened quad's
            // interior texture lines visibly KINK along the triangle diagonal
            // (a real-hardware find on the launcher's tilted cards). Split
            // into a grid sized by the perspective variation per axis — each
            // cell's corners get projectively correct UVs, and the residual
            // per-cell affine error shrinks quadratically. Flat or affine
            // mappings stay a single quad, byte-identical to before.
            let fz = |pz: f32| distance / (distance - pz).max(1.0);
            let (f0, f1, f2, f3) = (fz(c0.1), fz(c1.1), fz(c2.1), fz(c3.1));
            let ratio = |a: f32, b: f32| if a > b { a / b } else { b / a };
            let hvar = ratio(f0, f1).max(ratio(f3, f2));
            let vvar = ratio(f0, f3).max(ratio(f1, f2));
            let seg = |v: f32| -> u32 {
                if v <= 1.02 {
                    1
                } else {
                    (1.0 + (v - 1.0) * 16.0).min(8.0) as u32
                }
            };
            let (nx, ny) = (seg(hvar), seg(vvar));
            let modulate = scale_alpha(0xffff_ffff, op);
            // Sort and emit at IMAGE granularity, matching the painter unit
            // used before subdivision was introduced. Sorting every cell
            // globally makes coplanar images (notably a cover + reflection)
            // interleave texture handles, defeating the PSP GE backend's
            // consecutive-TEX_TRI batching and multiplying binds/flushes.
            let mesh_depth = (c0.1 + c1.1 + c2.1 + c3.1) * 0.25 + 0.005;
            let cell_start = tex_cells.len();
            if nx == 1 && ny == 1 {
                tex_cells.push(TexCell {
                    depth: mesh_depth,
                    pts: [c0.0, c1.0, c2.0, c3.0],
                    uv: [(fu0, fv0), (fu1, fv0), (fu1, fv1), (fu0, fv1)],
                });
            } else {
                for j in 0..ny {
                    for i in 0..nx {
                        let (t0, t1) = (i as f32 / nx as f32, (i + 1) as f32 / nx as f32);
                        let (s0, s1) = (j as f32 / ny as f32, (j + 1) as f32 / ny as f32);
                        let g0 = project(l.w * t0, l.h * s0);
                        let g1 = project(l.w * t1, l.h * s0);
                        let g2 = project(l.w * t1, l.h * s1);
                        let g3 = project(l.w * t0, l.h * s1);
                        let depth = (g0.1 + g1.1 + g2.1 + g3.1) * 0.25 + 0.005;
                        let (u0, u1) = (fu0 + (fu1 - fu0) * t0, fu0 + (fu1 - fu0) * t1);
                        let (v0, v1) = (fv0 + (fv1 - fv0) * s0, fv0 + (fv1 - fv0) * s1);
                        tex_cells.push(TexCell {
                            depth,
                            pts: [g0.0, g1.0, g2.0, g3.0],
                            uv: [(u0, v0), (u1, v0), (u1, v1), (u0, v1)],
                        });
                    }
                }
            }
            let cell_end = tex_cells.len();
            // Stable insertion sort: a mesh has at most 64 cells, so this
            // preserves the former far-to-near cell order without another
            // temporary allocation inside the frame loop.
            for i in cell_start + 1..cell_end {
                let mut j = i;
                while j > cell_start
                    && tex_cells[j].depth.total_cmp(&tex_cells[j - 1].depth).is_lt()
                {
                    tex_cells.swap(j, j - 1);
                    j -= 1;
                }
            }
            items.push((
                mesh_depth,
                Item3::TexMesh {
                    cell_start,
                    cell_end,
                    tex: node.tex as u32,
                    modulate,
                },
            ));
        }
        if node.node_type == spec::NodeType::Text as u8 {
            // Glyphs anchor at the projected text origin and stay upright
            // (the 2D rotation contract). Depth = the anchor's z.
            let ((sx, sy), z) = project(0.0, 0.0);
            items.push((z + 0.01, Item3::Run { slot, origin: (sx, sy), opacity: op }));
            return; // text children are absorbed into the run
        }
        for &cid in &node.children {
            if let Some(cs) = self.tree.resolve(cid) {
                self.collect_3d(cs, &m2, op, root_world, distance, cx, cy, items, tex_cells);
            }
        }
    }

    /// Rasterize an annular sector ("stroke arc" with round caps) as
    /// alpha-covered RECT runs — deterministic 2x2 supersampled coverage.
    /// Axis-aligned worlds only; rotation belongs in arcStart.
    fn emit_arc(
        &self,
        dl: &mut DrawList,
        world: &Affine,
        w: f32,
        h: f32,
        r: &style::Resolved,
        color: u32,
        clip: &Clip,
    ) {
        if !world.is_axis_aligned() {
            return;
        }
        let (cx, cy) = world.apply(w * 0.5, h * 0.5);
        let s = world.d.max(0.0);
        let outer = (w.min(h) * 0.5) * s;
        let width = (r.arc_width * s).min(outer);
        if outer <= 0.0 || width <= 0.0 {
            return;
        }
        let rmid = outer - width * 0.5;
        let half = width * 0.5;
        // Ring test in squared space (|d - rmid| <= half without the sqrt).
        let ring_in = (rmid - half).max(0.0);
        let ring_in2 = ring_in * ring_in;
        let ring_out = rmid + half;
        let ring_out2 = ring_out * ring_out;
        let sweep = clampf(r.arc_sweep, -360.0, 360.0);
        let (a0, asweep) = if sweep < 0.0 { (r.arc_start + sweep, -sweep) } else { (r.arc_start, sweep) };
        let full = asweep >= 360.0;
        let major = asweep > 180.0;
        // 0 deg = 12 o'clock, clockwise positive.
        let dir = |deg: f32| {
            let rad = deg * (PI / 180.0);
            (sinf(rad), -cosf(rad))
        };
        let (svx, svy) = dir(a0);
        let (evx, evy) = dir(a0 + asweep);
        let cap0 = (cx + svx * rmid, cy + svy * rmid);
        let cap1 = (cx + evx * rmid, cy + evy * rmid);
        let half2 = half * half;

        let x0 = floorf(clampf(cx - outer, clip.x0, clip.x1)) as i32;
        let x1 = ceilf(clampf(cx + outer, clip.x0, clip.x1)) as i32;
        let y0 = floorf(clampf(cy - outer, clip.y0, clip.y1)) as i32;
        let y1 = ceilf(clampf(cy + outer, clip.y0, clip.y1)) as i32;

        let covered = |px: f32, py: f32| -> bool {
            let dx = px - cx;
            let dy = py - cy;
            let d2 = dx * dx + dy * dy;
            let in_ring = d2 >= ring_in2 && d2 <= ring_out2;
            if in_ring {
                let in_angle = full || {
                    let cross_s = svx * dy - svy * dx;
                    let cross_e = evx * dy - evy * dx;
                    if major { cross_s >= 0.0 || cross_e <= 0.0 } else { cross_s >= 0.0 && cross_e <= 0.0 }
                };
                if in_angle {
                    return true;
                }
            }
            if full {
                return false;
            }
            // Round caps at both endpoints.
            let d0x = px - cap0.0;
            let d0y = py - cap0.1;
            if d0x * d0x + d0y * d0y <= half2 {
                return true;
            }
            let d1x = px - cap1.0;
            let d1y = py - cap1.1;
            d1x * d1x + d1y * d1y <= half2
        };

        for row in y0..y1 {
            // Row clamp: only columns whose pixel can touch the OUTER circle
            // matter; the ring's inner hole is skipped analytically too (cap
            // discs sit ON the ring so they never reach into the hole). This
            // cuts the scanned pixels ~3x — the arc rasterizer runs every
            // frame on the PSP CPU.
            let dy = row as f32 + 0.5 - cy;
            let dy2 = dy * dy;
            if dy2 > ring_out2 + ring_out + 1.0 {
                continue;
            }
            let half_span = sqrtf((ring_out2 - dy2).max(0.0)) + 1.0;
            let row_x0 = (floorf(cx - half_span) as i32).max(x0);
            let row_x1 = (ceilf(cx + half_span) as i32).min(x1);
            let hole_span = if dy2 < ring_in2 { sqrtf(ring_in2 - dy2) - 1.0 } else { -1.0 };
            let (hole_x0, hole_x1) = if hole_span > 1.0 {
                ((cx - hole_span) as i32, (cx + hole_span) as i32)
            } else {
                (i32::MAX, i32::MIN)
            };
            let mut run_start = row_x0;
            let mut run_cov = 0u32;
            let flush = |dl: &mut DrawList, start: i32, end: i32, cov: u32| {
                if cov == 0 || end <= start {
                    return;
                }
                let c = scale_alpha(color, cov as f32 / 4.0);
                if alpha(c) == 0 {
                    return;
                }
                dl.words.push(spec::draw_op::RECT);
                dl.words.push(xy_word(start as f32, row as f32));
                dl.words.push(wh_word((end - start) as f32, 1.0));
                dl.words.push(c);
            };
            let mut col = row_x0;
            while col < row_x1 {
                if col >= hole_x0 && col < hole_x1 {
                    // Fully inside the ring hole: flush and jump across.
                    if run_cov != 0 {
                        flush(dl, run_start, col, run_cov);
                        run_cov = 0;
                    }
                    run_start = hole_x1;
                    col = hole_x1;
                    continue;
                }
                let mut cov = 0u32;
                for (ox, oy) in [(0.25f32, 0.25f32), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                    if covered(col as f32 + ox, row as f32 + oy) {
                        cov += 1;
                    }
                }
                if cov != run_cov {
                    flush(dl, run_start, col, run_cov);
                    run_start = col;
                    run_cov = cov;
                }
                col += 1;
            }
            flush(dl, run_start, row_x1, run_cov);
        }
    }

    /// AABB (intersected with the screen) of a local rect under `world`.
    fn world_aabb(&self, world: &Affine, w: f32, h: f32) -> Clip {
        world_aabb_of(self.screen, world, w, h)
    }

    /// Emit a solid/gradient local-space rect under `world`: axis-aligned
    /// path (RECT/GRAD_RECT, clipped with color re-interpolation) or the
    /// rotated path (Sutherland-Hodgman -> TRI ops).
    #[allow(clippy::too_many_arguments)]
    fn emit_box(&self, dl: &mut DrawList, world: &Affine, x0: f32, y0: f32, x1: f32, y1: f32, fill: Fill, clip: &Clip) {
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        // Draw a three-stop gradient as two ordinary two-stop boxes. This
        // preserves the backend DrawList contract: every backend still sees
        // GRAD_RECT/TRI, while clipping and rotated painter order remain in
        // the core that resolved the Tailwind style.
        if let Fill::Grad { from, via: Some((middle, position)), to, dir } = fill {
            let position = clampf(position, 0.0, 1.0);
            if position > 0.0 && position < 1.0 {
                let first = Fill::Grad { from, via: None, to: middle, dir };
                let second = Fill::Grad { from: middle, via: None, to, dir };
                if dir == spec::GradDir::ToRight as u32 {
                    let split = x0 + (x1 - x0) * position;
                    self.emit_box(dl, world, x0, y0, split, y1, first, clip);
                    self.emit_box(dl, world, split, y0, x1, y1, second, clip);
                } else if dir == spec::GradDir::ToLeft as u32 {
                    let split = x1 - (x1 - x0) * position;
                    self.emit_box(dl, world, split, y0, x1, y1, first, clip);
                    self.emit_box(dl, world, x0, y0, split, y1, second, clip);
                } else if dir == spec::GradDir::ToTop as u32 {
                    let split = y1 - (y1 - y0) * position;
                    self.emit_box(dl, world, x0, split, x1, y1, first, clip);
                    self.emit_box(dl, world, x0, y0, x1, split, second, clip);
                } else {
                    let split = y0 + (y1 - y0) * position;
                    self.emit_box(dl, world, x0, y0, x1, split, first, clip);
                    self.emit_box(dl, world, x0, split, x1, y1, second, clip);
                }
                return;
            }
        }
        if world.is_axis_aligned() {
            let (sx0, sy0) = world.apply(x0, y0);
            let (sx1, sy1) = world.apply(x1, y1);
            let c = Clip {
                x0: sx0.max(clip.x0),
                y0: sy0.max(clip.y0),
                x1: sx1.min(clip.x1),
                y1: sy1.min(clip.y1),
            };
            if c.is_empty() || roundf(c.x1 - c.x0) <= 0.0 || roundf(c.y1 - c.y0) <= 0.0 {
                return;
            }
            match fill {
                Fill::Flat(color) => {
                    dl.words.push(spec::draw_op::RECT);
                    dl.words.push(xy_word(c.x0, c.y0));
                    dl.words.push(wh_word(c.x1 - c.x0, c.y1 - c.y0));
                    dl.words.push(color);
                }
                Fill::Grad { from, to, dir, .. } => {
                    // Re-interpolate the endpoint colors over the clipped
                    // span so the visible slice keeps the exact gradient.
                    let (f0, f1) = if dir == spec::GradDir::ToLeft as u32 || dir == spec::GradDir::ToRight as u32 {
                        let w = sx1 - sx0;
                        ((c.x0 - sx0) / w, (c.x1 - sx0) / w)
                    } else {
                        let h = sy1 - sy0;
                        ((c.y0 - sy0) / h, (c.y1 - sy0) / h)
                    };
                    // ToTop/ToLeft run against the +axis: fraction measured
                    // from the far edge.
                    let (gf, gt) = if dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToLeft as u32 {
                        (lerp_color(to, from, f0), lerp_color(to, from, f1))
                    } else {
                        (lerp_color(from, to, f0), lerp_color(from, to, f1))
                    };
                    // Store colors back in "from/to along dir" order.
                    let (out_from, out_to) = if dir == spec::GradDir::ToTop as u32 || dir == spec::GradDir::ToLeft as u32 {
                        (gt, gf)
                    } else {
                        (gf, gt)
                    };
                    dl.words.push(spec::draw_op::GRAD_RECT);
                    dl.words.push(xy_word(c.x0, c.y0));
                    dl.words.push(wh_word(c.x1 - c.x0, c.y1 - c.y0));
                    dl.words.push(out_from);
                    dl.words.push(out_to);
                    dl.words.push(dir);
                }
            }
        } else {
            // Rotated: transform corners, Sutherland-Hodgman clip, fan into
            // TRI ops (gouraud carries any gradient through the clip).
            let corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
            let mut poly: Vec<ClipVert> = Vec::with_capacity(8);
            for (i, &(lx, ly)) in corners.iter().enumerate() {
                let (sx, sy) = world.apply(lx, ly);
                poly.push(ClipVert { x: sx, y: sy, color: unpack(corner_color(&fill, i)), u: 0.0, v: 0.0 });
            }
            let clipped = sutherland_hodgman(&poly, clip);
            if clipped.len() < 3 {
                return;
            }
            for i in 1..clipped.len() - 1 {
                emit_tri(dl, &clipped[0], &clipped[i], &clipped[i + 1], clip, self.screen);
            }
        }
    }

    /// DevTools highlight overlay (docs/DEVTOOLS.md): translucent fill + 2 px
    /// edges over the inspected node's world AABB. Appended after the whole
    /// walk, so it renders on top and outside any scissor.
    fn emit_highlight(&self, dl: &mut DrawList, c: &Clip) {
        let vp = Clip::viewport(self.screen);
        const FILL: u32 = 0x4DF5B04B; // #4bb0f5 at ~30% alpha (ABGR)
        const EDGE: u32 = 0xFFF5B04B; // #4bb0f5 solid
        const T: f32 = 2.0;
        self.emit_screen_rect(dl, c.x0, c.y0, c.x1, c.y1, Fill::Flat(FILL), &vp);
        self.emit_screen_rect(dl, c.x0 - T, c.y0 - T, c.x1 + T, c.y0, Fill::Flat(EDGE), &vp);
        self.emit_screen_rect(dl, c.x0 - T, c.y1, c.x1 + T, c.y1 + T, Fill::Flat(EDGE), &vp);
        self.emit_screen_rect(dl, c.x0 - T, c.y0, c.x0, c.y1, Fill::Flat(EDGE), &vp);
        self.emit_screen_rect(dl, c.x1, c.y0, c.x1 + T, c.y1, Fill::Flat(EDGE), &vp);
    }

    /// Screen-space flat/grad rect helper (already-transformed coords).
    #[allow(clippy::too_many_arguments)]
    fn emit_screen_rect(&self, dl: &mut DrawList, x0: f32, y0: f32, x1: f32, y1: f32, fill: Fill, clip: &Clip) {
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        self.emit_box(dl, &Affine::IDENTITY, x0, y0, x1, y1, fill, clip);
    }

    /// One rounded-corner sprite: an r x r quadrant of the baked disc,
    /// clipped, with UVs re-interpolated over the visible part.
    #[allow(clippy::too_many_arguments)]
    fn emit_corner_quad(
        &self,
        dl: &mut DrawList,
        tex: u32,
        x: f32,
        y: f32,
        r: f32,
        u0: f32,
        v0: f32,
        du: f32,
        color: u32,
        clip: &Clip,
    ) {
        let c = Clip {
            x0: x.max(clip.x0),
            y0: y.max(clip.y0),
            x1: (x + r).min(clip.x1),
            y1: (y + r).min(clip.y1),
        };
        if c.is_empty() || roundf(c.x1 - c.x0) <= 0.0 || roundf(c.y1 - c.y0) <= 0.0 {
            return;
        }
        let cu0 = u0 + (c.x0 - x) / r * du;
        let cu1 = u0 + (c.x1 - x) / r * du;
        let cv0 = v0 + (c.y0 - y) / r * du;
        let cv1 = v0 + (c.y1 - y) / r * du;
        dl.words.push(spec::draw_op::TEX_QUAD);
        dl.words.push(tex);
        dl.words.push(xy_word(c.x0, c.y0));
        dl.words.push(wh_word(c.x1 - c.x0, c.y1 - c.y0));
        dl.words.push(cu0.to_bits());
        dl.words.push(cv0.to_bits());
        dl.words.push(cu1.to_bits());
        dl.words.push(cv1.to_bits());
        dl.words.push(color);
    }

    fn rounded_interval_at_row(
        &self,
        sx0: f32,
        sy0: f32,
        sx1: f32,
        sy1: f32,
        radius: f32,
        row_y: f32,
    ) -> Option<(f32, f32)> {
        if sx1 <= sx0 || sy1 <= sy0 || row_y < sy0 || row_y > sy1 {
            return None;
        }
        let w = sx1 - sx0;
        let h = sy1 - sy0;
        let r = radius.min(w * 0.5).min(h * 0.5);
        if r <= 0.5 {
            return Some((sx0, sx1));
        }
        let rr = r * r;
        let inset = if row_y < sy0 + r {
            let dy = sy0 + r - row_y;
            r - sqrtf((rr - dy * dy).max(0.0))
        } else if row_y > sy1 - r {
            let dy = row_y - (sy1 - r);
            r - sqrtf((rr - dy * dy).max(0.0))
        } else {
            0.0
        };
        Some((sx0 + inset, sx1 - inset))
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_fractional_span(
        &self,
        dl: &mut DrawList,
        fill: &Fill,
        sx0: f32,
        sy0: f32,
        sx1: f32,
        sy1: f32,
        py: i32,
        h: i32,
        span_x0: f32,
        span_x1: f32,
        clip_x0: i32,
        clip_x1: i32,
        y_coverage: u32,
    ) {
        if y_coverage == 0 || span_x1 <= span_x0 {
            return;
        }
        let span_x0 = span_x0.max(clip_x0 as f32);
        let span_x1 = span_x1.min(clip_x1 as f32);
        if span_x1 <= span_x0 {
            return;
        }

        let left_edge = floorf(span_x0) as i32;
        let full_start = ceilf(span_x0) as i32;
        let full_end = floorf(span_x1) as i32;
        let right_edge = ceilf(span_x1) as i32;

        let mut emitted_left_edge = false;
        if left_edge < full_start && left_edge >= clip_x0 && left_edge < clip_x1 {
            let x_coverage = pixel_interval_coverage(left_edge, span_x0, span_x1);
            self.emit_rounded_span(
                dl,
                fill,
                sx0,
                sy0,
                sx1,
                sy1,
                py,
                h,
                left_edge,
                left_edge + 1,
                coverage_mul(x_coverage, y_coverage),
            );
            emitted_left_edge = true;
        }

        self.emit_rounded_span(
            dl,
            fill,
            sx0,
            sy0,
            sx1,
            sy1,
            py,
            h,
            full_start.max(clip_x0),
            full_end.min(clip_x1),
            y_coverage,
        );

        if full_end < right_edge
            && full_end >= clip_x0
            && full_end < clip_x1
            && !(emitted_left_edge && full_end == left_edge)
        {
            let x_coverage = pixel_interval_coverage(full_end, span_x0, span_x1);
            self.emit_rounded_span(
                dl,
                fill,
                sx0,
                sy0,
                sx1,
                sy1,
                py,
                h,
                full_end,
                full_end + 1,
                coverage_mul(x_coverage, y_coverage),
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_rounded_span(
        &self,
        dl: &mut DrawList,
        fill: &Fill,
        sx0: f32,
        sy0: f32,
        sx1: f32,
        sy1: f32,
        py: i32,
        h: i32,
        x0: i32,
        x1: i32,
        coverage: u32,
    ) {
        if coverage == 0 || h <= 0 || x1 <= x0 {
            return;
        }
        let max_run = gradient_run_limit(fill);
        let mut x = x0;
        while x < x1 {
            let next = (x + max_run).min(x1);
            let color = fill_color_at(fill, sx0, sy0, sx1, sy1, x, py, next, coverage);
            if alpha(color) > 0 {
                dl.words.push(spec::draw_op::RECT);
                dl.words.push(xy_word(x as f32, py as f32));
                dl.words.push(wh_word((next - x) as f32, h as f32));
                dl.words.push(color);
            }
            x = next;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_rounded_border(
        &mut self,
        dl: &mut DrawList,
        world: &Affine,
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        radius: f32,
        border_width: f32,
        fill: Fill,
        clip: &Clip,
    ) {
        if radius <= 0.0 || border_width <= 0.0 || !world.is_axis_aligned() {
            let bwx = border_width.min((x1 - x0) * 0.5);
            let bwy = border_width.min((y1 - y0) * 0.5);
            self.emit_box(dl, world, x0, y0, x1, y0 + bwy, fill, clip);
            self.emit_box(dl, world, x0, y1 - bwy, x1, y1, fill, clip);
            self.emit_box(dl, world, x0, y0 + bwy, x0 + bwx, y1 - bwy, fill, clip);
            self.emit_box(dl, world, x1 - bwx, y0 + bwy, x1, y1 - bwy, fill, clip);
            return;
        }

        let (sx0, sy0) = world.apply(x0, y0);
        let (sx1, sy1) = world.apply(x1, y1);
        if sx1 <= sx0 || sy1 <= sy0 {
            return;
        }
        let w = sx1 - sx0;
        let h = sy1 - sy0;
        let scale_y = world.d.max(0.0);
        let bw = (border_width * scale_y).min(w * 0.5).min(h * 0.5);
        let r = (radius * scale_y).min(w * 0.5).min(h * 0.5);
        if bw <= 0.0 || r <= 0.5 {
            let local_bw = if scale_y > 0.0 { bw / scale_y } else { border_width };
            let bwx = local_bw.min((x1 - x0) * 0.5);
            let bwy = local_bw.min((y1 - y0) * 0.5);
            self.emit_box(dl, world, x0, y0, x1, y0 + bwy, fill, clip);
            self.emit_box(dl, world, x0, y1 - bwy, x1, y1, fill, clip);
            self.emit_box(dl, world, x0, y0 + bwy, x0 + bwx, y1 - bwy, fill, clip);
            self.emit_box(dl, world, x1 - bwx, y0 + bwy, x1, y1 - bwy, fill, clip);
            return;
        }

        let ix0 = floorf(sx0).max(floorf(clip.x0)).max(0.0) as i32;
        let iy0 = floorf(sy0).max(floorf(clip.y0)).max(0.0) as i32;
        let ix1 = ceilf(sx1).min(ceilf(clip.x1)).min(self.screen.0) as i32;
        let iy1 = ceilf(sy1).min(ceilf(clip.y1)).min(self.screen.1) as i32;
        if ix1 <= ix0 || iy1 <= iy0 {
            return;
        }

        let inner_sx0 = sx0 + bw;
        let inner_sy0 = sy0 + bw;
        let inner_sx1 = sx1 - bw;
        let inner_sy1 = sy1 - bw;
        let inner_r = (r - bw).max(0.0);
        let has_inner = inner_sx1 > inner_sx0 && inner_sy1 > inner_sy0;

        for py in iy0..iy1 {
            let y_coverage = pixel_interval_coverage(py, sy0, sy1);
            if y_coverage == 0 {
                continue;
            }
            let row_y = clampf(py as f32 + 0.5, sy0, sy1);
            let Some((outer_x0, outer_x1)) = self.rounded_interval_at_row(sx0, sy0, sx1, sy1, r, row_y) else {
                continue;
            };

            let inner = if has_inner && pixel_interval_coverage(py, inner_sy0, inner_sy1) > 0 {
                let inner_row_y = clampf(py as f32 + 0.5, inner_sy0, inner_sy1);
                self.rounded_interval_at_row(inner_sx0, inner_sy0, inner_sx1, inner_sy1, inner_r, inner_row_y)
            } else {
                None
            };

            if let Some((inner_x0, inner_x1)) = inner {
                self.emit_fractional_span(
                    dl,
                    &fill,
                    sx0,
                    sy0,
                    sx1,
                    sy1,
                    py,
                    1,
                    outer_x0,
                    inner_x0.min(outer_x1),
                    ix0,
                    ix1,
                    y_coverage,
                );
                self.emit_fractional_span(
                    dl,
                    &fill,
                    sx0,
                    sy0,
                    sx1,
                    sy1,
                    py,
                    1,
                    inner_x1.max(outer_x0),
                    outer_x1,
                    ix0,
                    ix1,
                    y_coverage,
                );
            } else {
                self.emit_fractional_span(
                    dl,
                    &fill,
                    sx0,
                    sy0,
                    sx1,
                    sy1,
                    py,
                    1,
                    outer_x0,
                    outer_x1,
                    ix0,
                    ix1,
                    y_coverage,
                );
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_rounded_box(
        &mut self,
        dl: &mut DrawList,
        world: &Affine,
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        radius: f32,
        fill: Fill,
        clip: &Clip,
    ) {
        if radius <= 0.0 || !world.is_axis_aligned() {
            self.emit_box(dl, world, x0, y0, x1, y1, fill, clip);
            return;
        }
        let (sx0, sy0) = world.apply(x0, y0);
        let (sx1, sy1) = world.apply(x1, y1);
        if sx1 <= sx0 || sy1 <= sy0 {
            return;
        }
        let w = sx1 - sx0;
        let h = sy1 - sy0;
        let scale_y = world.d.max(0.0);
        let r = (radius * scale_y).min(w * 0.5).min(h * 0.5);
        if r <= 0.5 {
            self.emit_box(dl, world, x0, y0, x1, y1, fill, clip);
            return;
        }
        // Flat fills: four baked-disc corner sprites + three rects — O(1)
        // ops per box instead of per-row coverage spans (the spans cost
        // ~7 ms/frame of PSP CPU on rounded-heavy screens). High-density
        // gradients use tinted mask strips below.
        if let Fill::Flat(color) = fill {
            let r_px = roundf(r).max(1.0) as u32;
            // Bake discs only for small radii: UI corner radii recur and
            // cache forever, but ANIMATED radii (a scaling rounded-full
            // splash) mint a new radius every frame — baking those spiked a
            // real-PSP frame to 118 ms and grew the texture list unboundedly.
            // Large radii take the analytic span path below instead.
            const DISC_MAX_R: u32 = 32;
            if r_px <= DISC_MAX_R {
                if let Some((tex, dim)) = disc_texture(
                    self.discs,
                    self.textures,
                    self.tex_free,
                    r_px,
                    self.raster_density,
                ) {
                    // RECT/TEX_QUAD encode integer x/y plus integer width/height.
                    // Quantize the shared outer edges once before splitting the
                    // rounded box; independently rounding each piece's start and
                    // extent leaves 1px gaps when a scale transform makes sx/sy
                    // fractional (for example scale 0.96).
                    let qx0 = roundf(sx0);
                    let qy0 = roundf(sy0);
                    let qx1 = roundf(sx1);
                    let qy1 = roundf(sy1);
                    let rf = (r_px as f32)
                        .min((qx1 - qx0) * 0.5)
                        .min((qy1 - qy0) * 0.5);
                    let du = (r_px * self.raster_density) as f32 / dim as f32;
                    // One density-scaled corner quadrant in UV space, drawn
                    // into the same logical `rf` destination geometry.
                    let corners = [
                        (qx0, qy0, 0.0, 0.0),           // TL quadrant
                        (qx1 - rf, qy0, du, 0.0),       // TR
                        (qx0, qy1 - rf, 0.0, du),       // BL
                        (qx1 - rf, qy1 - rf, du, du),   // BR
                    ];
                    for &(cx, cy, u0, v0) in corners.iter() {
                        self.emit_corner_quad(dl, tex, cx, cy, rf, u0, v0, du, color, clip);
                    }
                    let mid = Fill::Flat(color);
                    // middle band (full width) + top/bottom strips between corners
                    self.emit_screen_rect(dl, qx0, qy0 + rf, qx1, qy1 - rf, mid, clip);
                    self.emit_screen_rect(dl, qx0 + rf, qy0, qx1 - rf, qy0 + rf, mid, clip);
                    self.emit_screen_rect(dl, qx0 + rf, qy1 - rf, qx1 - rf, qy1, mid, clip);
                    return;
                }
            }
        }
        // At high raster density, logical-pixel coverage spans magnify the
        // corner staircase. Reuse the density-scaled mask, tinting strips in
        // the gradient's global coordinates. Colour animation shares the same
        // bounded radius cache; neither the wire format nor layout changes.
        let r_px = roundf(r).max(1.0) as u32;
        if self.raster_density > 1 && r_px <= 32 && matches!(fill, Fill::Grad { .. }) {
            let qx0 = roundf(sx0);
            let qy0 = roundf(sy0);
            let qx1 = roundf(sx1);
            let qy1 = roundf(sy1);
            // Integer splits avoid overlapping half-pixel strips on odd sizes.
            let rf = (r_px as f32).min(floorf((qx1 - qx0) * 0.5)).min(floorf((qy1 - qy0) * 0.5));
            if rf >= 1.0 {
                if let Some((tex, dim)) = disc_texture(self.discs, self.textures, self.tex_free, r_px, self.raster_density) {
                    let du = (r_px * self.raster_density) as f32 / dim as f32;
                    let vertical = vertical_gradient(&fill);
                    let (a0, a1) = if vertical {
                        (qy0.max(floorf(clip.y0)).max(0.0), qy1.min(ceilf(clip.y1)).min(self.screen.1))
                    } else {
                        (qx0.max(floorf(clip.x0)).max(0.0), qx1.min(ceilf(clip.x1)).min(self.screen.0))
                    };
                    // Group masks into one texture batch. The center uses
                    // clipped full-box gradients: a constant number of quads,
                    // with the same global stops as the corner strips.
                    for a in a0 as i32..a1 as i32 {
                        let strip = if vertical {
                            Clip { x0: clip.x0, y0: clip.y0.max(a as f32), x1: clip.x1, y1: clip.y1.min((a + 1) as f32) }
                        } else {
                            Clip { x0: clip.x0.max(a as f32), y0: clip.y0, x1: clip.x1.min((a + 1) as f32), y1: clip.y1 }
                        };
                        let color = fill_color_at(&fill, sx0, sy0, sx1, sy1, a, a, a + 1, 255);
                        for &(cx, cy, u, v) in &[(qx0, qy0, 0.0, 0.0), (qx1-rf, qy0, du, 0.0),
                            (qx0, qy1-rf, 0.0, du), (qx1-rf, qy1-rf, du, du)] {
                            self.emit_corner_quad(dl, tex, cx, cy, rf, u, v, du, color, &strip);
                        }
                    }
                    for &(x0, y0, x1, y1) in &[(qx0, qy0 + rf, qx1, qy1 - rf),
                        (qx0 + rf, qy0, qx1 - rf, qy0 + rf), (qx0 + rf, qy1 - rf, qx1 - rf, qy1)] {
                        let center = Clip { x0: x0.max(clip.x0), y0: y0.max(clip.y0),
                            x1: x1.min(clip.x1), y1: y1.min(clip.y1) };
                        self.emit_screen_rect(dl, sx0, sy0, sx1, sy1, fill, &center);
                    }
                    return;
                }
            }
        }
        let ix0 = floorf(sx0).max(floorf(clip.x0)).max(0.0) as i32;
        let iy0 = floorf(sy0).max(floorf(clip.y0)).max(0.0) as i32;
        let ix1 = ceilf(sx1).min(ceilf(clip.x1)).min(self.screen.0) as i32;
        let iy1 = ceilf(sy1).min(ceilf(clip.y1)).min(self.screen.1) as i32;
        if ix1 <= ix0 || iy1 <= iy0 {
            return;
        }
        let rr = r * r;
        let tall_middle = !vertical_gradient(&fill);
        let mid_y0 = if tall_middle {
            (ceilf(sy0 + r) as i32).max(iy0).min(iy1)
        } else {
            iy0
        };
        let mid_y1 = if tall_middle {
            (floorf(sy1 - r) as i32).max(iy0).min(iy1)
        } else {
            iy0
        };
        if tall_middle && mid_y1 > mid_y0 {
            let span_x0 = sx0.max(ix0 as f32);
            let span_x1 = sx1.min(ix1 as f32);
            if span_x1 > span_x0 {
                let left_edge = floorf(span_x0) as i32;
                let full_start = ceilf(span_x0) as i32;
                let full_end = floorf(span_x1) as i32;
                let right_edge = ceilf(span_x1) as i32;
                let h = mid_y1 - mid_y0;
                let mut emitted_left_edge = false;
                if left_edge < full_start && left_edge >= ix0 && left_edge < ix1 {
                    let x_coverage = pixel_interval_coverage(left_edge, span_x0, span_x1);
                    self.emit_rounded_span(
                        dl,
                        &fill,
                        sx0,
                        sy0,
                        sx1,
                        sy1,
                        mid_y0,
                        h,
                        left_edge,
                        left_edge + 1,
                        x_coverage,
                    );
                    emitted_left_edge = true;
                }
                let inner_x0 = full_start.max(ix0);
                let inner_x1 = full_end.min(ix1);
                self.emit_rounded_span(dl, &fill, sx0, sy0, sx1, sy1, mid_y0, h, inner_x0, inner_x1, 255);
                if full_end < right_edge
                    && full_end >= ix0
                    && full_end < ix1
                    && !(emitted_left_edge && full_end == left_edge)
                {
                    let x_coverage = pixel_interval_coverage(full_end, span_x0, span_x1);
                    self.emit_rounded_span(
                        dl,
                        &fill,
                        sx0,
                        sy0,
                        sx1,
                        sy1,
                        mid_y0,
                        h,
                        full_end,
                        full_end + 1,
                        x_coverage,
                    );
                }
            }
        }
        for py in iy0..iy1 {
            if tall_middle && py >= mid_y0 && py < mid_y1 {
                continue;
            }
            let y_coverage = pixel_interval_coverage(py, sy0, sy1);
            if y_coverage == 0 {
                continue;
            }

            let row_y = clampf(py as f32 + 0.5, sy0, sy1);
            let inset = if row_y < sy0 + r {
                let dy = sy0 + r - row_y;
                r - sqrtf((rr - dy * dy).max(0.0))
            } else if row_y > sy1 - r {
                let dy = row_y - (sy1 - r);
                r - sqrtf((rr - dy * dy).max(0.0))
            } else {
                0.0
            };
            let span_x0 = (sx0 + inset).max(ix0 as f32);
            let span_x1 = (sx1 - inset).min(ix1 as f32);
            if span_x1 <= span_x0 {
                continue;
            }

            let left_edge = floorf(span_x0) as i32;
            let full_start = ceilf(span_x0) as i32;
            let full_end = floorf(span_x1) as i32;
            let right_edge = ceilf(span_x1) as i32;

            let mut emitted_left_edge = false;
            if left_edge < full_start && left_edge >= ix0 && left_edge < ix1 {
                let x_coverage = pixel_interval_coverage(left_edge, span_x0, span_x1);
                self.emit_rounded_span(
                    dl,
                    &fill,
                    sx0,
                    sy0,
                    sx1,
                    sy1,
                    py,
                    1,
                    left_edge,
                    left_edge + 1,
                    coverage_mul(x_coverage, y_coverage),
                );
                emitted_left_edge = true;
            }

            let inner_x0 = full_start.max(ix0);
            let inner_x1 = full_end.min(ix1);
            self.emit_rounded_span(dl, &fill, sx0, sy0, sx1, sy1, py, 1, inner_x0, inner_x1, y_coverage);

            if full_end < right_edge && full_end >= ix0 && full_end < ix1 && !(emitted_left_edge && full_end == left_edge) {
                let x_coverage = pixel_interval_coverage(full_end, span_x0, span_x1);
                self.emit_rounded_span(
                    dl,
                    &fill,
                    sx0,
                    sy0,
                    sx1,
                    sy1,
                    py,
                    1,
                    full_end,
                    full_end + 1,
                    coverage_mul(x_coverage, y_coverage),
                );
            }
        }
    }

    fn emit_shadow(&mut self, dl: &mut DrawList, world: &Affine, w: f32, h: f32, radius: f32, level: u32, opacity: f32, clip: &Clip) {
        if !world.is_axis_aligned() {
            return;
        }
        let layers: &[(f32, f32, f32, u32)] = match level {
            1 => &[(0.0, 1.0, 0.0, 22), (0.0, 2.0, 1.0, 10)],
            2 => &[(0.0, 2.0, 1.0, 24), (0.0, 4.0, 2.0, 12), (0.0, 6.0, 3.0, 6)],
            _ => &[(0.0, 2.0, 1.0, 28), (0.0, 5.0, 3.0, 14), (0.0, 9.0, 5.0, 7)],
        };
        for &(dx, dy, spread, alpha) in layers {
            let color = scale_alpha(with_alpha_abgr(0x0000_0000, alpha), opacity);
            self.emit_rounded_box(
                dl,
                world,
                -spread + dx,
                -spread + dy,
                w + spread + dx,
                h + spread + dy,
                radius + spread,
                Fill::Flat(color),
                clip,
            );
        }
    }

    /// Emit an image TEX_QUAD (axis-aligned only; rotated images are
    /// conservatively culled — no textured-triangle op in the DrawList v1).
    #[allow(clippy::too_many_arguments)]
    fn emit_tex_quad(
        &self,
        dl: &mut DrawList,
        world: &Affine,
        w: f32,
        h: f32,
        tex: u32,
        op: f32,
        clip: &Clip,
        fu0: f32,
        fv0: f32,
        fu1: f32,
        fv1: f32,
    ) {
        if !world.is_axis_aligned() {
            // Rotated image: transform corners with their UVs, clip, fan into
            // TEX_TRIs (affine screen-space sampling).
            let corners = [
                (0.0, 0.0, fu0, fv0),
                (w, 0.0, fu1, fv0),
                (w, h, fu1, fv1),
                (0.0, h, fu0, fv1),
            ];
            let mut poly: Vec<ClipVert> = Vec::with_capacity(8);
            for &(lx, ly, u, v) in corners.iter() {
                let (sx, sy) = world.apply(lx, ly);
                poly.push(ClipVert { x: sx, y: sy, color: [255.0; 4], u, v });
            }
            let clipped = sutherland_hodgman(&poly, clip);
            let modulate = scale_alpha(0xffff_ffff, op);
            for i in 1..clipped.len().saturating_sub(1) {
                emit_tex_tri(dl, tex, modulate, &clipped[0], &clipped[i], &clipped[i + 1], clip, self.screen);
            }
            return;
        }
        let (sx0, sy0) = world.apply(0.0, 0.0);
        let (sx1, sy1) = world.apply(w, h);
        if sx1 <= sx0 || sy1 <= sy0 {
            return;
        }
        let c = Clip {
            x0: sx0.max(clip.x0),
            y0: sy0.max(clip.y0),
            x1: sx1.min(clip.x1),
            y1: sy1.min(clip.y1),
        };
        if c.is_empty() || roundf(c.x1 - c.x0) <= 0.0 || roundf(c.y1 - c.y0) <= 0.0 {
            return;
        }
        // UV re-interpolation over the clipped span, remapped into the frame's
        // atlas sub-rect [fu0,fu1] x [fv0,fv1] (the whole texture for images).
        let du = fu1 - fu0;
        let dv = fv1 - fv0;
        let u0 = fu0 + (c.x0 - sx0) / (sx1 - sx0) * du;
        let u1 = fu0 + (c.x1 - sx0) / (sx1 - sx0) * du;
        let v0 = fv0 + (c.y0 - sy0) / (sy1 - sy0) * dv;
        let v1 = fv0 + (c.y1 - sy0) / (sy1 - sy0) * dv;
        dl.words.push(spec::draw_op::TEX_QUAD);
        dl.words.push(tex);
        dl.words.push(xy_word(c.x0, c.y0));
        dl.words.push(wh_word(c.x1 - c.x0, c.y1 - c.y0));
        dl.words.push(u0.to_bits());
        dl.words.push(v0.to_bits());
        dl.words.push(u1.to_bits());
        dl.words.push(v1.to_bits());
        dl.words.push(scale_alpha(0xffff_ffff, op));
    }

    /// Emit a native-compositor surface instruction. Unlike TEX_QUAD, full
    /// and clipped geometry are explicit: clipping never shifts the child
    /// realm's coordinate origin and no UV reconstruction is involved.
    fn emit_compositor_surface(
        &self,
        dl: &mut DrawList,
        world: &Affine,
        w: f32,
        h: f32,
        surface: u32,
        focused: bool,
        clip: &Clip,
    ) {
        if !world.is_axis_aligned() || w <= 0.0 || h <= 0.0 {
            return;
        }
        let (x0, y0) = world.apply(0.0, 0.0);
        let (x1, y1) = world.apply(w, h);
        let visible = Clip {
            x0: x0.max(clip.x0),
            y0: y0.max(clip.y0),
            x1: x1.min(clip.x1),
            y1: y1.min(clip.y1),
        };
        if visible.is_empty()
            || roundf(visible.x1 - visible.x0) <= 0.0
            || roundf(visible.y1 - visible.y0) <= 0.0
        {
            return;
        }
        dl.words.push(spec::draw_op::SURFACE_QUAD);
        dl.words.push(surface);
        dl.words.push(x0.to_bits());
        dl.words.push(y0.to_bits());
        dl.words.push((x1 - x0).to_bits());
        dl.words.push((y1 - y0).to_bits());
        dl.words.push(xy_word(visible.x0, visible.y0));
        dl.words
            .push(wh_word(visible.x1 - visible.x0, visible.y1 - visible.y0));
        dl.words.push(u32::from(focused));
    }

    /// Emit the inline text run of a text element as one GLYPH_RUN.
    #[allow(clippy::too_many_arguments)]
    fn emit_text(
        &mut self,
        dl: &mut DrawList,
        node: &crate::tree::Node,
        r: &style::Resolved,
        world: &Affine,
        op: f32,
        clip: &Clip,
        box_w: f32,
        in_transform: bool,
    ) {
        let color = scale_alpha(r.text_color, op);
        if alpha(color) == 0 {
            return;
        }
        let slot = r.font_slot as u8;
        let mut run = alloc::string::String::new();
        // paint() gives us the node ref; re-walk its subtree for the run.
        // (node.children ids resolve through self.tree.)
        collect_run_of(self.tree, node, &mut run);
        if run.is_empty() {
            return;
        }
        // The node's measurement provider was RECORDED at layout time
        // (layout.rs build(): native iff a measurer is installed, tracking
        // is 0 and the subtree declared no transform). Paint follows the
        // record — a node's painted glyphs always come from the provider
        // that sized its box — but a paint-only transform (rotate/scale
        // don't relayout) can leave the record stale in either direction:
        // flag it, and Ui::draw() relayouts and REPAINTS within this same
        // draw, so the frame that leaves is provider-correct. An animation
        // crossing exact identity re-decides twice per cycle.
        let desired_native = !self.in_3d
            && self.fonts.native_active()
            && r.tracking == 0.0
            && !in_transform;
        if desired_native != node.text_native {
            self.provider_stale = true;
        }
        if node.text_native {
            self.emit_text_native(dl, run, r, world, color, clip, box_w);
            return;
        }
        let Some(atlas) = self.fonts.atlas(slot) else { return };
        let (cell_w, cell_h) = (atlas.cell_w as f32, atlas.cell_h as f32);
        let mut scratch = core::mem::take(&mut self.glyph_scratch);
        scratch.clear();
        self.fonts
            .layout_run(&run, slot, r.tracking, r.line_height, r.text_align, box_w, &mut scratch);
        let start = dl.words.len();
        dl.words.push(spec::draw_op::GLYPH_RUN);
        dl.words.push(0); // patched below: slot | count << 16
        dl.words.push(color);
        let mut n: u32 = 0;
        for g in &scratch {
            // Glyph cells stay axis-aligned; only the anchor transforms.
            let (sx, sy) = world.apply(g.x, g.y);
            let (rx, ry) = (roundf(sx), roundf(sy));
            // Coordinate-range invariant: cell top-left must sit in
            // [0,SCREEN]; cells that can't be represented are dropped, and
            // cells fully outside the clip are dropped (backend scissor
            // pixel-clips partial overlap inside overflow-hidden regions).
            if rx < 0.0 || ry < 0.0 || rx > self.screen.0 || ry > self.screen.1 {
                continue;
            }
            if rx + cell_w <= clip.x0 || rx >= clip.x1 || ry + cell_h <= clip.y0 || ry >= clip.y1 {
                continue;
            }
            if n == u16::MAX as u32 {
                break;
            }
            dl.words.push(xy_word(rx, ry));
            dl.words.push(g.gid as u32);
            n += 1;
        }
        if n == 0 {
            dl.words.truncate(start);
        } else {
            dl.words[start + 1] = (slot as u32) | (n << 16);
        }
        self.glyph_scratch = scratch;
    }

    /// Emit one TEXT_RUN (native text path; format in spec.ts): header words
    /// plus the run string's UTF-8 bytes packed into the stream — the words
    /// alone are the complete pixel truth. The origin is f32 and may sit
    /// off-viewport, so a run not fully inside the clip is bracketed in
    /// SCISSOR/SCISSOR_POP — the one place the core emits a scissor for its
    /// own op rather than for children.
    fn emit_text_native(
        &mut self,
        dl: &mut DrawList,
        run: alloc::string::String,
        r: &style::Resolved,
        world: &Affine,
        color: u32,
        clip: &Clip,
        box_w: f32,
    ) {
        let slot = r.font_slot as u8;
        // Routes to the native measurer (the recorded-provider gate holds
        // tracking at 0 on this path).
        let (mw, mh) = self.fonts.measure_run(&run, slot, r.tracking, r.line_height);
        if mw <= 0.0 || mh <= 0.0 {
            return;
        }
        let (ox, oy) = world.apply(0.0, 0.0);
        // Alignment places lines inside box_w, so box_w ∪ measured width
        // bounds every glyph the backend can paint.
        let ext_w = box_w.max(mw);
        if ox + ext_w <= clip.x0 || ox >= clip.x1 || oy + mh <= clip.y0 || oy >= clip.y1 {
            return;
        }
        let clipped =
            ox < clip.x0 || oy < clip.y0 || ox + ext_w > clip.x1 || oy + mh > clip.y1;
        if clipped {
            dl.words.push(spec::draw_op::SCISSOR);
            dl.words.push(xy_word(clip.x0, clip.y0));
            dl.words.push(wh_word(clip.x1 - clip.x0, clip.y1 - clip.y0));
        }
        let bytes = run.as_bytes();
        dl.words.push(spec::draw_op::TEXT_RUN);
        dl.words.push((slot as u32) | ((r.text_align as u32) << 8));
        dl.words.push(ox.to_bits());
        dl.words.push(oy.to_bits());
        dl.words.push(box_w.to_bits());
        dl.words.push(r.line_height.to_bits());
        dl.words.push(color);
        dl.words.push(bytes.len() as u32);
        for chunk in bytes.chunks(4) {
            let mut w = [0u8; 4];
            w[..chunk.len()].copy_from_slice(chunk);
            dl.words.push(u32::from_le_bytes(w));
        }
        if clipped {
            dl.words.push(spec::draw_op::SCISSOR_POP);
        }
    }
}

/// Concatenated inline run of a text element (own text + text-type
/// descendants through text nodes).
fn collect_run_of(tree: &Tree, node: &crate::tree::Node, out: &mut alloc::string::String) {
    out.push_str(&node.text);
    for &cid in &node.children {
        if let Some(cs) = tree.resolve(cid) {
            let child = &tree.slots[cs as usize];
            if child.node_type == spec::NodeType::Text as u8 {
                collect_run_of(tree, child, out);
            }
        }
    }
}

// ---- Sutherland-Hodgman with color interpolation -------------------------------

#[derive(Clone, Copy)]
struct ClipVert {
    x: f32,
    y: f32,
    color: [f32; 4], // r, g, b, a (ABGR channel order irrelevant: symmetric)
    /// Normalized texture coords (only meaningful on TEX_TRI paths; solid
    /// paths carry zeros).
    u: f32,
    v: f32,
}

fn unpack(c: u32) -> [f32; 4] {
    [
        (c & 0xff) as f32,
        ((c >> 8) & 0xff) as f32,
        ((c >> 16) & 0xff) as f32,
        ((c >> 24) & 0xff) as f32,
    ]
}

fn pack(c: [f32; 4]) -> u32 {
    let q = |v: f32| ((clampf(v, 0.0, 255.0) + 0.5) as u32) & 0xff;
    q(c[0]) | (q(c[1]) << 8) | (q(c[2]) << 16) | (q(c[3]) << 24)
}

fn lerp_vert(a: &ClipVert, b: &ClipVert, t: f32) -> ClipVert {
    ClipVert {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        color: [
            a.color[0] + (b.color[0] - a.color[0]) * t,
            a.color[1] + (b.color[1] - a.color[1]) * t,
            a.color[2] + (b.color[2] - a.color[2]) * t,
            a.color[3] + (b.color[3] - a.color[3]) * t,
        ],
        u: a.u + (b.u - a.u) * t,
        v: a.v + (b.v - a.v) * t,
    }
}

/// Emit one TEX_TRI op (degenerate triangles after rounding are dropped).
fn emit_tex_tri(
    dl: &mut DrawList,
    tex: u32,
    modulate: u32,
    v0: &ClipVert,
    v1: &ClipVert,
    v2: &ClipVert,
    clip: &Clip,
    screen: (f32, f32),
) {
    let px = |v: &ClipVert| {
        (
            clampf(roundf(clampf(v.x, clip.x0, clip.x1)), 0.0, screen.0),
            clampf(roundf(clampf(v.y, clip.y0, clip.y1)), 0.0, screen.1),
        )
    };
    let (x0, y0) = px(v0);
    let (x1, y1) = px(v1);
    let (x2, y2) = px(v2);
    let area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if area2 == 0.0 {
        return;
    }
    dl.words.push(spec::draw_op::TEX_TRI);
    dl.words.push(tex);
    for (xy, vert) in [((x0, y0), v0), ((x1, y1), v1), ((x2, y2), v2)] {
        dl.words.push(xy_word(xy.0, xy.1));
        dl.words.push(vert.u.to_bits());
        dl.words.push(vert.v.to_bits());
    }
    dl.words.push(modulate);
}

/// Clip a convex polygon against the 4 half-planes of `clip`, interpolating
/// vertex colors along cut edges.
fn sutherland_hodgman(poly: &[ClipVert], clip: &Clip) -> Vec<ClipVert> {
    // edge: (inside predicate, intersection parameter solve)
    // Encode each edge as (axis, bound, keep_leq): axis 0 = x, 1 = y.
    let edges: [(usize, f32, bool); 4] = [
        (0, clip.x0, false), // x >= x0
        (0, clip.x1, true),  // x <= x1
        (1, clip.y0, false), // y >= y0
        (1, clip.y1, true),  // y <= y1
    ];
    let mut cur: Vec<ClipVert> = poly.to_vec();
    for &(axis, bound, keep_leq) in &edges {
        if cur.is_empty() {
            break;
        }
        let coord = |v: &ClipVert| if axis == 0 { v.x } else { v.y };
        let inside = |v: &ClipVert| {
            if keep_leq {
                coord(v) <= bound
            } else {
                coord(v) >= bound
            }
        };
        let mut next: Vec<ClipVert> = Vec::with_capacity(cur.len() + 1);
        for i in 0..cur.len() {
            let a = cur[i];
            let b = cur[(i + 1) % cur.len()];
            let (ia, ib) = (inside(&a), inside(&b));
            if ia {
                next.push(a);
            }
            if ia != ib {
                let da = coord(&a) - bound;
                let db = coord(&b) - bound;
                let t = da / (da - db);
                next.push(lerp_vert(&a, &b, t));
            }
        }
        cur = next;
    }
    cur
}

/// Emit one TRI op (degenerate triangles after rounding are dropped).
fn emit_tri(
    dl: &mut DrawList,
    v0: &ClipVert,
    v1: &ClipVert,
    v2: &ClipVert,
    clip: &Clip,
    screen: (f32, f32),
) {
    // Round + final clamp (interpolation is exact at clip bounds but stay
    // paranoid about float dust).
    let px = |v: &ClipVert| {
        (
            clampf(roundf(clampf(v.x, clip.x0, clip.x1)), 0.0, screen.0),
            clampf(roundf(clampf(v.y, clip.y0, clip.y1)), 0.0, screen.1),
        )
    };
    let (x0, y0) = px(v0);
    let (x1, y1) = px(v1);
    let (x2, y2) = px(v2);
    // Degenerate (zero-area after rounding)?
    let area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if area2 == 0.0 {
        return;
    }
    dl.words.push(spec::draw_op::TRI);
    dl.words.push(xy_word(x0, y0));
    dl.words.push(xy_word(x1, y1));
    dl.words.push(xy_word(x2, y2));
    dl.words.push(pack(v0.color));
    dl.words.push(pack(v1.color));
    dl.words.push(pack(v2.color));
}
