//! One DrawList walk that produces a driver's vertex stream and draw batches.
//!
//! The walk owns the order of vertices and the boundaries of batches; the
//! [`Backend`] supplies what differs between drivers: the vertex type, the
//! texture and clip keys, where solid fills sample, how image handles and
//! glyph cells resolve to textures, which decoded records draw, and the quad
//! diagonal.
//!
//! A batch is a contiguous vertex range drawn with one texture under one
//! clip. The walk binds a texture per record, flushes the pending range when
//! the texture or the clip changes, and appends ranges through
//! [`append_batch`], so adjacent records with equal keys merge and no range
//! is reordered.
//!
//! Solid fills sample a [`Fill`]: a texture and the UV endpoints of every
//! fill quad drawn with it. The walk re-derives the fill from the backend
//! when the bound texture differs from the fill's texture, so a backend can
//! keep a batch open by sampling an opaque patch of the bound image.

use crate::record::SurfaceQuad;
use crate::{append_batch, quad, triangle, Batch, DrawOps, Record, Vertex};
use alloc::vec::Vec;
use pocket_drivers::{DamageRect, RenderError};

/// The texture bound to solid fills and the UV endpoints of each fill quad.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fill<T> {
    pub texture: T,
    pub uv0: [f32; 2],
    pub uv1: [f32; 2],
}

impl<T> Fill<T> {
    /// A fill sampling one point of `texture`.
    pub const fn point(texture: T, uv: [f32; 2]) -> Self {
        Self {
            texture,
            uv0: uv,
            uv1: uv,
        }
    }
}

/// One glyph cell resolved by the backend: its page texture, the cell's UV
/// rectangle as `[u0, v0, u1, v1]`, the cell's logical size, and data the
/// backend receives again in [`Backend::emitted`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphCell<T, D> {
    pub texture: T,
    pub uv: [f32; 4],
    pub width: f32,
    pub height: f32,
    pub data: D,
}

/// What a run of emitted vertices draws.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Source<D> {
    /// A solid or gradient rectangle, or an untextured triangle.
    Fill,
    /// An image quad or an image triangle.
    Image,
    /// One glyph cell, with the data its [`GlyphCell`] carried.
    Glyph(D),
    /// A surface quad appended by [`Backend::surface_quad`].
    Surface,
}

/// Driver policies for the walk. Every method runs in record order.
pub trait Backend {
    type Vertex: Vertex;
    type Texture: Copy + PartialEq;
    type Clip: Copy + PartialEq;
    type GlyphData: Copy;

    /// The fill bound when a frame starts. Untextured triangles bind its
    /// texture.
    fn start(&self) -> Fill<Self::Texture>;
    /// The batch key of a logical clip rectangle.
    fn clip(&self, clip: DamageRect) -> Self::Clip;
    /// The fill while `texture` is bound. Called when the bound texture
    /// differs from the current fill's texture.
    fn fill(&mut self, texture: Self::Texture) -> Fill<Self::Texture>;
    /// The texture of image `handle`; `None` skips the record.
    fn image(&mut self, handle: i32) -> Result<Option<Self::Texture>, RenderError>;
    /// The cell of glyph `gid` in font `slot`; `None` skips the glyph.
    #[allow(clippy::type_complexity)]
    fn glyph(
        &mut self,
        slot: u8,
        gid: u16,
    ) -> Result<Option<GlyphCell<Self::Texture, Self::GlyphData>>, RenderError>;
    /// Whether a decoded record draws. The record's texture is bound when the
    /// walk asks. The default draws every record.
    fn accepts(&mut self, record: &Record<'_>) -> Result<bool, RenderError> {
        let _ = record;
        Ok(true)
    }
    /// The six vertices of an axis-aligned quad. The default is [`quad`].
    fn quad(
        &self,
        top_left: [f32; 2],
        bottom_right: [f32; 2],
        uv0: [f32; 2],
        uv1: [f32; 2],
        colors: [u32; 4],
    ) -> [Self::Vertex; 6] {
        quad(top_left, bottom_right, uv0, uv1, colors)
    }
    /// Runs after each primitive's vertices are appended.
    fn emitted(&mut self, vertices: &mut [Self::Vertex], source: Source<Self::GlyphData>) {
        let _ = (vertices, source);
    }
    /// A surface record under `clip`. The default appends nothing: an external
    /// compositor owns the surface.
    fn surface_quad(
        &mut self,
        emit: &mut Emit<'_, Self::Vertex, Self::Texture, Self::Clip>,
        surface: &SurfaceQuad,
        clip: DamageRect,
    ) -> Result<(), RenderError> {
        let _ = (emit, surface, clip);
        Ok(())
    }
}

/// The vertex stream and batches under construction.
pub struct Emit<'a, V, T, C> {
    vertices: &'a mut Vec<V>,
    batches: &'a mut Vec<Batch<T, C>>,
    texture: T,
    clip: C,
    start: usize,
}

