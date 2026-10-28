//! One pass over the DrawList per frame.
//!
//! The planner decodes the DrawList once, recovers the shapes the core
//! flattened into triangles, groups alpha-only texture quads into runs, and
//! records everything the per-region emitter needs as plain integers. Region
//! clipping and hardware thresholds are applied later by [`crate::emit`], so
//! the same plan serves every damage region of a frame.

use alloc::vec::Vec;

use pocket_drivers::RenderResources;
use pocket_spec as spec;

use crate::geom::{logical_rect, point_bounds, Clip, Point, Rect};
use crate::ops::{Decoder, Op};
use crate::quad::{
    collect_solid_quad, collect_texture_quad, order_texture_quad, texture_quad_bounds,
};
use crate::textures::Textures;

/// One planned DrawList item. Rectangles are logical viewport coordinates,
/// already intersected with the scissor in effect (`clip`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlanItem {
    /// Solid rectangle.
    Rect { logical: Clip, color: u32 },
    /// Two-stop gradient; `original` is the unclipped rectangle.
    Gradient {
        at: usize,
        original: Clip,
        logical: Clip,
        from: u32,
        to: u32,
        direction: u32,
        clip: Clip,
    },
    /// Baked glyph run with non-empty coverage bounds.
    Glyphs {
        at: usize,
        len: usize,
        bounds: Clip,
        slot: u8,
        color: u32,
        clip: Clip,
    },
    /// `count` consecutive TEX_QUADs of one coverage-only texture with the
    /// same modulate word, blended as one A8 plane.
    AlphaQuads {
        at: usize,
        count: usize,
        handle: i32,
        modulate: u32,
        bounds: Clip,
        clip: Clip,
    },
    /// Axis-aligned color texture quad.
    TexQuad {
        at: usize,
        handle: i32,
        logical: Clip,
        clip: Clip,
    },
    /// Two flat triangles forming one convex quad (TL, BL, BR, TR).
    TriPair {
        at: usize,
        quad: [Point; 4],
        color: u32,
        bounds: Clip,
        axis_aligned: bool,
        clip: Clip,
    },
    /// Two textured triangles forming one quad that samples `source_rect`.
    TexTriPair {
        at: usize,
        handle: i32,
        modulate: u32,
        source_rect: Rect,
        quad: [Point; 4],
        bounds: Clip,
        clip: Clip,
    },
    /// One DrawList operation replayed by the core rasterizer.
    Cpu { at: usize, len: usize, clip: Clip },
}

