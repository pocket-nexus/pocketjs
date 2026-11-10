//! The fields of one DrawList record.
//!
//! A record's words are fixed by the DrawList version: XY words pack two
//! signed 16-bit coordinates, WH words two unsigned 16-bit extents, colors
//! are `0xAABBGGRR`, and texture coordinates are IEEE-754 bits. Decoding here
//! reads those fields once; consumers convert to their own numeric types.

use crate::{wh, word_len, xy, DecodeError, Operation};
use pocket_drivers::DamageRect;
use pocket_spec::{draw_op, text_run, GradDir};

/// A solid rectangle in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub color: u32,
}

impl Rect {
    pub fn bounds(&self) -> DamageRect {
        DamageRect::new(self.x, self.y, self.x + self.width, self.y + self.height)
    }
}

/// A two-color gradient over a rectangle. `direction` is a `GradDir` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GradRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub from: u32,
    pub to: u32,
    pub direction: u32,
}

impl GradRect {
    pub fn bounds(&self) -> DamageRect {
        DamageRect::new(self.x, self.y, self.x + self.width, self.y + self.height)
    }

    /// The corner colors of this gradient.
    pub fn corners(&self) -> Corners {
        gradient_corners(self.from, self.to, self.direction)
    }
}

/// Corner colors of a gradient rectangle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Corners {
    pub top_left: u32,
    pub top_right: u32,
    pub bottom_right: u32,
    pub bottom_left: u32,
}

impl Corners {
    /// Corner colors clockwise from the top left: the order `quad` takes.
    pub fn clockwise(self) -> [u32; 4] {
        [
            self.top_left,
            self.top_right,
            self.bottom_right,
            self.bottom_left,
        ]
    }
}

/// Corner colors for a gradient: `from` sits at the axis start for
/// `ToBottom` and `ToRight` and at the axis end for `ToTop` and `ToLeft`.
/// A direction outside `GradDir` paints as `ToBottom`.
pub fn gradient_corners(from: u32, to: u32, direction: u32) -> Corners {
    if direction == GradDir::ToTop as u32 {
        Corners {
            top_left: to,
            top_right: to,
            bottom_right: from,
            bottom_left: from,
        }
    } else if direction == GradDir::ToLeft as u32 {
        Corners {
            top_left: to,
            top_right: from,
            bottom_right: from,
            bottom_left: to,
        }
    } else if direction == GradDir::ToRight as u32 {
        Corners {
            top_left: from,
            top_right: to,
            bottom_right: to,
            bottom_left: from,
        }
    } else {
        Corners {
            top_left: from,
            top_right: from,
            bottom_right: to,
            bottom_left: to,
        }
    }
}

/// One glyph cell of a `GlyphRun`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Glyph {
    pub x: i32,
    pub y: i32,
    pub gid: u16,
}

/// Glyph cells drawn from one font slot in one color.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GlyphRun<'a> {
    pub slot: u8,
    pub color: u32,
    cells: &'a [u32],
}

impl<'a> GlyphRun<'a> {
    pub fn len(&self) -> usize {
        self.cells.len() / 2
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// The `xy, gid` word pairs as the record stores them.
    pub fn cell_words(&self) -> &'a [u32] {
        self.cells
    }

    pub fn glyphs(&self) -> impl Iterator<Item = Glyph> + 'a {
        self.cells.as_chunks::<2>().0.iter().map(|cell| {
            let (x, y) = xy(cell[0]);
            Glyph {
                x,
                y,
                gid: (cell[1] & 0xffff) as u16,
            }
        })
    }
}

/// A textured, axis-aligned quad. `uv0` is the top-left and `uv1` the
/// bottom-right texture coordinate; a reversed pair mirrors the image.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TexQuad {
    pub texture: i32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub uv0: [f32; 2],
    pub uv1: [f32; 2],
    pub color: u32,
}

impl TexQuad {
    pub fn bounds(&self) -> DamageRect {
        DamageRect::new(self.x, self.y, self.x + self.width, self.y + self.height)
    }
}

