//! Recovering rectangles and quads from the triangle pairs the core emits
//! for rotated, scaled, and 2.5D boxes and images, plus the exact-texel
//! source-rectangle mapping for axis-aligned texture quads.

use pocket_drivers::TexView;

use crate::geom::{logical_rect, xy, Clip, Point, Rect};

/// One TEX_TRI vertex.
#[derive(Clone, Copy, Debug, Default)]
pub struct TextureVertex {
    pub x: i32,
    pub y: i32,
    pub u: f32,
    pub v: f32,
}

impl TextureVertex {
    fn from_words(xy_word: u32, u_word: u32, v_word: u32) -> Option<Self> {
        let (x, y) = xy(xy_word);
        let u = f32::from_bits(u_word);
        let v = f32::from_bits(v_word);
        (u.is_finite() && v.is_finite()).then_some(Self { x, y, u, v })
    }

    fn same(self, other: Self) -> bool {
        self.x == other.x
            && self.y == other.y
            && self.u.to_bits() == other.u.to_bits()
            && self.v.to_bits() == other.v.to_bits()
    }
}

/// The four distinct vertices shared by two TEX_TRI ops, or `None` when they
/// do not form one quad.
pub fn collect_texture_quad(first: &[u32], second: &[u32]) -> Option<[TextureVertex; 4]> {
    let mut vertices = [TextureVertex::default(); 4];
    let mut count = 0usize;
    for op in [first, second] {
        for offset in [2usize, 5, 8] {
            let vertex = TextureVertex::from_words(op[offset], op[offset + 1], op[offset + 2])?;
            if vertices[..count]
                .iter()
                .copied()
                .any(|existing| existing.same(vertex))
            {
                continue;
            }
            if count == vertices.len() {
                return None;
            }
            vertices[count] = vertex;
            count += 1;
        }
    }
    (count == vertices.len()).then_some(vertices)
}

/// Order four vertices as TL, BL, BR, TR of their UV rectangle and return the
/// integral source rectangle they sample.
pub fn order_texture_quad(
    view: &TexView<'_>,
    vertices: [TextureVertex; 4],
) -> Option<(Rect, [TextureVertex; 4])> {
    let mut min_u = vertices[0].u;
    let mut max_u = vertices[0].u;
    let mut min_v = vertices[0].v;
    let mut max_v = vertices[0].v;
    for vertex in &vertices[1..] {
        min_u = min_u.min(vertex.u);
        max_u = max_u.max(vertex.u);
        min_v = min_v.min(vertex.v);
        max_v = max_v.max(vertex.v);
    }
    if max_u - min_u <= 0.000_001 || max_v - min_v <= 0.000_001 {
        return None;
    }
    let find = |u: f32, v: f32| {
        vertices
            .iter()
            .copied()
            .find(|vertex| (vertex.u - u).abs() <= 0.000_001 && (vertex.v - v).abs() <= 0.000_001)
    };
    let quad = [
        find(min_u, min_v)?,
        find(min_u, max_v)?,
        find(max_u, max_v)?,
        find(max_u, min_v)?,
    ];
    let x0 = exact_texel_edge(min_u, view.w)?;
    let y0 = exact_texel_edge(min_v, view.h)?;
    let x1 = exact_texel_edge(max_u, view.w)?;
    let y1 = exact_texel_edge(max_v, view.h)?;
    (x1 > x0 && y1 > y0).then_some((
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        },
        quad,
    ))
}

/// Logical bounding box of four texture vertices.
pub fn texture_quad_bounds(vertices: [TextureVertex; 4]) -> Clip {
    let mut x0 = vertices[0].x;
    let mut y0 = vertices[0].y;
    let mut x1 = vertices[0].x;
    let mut y1 = vertices[0].y;
    for vertex in &vertices[1..] {
        x0 = x0.min(vertex.x);
        y0 = y0.min(vertex.y);
        x1 = x1.max(vertex.x);
        y1 = y1.max(vertex.y);
    }
    Clip { x0, y0, x1, y1 }
}

/// The upright rectangle a TL/BL/BR/TR quad covers, if it is one.
pub fn axis_aligned_texture_rect(quad: [Point; 4]) -> Option<Rect> {
    let [top_left, bottom_left, bottom_right, top_right] = quad;
    if top_left.x != bottom_left.x
        || top_right.x != bottom_right.x
        || top_left.y != top_right.y
        || bottom_left.y != bottom_right.y
        || top_right.x <= top_left.x
        || bottom_left.y <= top_left.y
    {
        return None;
    }
    Some(Rect {
        x: top_left.x as u32,
        y: top_left.y as u32,
        w: (top_right.x - top_left.x) as u32,
        h: (bottom_left.y - top_left.y) as u32,
    })
}

