//! DrawList records with their word offset and conservative logical bounds.
//!
//! [`pocket_draw_ops::DrawOps`] tracks the scissor stack; this wrapper skips
//! the scissor records and adds what the planner needs to clip each drawing
//! operation against a damage region without decoding it again.

use pocket_draw_ops::DrawOps;
use pocket_drivers::RenderResources;
use pocket_spec::draw_op;

use crate::geom::{logical_rect, xy, Clip};

/// One drawing operation of the DrawList.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Op<'a> {
    pub code: u32,
    /// Word index of the header inside the DrawList.
    pub offset: usize,
    pub words: &'a [u32],
    /// Logical bounds under the scissor in effect.
    pub bounds: Clip,
    /// Scissor in effect while this operation draws.
    pub clip: Clip,
}

pub(crate) struct Decoder<'a> {
    ops: DrawOps<'a>,
}

impl<'a> Decoder<'a> {
    pub fn new(words: &'a [u32], screen: Clip) -> Self {
        Self {
            ops: DrawOps::new(words, screen),
        }
    }

    /// The next drawing operation; `Ok(None)` after the last one. Errors
    /// cover unknown operations, truncation, and unbalanced scissors.
    pub fn next(&mut self, res: &dyn RenderResources) -> Result<Option<Op<'a>>, ()> {
        loop {
            let offset = self.ops.position();
            let Some(operation) = self.ops.next() else {
                return Ok(None);
            };
            let operation = operation.map_err(|_| ())?;
            let words = operation.words;
            let clip = operation.clip;
            let bounds = match operation.opcode {
                draw_op::SCISSOR | draw_op::SCISSOR_POP => continue,
                draw_op::RECT | draw_op::GRAD_RECT => {
                    logical_rect(words[1], words[2]).intersect(clip)
                }
                draw_op::GLYPH_RUN => glyph_run_bounds(res, words, clip),
                draw_op::TEX_QUAD => logical_rect(words[2], words[3]).intersect(clip),
                draw_op::TRI => triangle_bounds([words[1], words[2], words[3]], clip),
                draw_op::TEX_TRI => triangle_bounds([words[2], words[5], words[8]], clip),
                // Native text and compositor surfaces have no pixels on this
                // target; their clip is a conservative bound.
                _ => clip,
            };
            return Ok(Some(Op {
                code: operation.opcode,
                offset,
                words,
                bounds,
                clip,
            }));
        }
    }
}

/// Union of every glyph cell in a GLYPH_RUN, clipped; empty when the run's
/// color has zero alpha or the font slot is unloaded.
fn glyph_run_bounds(res: &dyn RenderResources, words: &[u32], clip: Clip) -> Clip {
    if words[2] >> 24 == 0 {
        return Clip::empty();
    }
    let Some(atlas) = res.font_atlas((words[1] & 0xff) as u8) else {
        return Clip::empty();
    };
    let mut bounds = Clip::empty();
    for glyph in words[3..].as_chunks::<2>().0 {
        if (glyph[1] & 0xffff) as u16 >= atlas.glyph_count {
            continue;
        }
        let (x, y) = xy(glyph[0]);
        bounds = bounds.union(Clip::new(
            x,
            y,
            x + atlas.cell_w as i32,
            y + atlas.cell_h as i32,
        ));
    }
    bounds.intersect(clip)
}

fn triangle_bounds(vertices: [u32; 3], clip: Clip) -> Clip {
    let [(x0, y0), (x1, y1), (x2, y2)] = vertices.map(xy);
    Clip::new(
        x0.min(x1).min(x2),
        y0.min(y1).min(y2),
        x0.max(x1).max(x2),
        y0.max(y1).max(y2),
    )
    .intersect(clip)
}