/// An absolute clip rectangle pushed by the producer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scissor {
    pub rect: DamageRect,
}

/// A screen-space triangle with one color per vertex.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tri {
    pub positions: [[i32; 2]; 3],
    pub colors: [u32; 3],
}

/// A textured screen-space triangle with one modulating color.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TexTri {
    pub texture: i32,
    pub positions: [[i32; 2]; 3],
    pub uvs: [[f32; 2]; 3],
    pub color: u32,
}

/// A run of text measured and painted by the host's text provider.
///
/// Box-local coordinates have their origin at the text box's top-left;
/// [`TextRun::to_screen`] maps them through the run's transform.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextRun<'a> {
    pub slot: u8,
    /// `TextAlign` ordinal: where each line sits inside `box_width`.
    pub align: u8,
    /// The box's top-left in logical screen pixels.
    pub origin: [f32; 2],
    /// The node's rounded layout width: the width alignment places lines
    /// in. It can be smaller than the width the measurer returned, so it is
    /// not a wrap width.
    pub box_width: f32,
    /// Line advance in logical pixels; NaN is the slot's default.
    pub line_height: f32,
    pub color: u32,
    /// Pixels added after every character, the last one included (the
    /// value the measurer received; finite).
    pub tracking: f32,
    /// The linear part `[a, b, c, d]` of the run's transform: box-local
    /// `(x, y)` lands at `origin + (a*x + c*y, b*x + d*y)`. The core
    /// emits no run whose `a*d - b*c` is 0.
    pub transform: [f32; 4],
    /// The provider generation the run was measured under: a counter per
    /// `Ui`, advanced when the host installs a measurer or reports a new
    /// font.
    pub generation: u32,
    /// UTF-8 byte count of the run string.
    pub bytes: usize,
    payload: &'a [u32],
}

impl<'a> TextRun<'a> {
    /// The run string's bytes packed little-endian, zero-padded to words.
    pub fn payload_words(&self) -> &'a [u32] {
        self.payload
    }

    /// Copy the run string into `buffer` and borrow it; None when the bytes
    /// are not UTF-8.
    pub fn text<'b>(&self, buffer: &'b mut alloc::vec::Vec<u8>) -> Option<&'b str> {
        buffer.clear();
        for word in self.payload {
            buffer.extend_from_slice(&word.to_le_bytes());
        }
        buffer.truncate(self.bytes);
        core::str::from_utf8(buffer).ok()
    }

    /// The screen position of the box-local point `[x, y]`.
    pub fn to_screen(&self, [x, y]: [f32; 2]) -> [f32; 2] {
        let [a, b, c, d] = self.transform;
        [
            self.origin[0] + a * x + c * y,
            self.origin[1] + b * x + d * y,
        ]
    }
}

/// A native compositor surface placed in shell painter order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceQuad {
    pub surface: u32,
    /// The surface node's unclipped logical bounds.
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// The visible integer destination after every enclosing clip.
    pub clip_x: i32,
    pub clip_y: i32,
    pub clip_width: i32,
    pub clip_height: i32,
    pub flags: u32,
}

impl SurfaceQuad {
    pub fn clip(&self) -> DamageRect {
        DamageRect::new(
            self.clip_x,
            self.clip_y,
            self.clip_x + self.clip_width,
            self.clip_y + self.clip_height,
        )
    }

    pub fn focused(&self) -> bool {
        self.flags & 1 != 0
    }
}

