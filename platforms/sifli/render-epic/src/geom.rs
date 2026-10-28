//! Integer geometry shared by the planner, the emitter, and executors.
//!
//! Logical coordinates are DrawList viewport pixels ([`Clip`], half-open,
//! signed). Physical coordinates are target pixels after the integer render
//! scale ([`Rect`], unsigned).

pub use pocket_draw_ops::logical_rect;
pub use pocket_drivers::DamageRect as Clip;
pub use pocket_raster::blend_rgb565_pixel;

/// Physical target rectangle using half-open bounds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    #[inline]
    pub const fn area(self) -> u32 {
        self.w.saturating_mul(self.h)
    }

    #[inline]
    pub const fn is_empty(self) -> bool {
        self.w == 0 || self.h == 0
    }

    /// Intersection of two physical rectangles (empty when disjoint).
    pub fn intersect(self, other: Rect) -> Rect {
        let x0 = self.x.max(other.x);
        let y0 = self.y.max(other.y);
        let x1 = (self.x + self.w).min(other.x + other.w);
        let y1 = (self.y + self.h).min(other.y + other.h);
        if x1 <= x0 || y1 <= y0 {
            return Rect::default();
        }
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    }
}

/// One physical target coordinate used by texture transforms. Signed so a
/// quad may extend beyond the target before clipping.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// Four destination points ordered TL, BL, BR, TR. They map to the four
/// edges of a source rectangle, so mirroring is expressed by point order.
pub type Quad = [Point; 4];

/// Physical rectangle covering `clip` at `scale`.
#[inline]
pub fn physical_rect(clip: Clip, scale: u32) -> Rect {
    if clip.is_empty() {
        return Rect::default();
    }
    Rect {
        x: clip.x0 as u32 * scale,
        y: clip.y0 as u32 * scale,
        w: (clip.x1 - clip.x0) as u32 * scale,
        h: (clip.y1 - clip.y0) as u32 * scale,
    }
}

/// Smallest logical rectangle whose physical pixels at `scale` cover the
/// physical rectangle `rect`.
pub fn covering_clip(rect: Rect, scale: u32) -> Clip {
    if rect.is_empty() {
        return Clip::empty();
    }
    Clip::new(
        (rect.x / scale) as i32,
        (rect.y / scale) as i32,
        (rect.x + rect.w).div_ceil(scale) as i32,
        (rect.y + rect.h).div_ceil(scale) as i32,
    )
}

/// Bounding box of four logical points.
pub fn point_bounds(points: [Point; 4]) -> Clip {
    let mut x0 = points[0].x;
    let mut y0 = points[0].y;
    let mut x1 = points[0].x;
    let mut y1 = points[0].y;
    for point in &points[1..] {
        x0 = x0.min(point.x);
        y0 = y0.min(point.y);
        x1 = x1.max(point.x);
        y1 = y1.max(point.y);
    }
    Clip { x0, y0, x1, y1 }
}

/// Unpack an XY word (two i16 halves) into logical coordinates.
#[inline]
pub fn xy(word: u32) -> (i32, i32) {
    (
        (word & 0xffff) as u16 as i16 as i32,
        (word >> 16) as u16 as i16 as i32,
    )
}

/// Unpack a WH word (two u16 halves) into a logical size.
#[inline]
pub fn wh(word: u32) -> (i32, i32) {
    ((word & 0xffff) as i32, (word >> 16) as i32)
}

/// Pack logical coordinates into an XY word.
#[inline]
pub fn pack_xy(x: i32, y: i32) -> u32 {
    x as i16 as u16 as u32 | ((y as i16 as u16 as u32) << 16)
}

/// Pack a logical size into a WH word.
#[inline]
pub fn pack_wh(w: i32, h: i32) -> u32 {
    w as u16 as u32 | ((h as u16 as u32) << 16)
}

/// Split a packed ABGR color into `(r, g, b, a)` channels.
#[inline]
pub fn channels(color: u32) -> (u32, u32, u32, u32) {
    (
        color & 0xff,
        (color >> 8) & 0xff,
        (color >> 16) & 0xff,
        color >> 24,
    )
}