impl<V: Copy, T: Copy + PartialEq, C: Copy + PartialEq> Emit<'_, V, T, C> {
    fn flush(&mut self) {
        let end = self.vertices.len();
        if end > self.start {
            append_batch(self.batches, self.texture, self.clip, self.start..end);
            self.start = end;
        }
    }

    fn bind(&mut self, texture: T) {
        if self.texture != texture {
            self.flush();
            self.texture = texture;
        }
    }

    fn set_clip(&mut self, clip: C) {
        if self.clip != clip {
            self.flush();
            self.clip = clip;
        }
    }

    fn push(&mut self, vertices: &[V]) -> &mut [V] {
        let at = self.vertices.len();
        self.vertices.extend_from_slice(vertices);
        &mut self.vertices[at..]
    }

    /// Append `vertices` as their own range under `texture` and `clip`, after
    /// the pending range. The bound texture and clip do not change.
    pub fn detached(&mut self, texture: T, clip: C, vertices: &[V]) -> &mut [V] {
        self.flush();
        let at = self.vertices.len();
        self.vertices.extend_from_slice(vertices);
        append_batch(self.batches, texture, clip, at..self.vertices.len());
        self.start = self.vertices.len();
        &mut self.vertices[at..]
    }
}

/// Walk `words` under `viewport` into `vertices` and `batches`, clearing both
/// first. A record the decoder rejects is an invalid frame; a text run is
/// unsupported.
pub fn build<B: Backend>(
    backend: &mut B,
    words: &[u32],
    viewport: DamageRect,
    vertices: &mut Vec<B::Vertex>,
    batches: &mut Vec<Batch<B::Texture, B::Clip>>,
) -> Result<(), RenderError> {
    vertices.clear();
    batches.clear();
    let mut fill = backend.start();
    let white = fill.texture;
    let mut emit = Emit {
        vertices,
        batches,
        texture: white,
        clip: backend.clip(viewport),
        start: 0,
    };
    for operation in DrawOps::new(words, viewport) {
        let operation = operation.map_err(|_| RenderError::InvalidFrame)?;
        emit.set_clip(backend.clip(operation.clip));
        let record = operation.record().map_err(|_| RenderError::InvalidFrame)?;
        match record {
            Record::Scissor(_) | Record::ScissorPop => {}
            Record::Rect(rect) => {
                if fill.texture != emit.texture {
                    fill = backend.fill(emit.texture);
                }
                emit.bind(fill.texture);
                if backend.accepts(&record)? {
                    let (x, y) = (rect.x as f32, rect.y as f32);
                    let corners = backend.quad(
                        [x, y],
                        [x + rect.width as f32, y + rect.height as f32],
                        fill.uv0,
                        fill.uv1,
                        [rect.color; 4],
                    );
                    backend.emitted(emit.push(&corners), Source::Fill);
                }
            }
            Record::GradRect(gradient) => {
                if fill.texture != emit.texture {
                    fill = backend.fill(emit.texture);
                }
                emit.bind(fill.texture);
                if backend.accepts(&record)? {
                    let (x, y) = (gradient.x as f32, gradient.y as f32);
                    let corners = backend.quad(
                        [x, y],
                        [x + gradient.width as f32, y + gradient.height as f32],
                        fill.uv0,
                        fill.uv1,
                        gradient.corners().clockwise(),
                    );
                    backend.emitted(emit.push(&corners), Source::Fill);
                }
            }
            Record::GlyphRun(run) => {
                for glyph in run.glyphs() {
                    let Some(cell) = backend.glyph(run.slot, glyph.gid)? else {
                        continue;
                    };
                    emit.bind(cell.texture);
                    let (x, y) = (glyph.x as f32, glyph.y as f32);
                    let corners = backend.quad(
                        [x, y],
                        [x + cell.width, y + cell.height],
                        [cell.uv[0], cell.uv[1]],
                        [cell.uv[2], cell.uv[3]],
                        [run.color; 4],
                    );
                    backend.emitted(emit.push(&corners), Source::Glyph(cell.data));
                }
            }
            Record::TexQuad(image) => {
                let Some(texture) = backend.image(image.texture)? else {
                    continue;
                };
                emit.bind(texture);
                if backend.accepts(&record)? {
                    let (x, y) = (image.x as f32, image.y as f32);
                    let corners = backend.quad(
                        [x, y],
                        [x + image.width as f32, y + image.height as f32],
                        image.uv0,
                        image.uv1,
                        [image.color; 4],
                    );
                    backend.emitted(emit.push(&corners), Source::Image);
                }
            }
            Record::TexTri(image) => {
                let Some(texture) = backend.image(image.texture)? else {
                    continue;
                };
                emit.bind(texture);
                if backend.accepts(&record)? {
                    let positions = image.positions.map(|[x, y]| [x as f32, y as f32]);
                    let corners = triangle(positions, image.uvs, [image.color; 3]);
                    backend.emitted(emit.push(&corners), Source::Image);
                }
            }
            Record::Tri(solid) => {
                emit.bind(white);
                if backend.accepts(&record)? {
                    let positions = solid.positions.map(|[x, y]| [x as f32, y as f32]);
                    let corners = triangle(positions, [[0.0; 2]; 3], solid.colors);
                    backend.emitted(emit.push(&corners), Source::Fill);
                }
            }
            Record::SurfaceQuad(surface) => {
                backend.surface_quad(&mut emit, &surface, operation.clip)?;
            }
            Record::TextRun(_) => return Err(RenderError::Unsupported),
        }
    }
    emit.flush();
    Ok(())
}