/// The convex quad shared by two flat TRI ops, ordered TL, BL, BR, TR
/// (clockwise from the top-left in screen space), or `None`.
pub fn collect_solid_quad(first: &[u32], second: &[u32]) -> Option<[Point; 4]> {
    let mut points = [Point::default(); 4];
    let mut count = 0usize;
    for op in [first, second] {
        for &word in &op[1..4] {
            let (x, y) = xy(word);
            let point = Point { x, y };
            if points[..count].contains(&point) {
                continue;
            }
            if count == points.len() {
                return None;
            }
            points[count] = point;
            count += 1;
        }
    }
    if count != points.len() {
        return None;
    }

    let center_x2: i64 = points.iter().map(|point| point.x as i64).sum();
    let center_y2: i64 = points.iter().map(|point| point.y as i64).sum();
    let before = |left: Point, right: Point| {
        let lx = left.x as i64 * 4 - center_x2;
        let ly = left.y as i64 * 4 - center_y2;
        let rx = right.x as i64 * 4 - center_x2;
        let ry = right.y as i64 * 4 - center_y2;
        let left_half = ly < 0 || (ly == 0 && lx >= 0);
        let right_half = ry < 0 || (ry == 0 && rx >= 0);
        if left_half != right_half {
            return left_half;
        }
        let cross = lx * ry - ly * rx;
        if cross != 0 {
            cross > 0
        } else {
            lx * lx + ly * ly < rx * rx + ry * ry
        }
    };
    for i in 1..points.len() {
        let mut j = i;
        while j > 0 && before(points[j], points[j - 1]) {
            points.swap(j, j - 1);
            j -= 1;
        }
    }
    let mut sign = 0i64;
    for i in 0..points.len() {
        let a = points[i];
        let b = points[(i + 1) & 3];
        let c = points[(i + 2) & 3];
        let cross =
            (b.x - a.x) as i64 * (c.y - b.y) as i64 - (b.y - a.y) as i64 * (c.x - b.x) as i64;
        if cross == 0 || (sign != 0 && cross.signum() != sign) {
            return None;
        }
        sign = cross.signum();
    }
    Some(points)
}

/// Source rectangle of an axis-aligned TEX_QUAD after clipping its
/// destination to `clipped_destination`, plus the mirror flags implied by
/// reversed UVs. `None` when an edge is not an integral texel.
pub fn texture_source_rect(
    view: &TexView<'_>,
    op: &[u32],
    clipped_destination: Clip,
) -> Option<(Rect, bool, bool)> {
    let destination = logical_rect(op[2], op[3]);
    if destination.is_empty() || clipped_destination.is_empty() {
        return None;
    }
    let u0 = f32::from_bits(op[4]);
    let v0 = f32::from_bits(op[5]);
    let u1 = f32::from_bits(op[6]);
    let v1 = f32::from_bits(op[7]);
    if !u0.is_finite() || !v0.is_finite() || !u1.is_finite() || !v1.is_finite() {
        return None;
    }
    let destination_w = (destination.x1 - destination.x0) as f32;
    let destination_h = (destination.y1 - destination.y0) as f32;
    let map_u = |x: i32| u0 + (u1 - u0) * (x - destination.x0) as f32 / destination_w;
    let map_v = |y: i32| v0 + (v1 - v0) * (y - destination.y0) as f32 / destination_h;
    let source_u0 = exact_texel_edge(map_u(clipped_destination.x0), view.w)?;
    let source_v0 = exact_texel_edge(map_v(clipped_destination.y0), view.h)?;
    let source_u1 = exact_texel_edge(map_u(clipped_destination.x1), view.w)?;
    let source_v1 = exact_texel_edge(map_v(clipped_destination.y1), view.h)?;
    let x0 = source_u0.min(source_u1);
    let y0 = source_v0.min(source_v1);
    let x1 = source_u0.max(source_u1);
    let y1 = source_v0.max(source_v1);
    (x1 > x0 && y1 > y0).then_some((
        Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        },
        source_u0 > source_u1,
        source_v0 > source_v1,
    ))
}

/// Hardware source offsets are integral texels. Refuse fractional UV edges
/// instead of expanding them and changing the sampling transform. The small
/// tolerance only absorbs normal f32 interpolation error for exact atlas
/// boundaries.
#[inline]
pub fn exact_texel_edge(uv: f32, extent: u32) -> Option<u32> {
    let value = uv * extent as f32;
    if !value.is_finite() || value < 0.0 || value > extent as f32 {
        return None;
    }
    let rounded = (value + 0.5) as u32;
    let rounded_value = rounded as f32;
    let difference = if value >= rounded_value {
        value - rounded_value
    } else {
        rounded_value - value
    };
    (rounded <= extent && difference <= 0.0001).then_some(rounded)
}
