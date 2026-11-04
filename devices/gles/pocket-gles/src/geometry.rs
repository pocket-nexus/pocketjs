//! GLES policies for the shared DrawList walk, and the scissor mapping.
use super::*;
use pocket_render::{Backend, Fill, GlyphCell, Record};

/// The textures `prepare` resolved for one frame, read by the walk.
pub(crate) struct Tables<'a> {
    pub images: &'a [ImageTexture],
    pub fonts: &'a [Option<FontTexture>],
    pub white: GLuint,
}

impl Backend for Tables<'_> {
    type Vertex = Vertex;
    type Texture = GLuint;
    type Clip = Clip;
    type GlyphData = ();

    fn start(&self) -> Fill<GLuint> {
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

    /// A constant UV inside an opaque white block of the bound texture draws
    /// solid fills without leaving the batch of an image or a glyph page.
    fn fill(&mut self, texture: GLuint) -> Fill<GLuint> {
        self.images
            .iter()
            .find(|image| image.name == texture)
            .and_then(|image| image.white_uv)
            .map(|uv| Fill::point(texture, uv))
            .unwrap_or(Fill::point(self.white, [0.5, 0.5]))
    }

    fn image(&mut self, handle: i32) -> Result<Option<GLuint>, RenderError> {
        if handle < 0 {
            return Ok(None);
        }
        Ok(self
            .images
            .iter()
            .find(|image| image.handle == handle)
            .map(|image| image.name))
    }

    fn glyph(&mut self, slot: u8, gid: u16) -> Result<Option<GlyphCell<GLuint, ()>>, RenderError> {
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
    fn accepts(&mut self, record: &Record<'_>) -> Result<bool, RenderError> {
        Ok(match record {
            Record::Rect(rect) => rect.width > 0 && rect.height > 0 && rect.color >> 24 != 0,
            Record::GradRect(gradient) => gradient.width > 0 && gradient.height > 0,
            Record::TexQuad(image) => image.width > 0 && image.height > 0,
            _ => true,
        })
    }
}

impl<P: Pipeline, C: ContextAccess> GlesRenderer<P, C> {
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

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn physical_clip(
        clip: Clip,
        logical_width: i32,
        logical_height: i32,
        target_x: i32,
        target_y: i32,
        target_width: i32,
        target_height: i32,
        window_height: i32,
    ) -> Clip {
        let x0 = clip.x.clamp(0, logical_width);
        let y0 = clip.y.clamp(0, logical_height);
        let x1 = (clip.x + clip.w).clamp(0, logical_width);
        let y1 = (clip.y + clip.h).clamp(0, logical_height);
        let scale_floor = |value: i32, target: i32, logical: i32| -> i32 {
            if target == logical {
                return value;
            }
            (value as i64 * target as i64 / logical as i64) as i32
        };
        let scale_ceil = |value: i32, target: i32, logical: i32| -> i32 {
            if target == logical {
                return value;
            }
            ((value as i64 * target as i64 + logical as i64 - 1) / logical as i64) as i32
        };
        let left = target_x + scale_floor(x0, target_width, logical_width);
        let right = target_x + scale_ceil(x1, target_width, logical_width);
        let top = target_y + scale_floor(y0, target_height, logical_height);
        let bottom = target_y + scale_ceil(y1, target_height, logical_height);
        Clip {
            x: left,
            y: window_height - bottom,
            w: (right - left).max(0),
            h: (bottom - top).max(0),
        }
    }
}
