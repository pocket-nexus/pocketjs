//! GXM policies for the shared DrawList walk.
use super::*;
use pocket_render::{triangle, Backend, Fill, GlyphCell, Record};

/// The textures `prepare` resolved for one frame, read by the walk.
struct Tables<'a> {
    images: &'a [ImageTexture],
    fonts: &'a [Option<FontTexture>],
    white: u32,
}

impl Backend for Tables<'_> {
    type Vertex = Vertex;
    type Texture = u32;
    type Clip = Clip;
    type GlyphData = ();

    /// Texture zero is untextured vertex color; the device ignores its UVs.
    /// The frame's first fills sample `(0.5, 0.5)` and later fills `(0, 0)`,
    /// as the former per-driver walk emitted them.
    fn start(&self) -> Fill<u32> {
        Fill::point(self.white, [0.5, 0.5])
    }

    fn clip(&self, clip: DamageRect) -> Clip {
        Clip {
            x: clip.x0,
            y: clip.y0,
            w: clip.x1 - clip.x0,
            h: clip.y1 - clip.y0,
        }
    }

    fn fill(&mut self, _texture: u32) -> Fill<u32> {
        Fill::point(self.white, [0.0, 0.0])
    }

    fn image(&mut self, handle: i32) -> Result<Option<u32>, RenderError> {
        if handle < 0 {
            return Ok(None);
        }
        Ok(self
            .images
            .iter()
            .find(|image| image.handle == handle)
            .map(|image| image.name))
    }

    fn glyph(&mut self, slot: u8, gid: u16) -> Result<Option<GlyphCell<u32, ()>>, RenderError> {
        let Some(font) = self.fonts.get(slot as usize).and_then(|font| font.as_ref()) else {
            return Ok(None);
        };
        if gid >= font.glyph_count {
            return Ok(None);
        }
        let Some(page) = font.pages.iter().find(|page| page.contains(gid)) else {
            return Ok(None);
        };
        Ok(Some(GlyphCell {
            texture: page.handle,
            uv: page.uv(gid),
            width: font.logical_w as f32,
            height: font.logical_h as f32,
            data: (),
        }))
    }

    /// Empty rectangles and fully transparent solid rectangles draw nothing.
    /// The former vita2d part-scale path skipped empty or mirrored source
    /// rectangles; that host behavior stays.
    fn accepts(&mut self, record: &Record<'_>) -> Result<bool, RenderError> {
        Ok(match record {
            Record::Rect(rect) => rect.width > 0 && rect.height > 0 && rect.color >> 24 != 0,
            Record::GradRect(gradient) => gradient.width > 0 && gradient.height > 0,
            Record::TexQuad(image) => {
                image.width > 0
                    && image.height > 0
                    && image.uv1[0] > image.uv0[0]
                    && image.uv1[1] > image.uv0[1]
            }
            _ => true,
        })
    }

    /// vita2d's triangle-strip diagonal: TL/TR/BL then BL/TR/BR, with the
    /// corner colors of those vertices.
    fn quad(
        &self,
        top_left: [f32; 2],
        bottom_right: [f32; 2],
        uv0: [f32; 2],
        uv1: [f32; 2],
        colors: [u32; 4],
    ) -> [Vertex; 6] {
        let [x0, y0] = top_left;
        let [x1, y1] = bottom_right;
        let [u0, v0] = uv0;
        let [u1, v1] = uv1;
        let [a, b, c]: [Vertex; 3] = triangle(
            [[x0, y0], [x1, y0], [x0, y1]],
            [[u0, v0], [u1, v0], [u0, v1]],
            [colors[0], colors[1], colors[3]],
        );
        let [d, e, f]: [Vertex; 3] = triangle(
            [[x0, y1], [x1, y0], [x1, y1]],
            [[u0, v1], [u1, v0], [u1, v1]],
            [colors[3], colors[1], colors[2]],
        );
        [a, b, c, d, e, f]
    }
}

impl<D: Device> GxmRenderer<D> {
    pub(crate) fn build(
        &mut self,
        words: &[u32],
        logical_width: u32,
        logical_height: u32,
    ) -> Result<(), RenderError> {
        let mut tables = Tables {
            images: &self.images,
            fonts: &self.fonts,
            white: self.white,
        };
        pocket_render::build(
            &mut tables,
            words,
            DamageRect::new(0, 0, logical_width as i32, logical_height as i32),
            &mut self.vertices,
            &mut self.commands,
        )
    }
}