/// Build the plan for `words` into `out` (cleared first). `None` means the
/// DrawList is malformed.
pub(crate) fn build(
    res: &dyn RenderResources,
    textures: &mut Textures,
    words: &[u32],
    screen: Clip,
    out: &mut Vec<PlanItem>,
) -> Option<()> {
    out.clear();
    let mut decoder = Decoder::new(words, screen);
    let mut pending: Option<Op<'_>> = None;
    loop {
        let op = match pending.take() {
            Some(op) => op,
            None => match decoder.next(res).ok()? {
                Some(op) => op,
                None => break,
            },
        };
        match op.code {
            spec::draw_op::RECT => {
                if !op.bounds.is_empty() {
                    out.push(PlanItem::Rect {
                        logical: op.bounds,
                        color: op.words[3],
                    });
                }
            }
            spec::draw_op::GRAD_RECT => {
                if !op.bounds.is_empty() {
                    out.push(PlanItem::Gradient {
                        at: op.offset,
                        original: logical_rect(op.words[1], op.words[2]),
                        logical: op.bounds,
                        from: op.words[3],
                        to: op.words[4],
                        direction: op.words[5],
                        clip: op.clip,
                    });
                }
            }
            spec::draw_op::GLYPH_RUN => {
                if !op.bounds.is_empty() {
                    out.push(PlanItem::Glyphs {
                        at: op.offset,
                        len: op.words.len(),
                        bounds: op.bounds,
                        slot: (op.words[1] & 0xff) as u8,
                        color: op.words[2],
                        clip: op.clip,
                    });
                }
            }
            spec::draw_op::TEX_QUAD => {
                if op.bounds.is_empty() {
                    continue;
                }
                let handle = op.words[1] as i32;
                if res.texture(handle).is_none() {
                    out.push(cpu(&op));
                    continue;
                }
                if !textures.coverage_only(res, handle) {
                    out.push(PlanItem::TexQuad {
                        at: op.offset,
                        handle,
                        logical: op.bounds,
                        clip: op.clip,
                    });
                    continue;
                }
                let modulate = op.words[8];
                let mut count = 1usize;
                let mut bounds = op.bounds;
                while let Some(next) = decoder.next(res).ok()? {
                    if next.code == spec::draw_op::TEX_QUAD
                        && next.words[1] as i32 == handle
                        && next.words[8] == modulate
                    {
                        bounds = bounds.union(next.bounds);
                        count += 1;
                    } else {
                        pending = Some(next);
                        break;
                    }
                }
                out.push(PlanItem::AlphaQuads {
                    at: op.offset,
                    count,
                    handle,
                    modulate,
                    bounds,
                    clip: op.clip,
                });
            }
            spec::draw_op::TRI => {
                if op.bounds.is_empty() {
                    continue;
                }
                let next = decoder.next(res).ok()?;
                if let Some(second) = next {
                    if let Some(item) = tri_pair(&op, &second) {
                        out.push(item);
                        continue;
                    }
                    pending = Some(second);
                }
                out.push(cpu(&op));
            }
            spec::draw_op::TEX_TRI => {
                if op.bounds.is_empty() {
                    continue;
                }
                let next = decoder.next(res).ok()?;
                if let Some(second) = next {
                    match tex_tri_pair(res, &op, &second) {
                        Pair::Item(item) => {
                            out.push(item);
                            continue;
                        }
                        Pair::Software => {
                            out.push(cpu(&op));
                            out.push(cpu(&second));
                            continue;
                        }
                        Pair::None => pending = Some(second),
                    }
                }
                out.push(cpu(&op));
            }
            // Scissors are folded into every op's clip; native text and
            // compositor surfaces have no pixels on this target.
            _ => {}
        }
    }
    Some(())
}

fn cpu(op: &Op<'_>) -> PlanItem {
    PlanItem::Cpu {
        at: op.offset,
        len: op.words.len(),
        clip: op.bounds,
    }
}

enum Pair {
    Item(PlanItem),
    Software,
    None,
}

fn tri_pair(first: &Op<'_>, second: &Op<'_>) -> Option<PlanItem> {
    if second.code != spec::draw_op::TRI || second.clip != first.clip {
        return None;
    }
    let a = first.words;
    let b = second.words;
    let color = a[4];
    if a[5] != color || a[6] != color || b[4] != color || b[5] != color || b[6] != color {
        return None;
    }
    let quad = collect_solid_quad(a, b)?;
    let quad_bounds = point_bounds(quad);
    let axis_aligned = quad.iter().all(|point| {
        (point.x == quad_bounds.x0 || point.x == quad_bounds.x1)
            && (point.y == quad_bounds.y0 || point.y == quad_bounds.y1)
    });
    Some(PlanItem::TriPair {
        at: first.offset,
        quad,
        color,
        bounds: quad_bounds.intersect(first.clip),
        axis_aligned,
        clip: first.clip,
    })
}

fn tex_tri_pair(res: &dyn RenderResources, first: &Op<'_>, second: &Op<'_>) -> Pair {
    if second.code != spec::draw_op::TEX_TRI || second.clip != first.clip {
        return Pair::None;
    }
    let a = first.words;
    let b = second.words;
    if a[1] != b[1] || a[11] != b[11] {
        return Pair::None;
    }
    let Some(unordered) = collect_texture_quad(a, b) else {
        return Pair::None;
    };
    let Some(view) = res.texture(a[1] as i32) else {
        return Pair::Software;
    };
    let Some((source_rect, quad)) = order_texture_quad(&view, unordered) else {
        return Pair::Software;
    };
    Pair::Item(PlanItem::TexTriPair {
        at: first.offset,
        handle: a[1] as i32,
        modulate: a[11],
        source_rect,
        quad: quad.map(|vertex| Point {
            x: vertex.x,
            y: vertex.y,
        }),
        bounds: texture_quad_bounds(quad).intersect(first.clip),
        clip: first.clip,
    })
}