/// The decoded fields of one record.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Record<'a> {
    Rect(Rect),
    GradRect(GradRect),
    GlyphRun(GlyphRun<'a>),
    TexQuad(TexQuad),
    Scissor(Scissor),
    ScissorPop,
    Tri(Tri),
    TexTri(TexTri),
    TextRun(TextRun<'a>),
    SurfaceQuad(SurfaceQuad),
}

fn point(word: u32) -> [i32; 2] {
    let (x, y) = xy(word);
    [x, y]
}

/// Decode the complete record at the start of `words`. Trailing words after
/// the record are not read.
pub fn record(words: &[u32]) -> Result<Record<'_>, DecodeError> {
    let len = word_len(words, 0)?;
    let words = &words[..len];
    Ok(match words[0] {
        draw_op::RECT => {
            let (x, y) = xy(words[1]);
            let (width, height) = wh(words[2]);
            Record::Rect(Rect {
                x,
                y,
                width,
                height,
                color: words[3],
            })
        }
        draw_op::GRAD_RECT => {
            let (x, y) = xy(words[1]);
            let (width, height) = wh(words[2]);
            Record::GradRect(GradRect {
                x,
                y,
                width,
                height,
                from: words[3],
                to: words[4],
                direction: words[5],
            })
        }
        draw_op::GLYPH_RUN => Record::GlyphRun(GlyphRun {
            slot: (words[1] & 0xff) as u8,
            color: words[2],
            cells: &words[3..],
        }),
        draw_op::TEX_QUAD => {
            let (x, y) = xy(words[2]);
            let (width, height) = wh(words[3]);
            Record::TexQuad(TexQuad {
                texture: words[1] as i32,
                x,
                y,
                width,
                height,
                uv0: [f32::from_bits(words[4]), f32::from_bits(words[5])],
                uv1: [f32::from_bits(words[6]), f32::from_bits(words[7])],
                color: words[8],
            })
        }
        draw_op::SCISSOR => Record::Scissor(Scissor {
            rect: crate::logical_rect(words[1], words[2]),
        }),
        draw_op::SCISSOR_POP => Record::ScissorPop,
        draw_op::TRI => Record::Tri(Tri {
            positions: [point(words[1]), point(words[2]), point(words[3])],
            colors: [words[4], words[5], words[6]],
        }),
        draw_op::TEX_TRI => Record::TexTri(TexTri {
            texture: words[1] as i32,
            positions: core::array::from_fn(|vertex| point(words[2 + vertex * 3])),
            uvs: core::array::from_fn(|vertex| {
                [
                    f32::from_bits(words[3 + vertex * 3]),
                    f32::from_bits(words[4 + vertex * 3]),
                ]
            }),
            color: words[11],
        }),
        draw_op::TEXT_RUN => {
            let float = |at: usize| f32::from_bits(words[at]);
            Record::TextRun(TextRun {
                slot: (words[text_run::SLOT_ALIGN] & 0xff) as u8,
                align: ((words[text_run::SLOT_ALIGN] >> 8) & 0xff) as u8,
                origin: [float(text_run::ORIGIN_X), float(text_run::ORIGIN_Y)],
                box_width: float(text_run::BOX_WIDTH),
                line_height: float(text_run::LINE_HEIGHT),
                color: words[text_run::COLOR],
                tracking: float(text_run::TRACKING),
                transform: [
                    float(text_run::A),
                    float(text_run::B),
                    float(text_run::C),
                    float(text_run::D),
                ],
                generation: words[text_run::GENERATION],
                bytes: words[text_run::BYTE_LENGTH] as usize,
                payload: &words[text_run::HEADER_WORDS..],
            })
        }
        draw_op::SURFACE_QUAD => {
            let (clip_x, clip_y) = xy(words[6]);
            let (clip_width, clip_height) = wh(words[7]);
            Record::SurfaceQuad(SurfaceQuad {
                surface: words[1],
                x: f32::from_bits(words[2]),
                y: f32::from_bits(words[3]),
                width: f32::from_bits(words[4]),
                height: f32::from_bits(words[5]),
                clip_x,
                clip_y,
                clip_width,
                clip_height,
                flags: words[8],
            })
        }
        _ => return Err(DecodeError::UnknownOperation),
    })
}

impl<'a> Operation<'a> {
    /// The fields of this record.
    pub fn record(&self) -> Result<Record<'a>, DecodeError> {
        record(self.words)
    }
}
