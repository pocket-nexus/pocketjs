use super::*;
impl<P: Pipeline, C: ContextAccess> GlesRenderer<P, C> {
    fn image_name(&self, handle: i32) -> Option<GLuint> {
        if handle < 0 {
            return None;
        }
        self.images
            .iter()
            .find(|image| image.handle == handle)
            .map(|image| image.name)
    }
    fn fill_source(&self, texture: GLuint) -> (GLuint, [f32; 2]) {
        self.images
            .iter()
            .find(|image| image.name == texture)
            .and_then(|image| image.white_uv)
            .map(|uv| (texture, uv))
            .unwrap_or((self.white, [0.5, 0.5]))
    }
    fn quad(
        &mut self,
        top_left: [f32; 2],
        bottom_right: [f32; 2],
        uv0: [f32; 2],
        uv1: [f32; 2],
        colors: [u32; 4],
    ) {
        self.vertices.extend_from_slice(&pocket_tri_batch::quad(
            top_left,
            bottom_right,
            uv0,
            uv1,
            colors,
        ));
    }

    fn flush(&mut self, texture: GLuint, clip: Clip, start: &mut usize) {
        let end = self.vertices.len();
        if end > *start {
            pocket_tri_batch::append_batch(&mut self.commands, texture, clip, *start..end);
            *start = end;
        }
    }

    pub(crate) fn build(
        &mut self,
        words: &[u32],
        logical_width: u32,
        logical_height: u32,
    ) -> Result<(), RenderError> {
        self.vertices.clear();
        self.commands.clear();
        let full = Clip {
            x: 0,
            y: 0,
            w: logical_width as i32,
            h: logical_height as i32,
        };
        let mut clip = full;
        let mut texture = self.white;
        let mut fill_source = 0;
        let mut fill = (self.white, [0.5, 0.5]);
        let mut start = 0usize;

        for decoded in pocket_draw_ops::DrawOps::new(
            words,
            DamageRect::new(0, 0, logical_width as i32, logical_height as i32),
        ) {
            let operation = decoded.map_err(|_| RenderError::InvalidFrame)?;
            let words = operation.words;
            let index = 0usize;
            let next = Clip {
                x: operation.clip.x0,
                y: operation.clip.y0,
                w: operation.clip.x1 - operation.clip.x0,
                h: operation.clip.y1 - operation.clip.y0,
            };
            if clip != next {
                self.flush(texture, clip, &mut start);
                clip = next;
            }
            match operation.opcode {
                spec::draw_op::RECT if index + 4 <= words.len() => {
                    if fill_source != texture {
                        fill = self.fill_source(texture);
                        fill_source = fill.0;
                    }
                    if texture != fill.0 {
                        self.flush(texture, clip, &mut start);
                        texture = fill.0;
                    }
                    let (x, y) = xy(words[index + 1]);
                    let (width, height) = wh(words[index + 2]);
                    let color = words[index + 3];
                    if width > 0.0 && height > 0.0 && color >> 24 != 0 {
                        self.quad([x, y], [x + width, y + height], fill.1, fill.1, [color; 4]);
                    }
                }
                spec::draw_op::GRAD_RECT if index + 6 <= words.len() => {
                    if fill_source != texture {
                        fill = self.fill_source(texture);
                        fill_source = fill.0;
                    }
                    if texture != fill.0 {
                        self.flush(texture, clip, &mut start);
                        texture = fill.0;
                    }
                    let (x, y) = xy(words[index + 1]);
                    let (width, height) = wh(words[index + 2]);
                    let from = words[index + 3];
                    let to = words[index + 4];
                    let direction = words[index + 5];
                    let colors = if direction == spec::GradDir::ToTop as u32 {
                        [to, to, from, from]
                    } else if direction == spec::GradDir::ToLeft as u32 {
                        [to, from, from, to]
                    } else if direction == spec::GradDir::ToRight as u32 {
                        [from, to, to, from]
                    } else {
                        [from, from, to, to]
                    };
                    if width > 0.0 && height > 0.0 {
                        self.quad([x, y], [x + width, y + height], fill.1, fill.1, colors);
                    }
                }
                spec::draw_op::GLYPH_RUN if index + 3 <= words.len() => {
                    let slot = (words[index + 1] & 0xff) as usize;
                    let count = (words[index + 1] >> 16) as usize;
                    let next = index + 3 + count * 2;
                    if next > words.len() {
                        break;
                    }
                    let Some(font) = self.fonts.get(slot).and_then(|font| font.as_ref()) else {
                        continue;
                    };
                    let (logical_w, logical_h, glyph_count) =
                        (font.logical_w, font.logical_h, font.glyph_count);
                    let mut page: Option<GlyphSampler> = None;
                    let color = words[index + 2];
                    for glyph in 0..count {
                        let body = index + 3 + glyph * 2;
                        let (x, y) = xy(words[body]);
                        let gid = (words[body + 1] & 0xffff) as u16;
                        if gid >= glyph_count {
                            continue;
                        }
                        if !page.as_ref().is_some_and(|page| page.contains(gid)) {
                            page = self.fonts[slot]
                                .as_ref()
                                .unwrap()
                                .pages
                                .iter()
                                .find(|page| page.contains(gid))
                                .copied();
                            let Some(name) = page.map(|page| page.handle) else {
                                page = None;
                                continue;
                            };
                            if texture != name {
                                self.flush(texture, clip, &mut start);
                                texture = name;
                            }
                        }
                        let Some(page) = page else {
                            continue;
                        };
                        let [u0, v0, u1, v1] = page.uv(gid);
                        self.quad(
                            [x, y],
                            [x + logical_w as f32, y + logical_h as f32],
                            [u0, v0],
                            [u1, v1],
                            [color; 4],
                        );
                    }
                }
                spec::draw_op::TEX_QUAD if index + 9 <= words.len() => {
                    let handle = words[index + 1] as i32;
                    let Some(name) = self.image_name(handle) else {
                        continue;
                    };
                    if texture != name {
                        self.flush(texture, clip, &mut start);
                        texture = name;
                    }
                    let (x, y) = xy(words[index + 2]);
                    let (width, height) = wh(words[index + 3]);
                    if width > 0.0 && height > 0.0 {
                        self.quad(
                            [x, y],
                            [x + width, y + height],
                            [
                                f32::from_bits(words[index + 4]),
                                f32::from_bits(words[index + 5]),
                            ],
                            [
                                f32::from_bits(words[index + 6]),
                                f32::from_bits(words[index + 7]),
                            ],
                            [words[index + 8]; 4],
                        );
                    }
                }
                spec::draw_op::TEX_TRI if index + 12 <= words.len() => {
                    let handle = words[index + 1] as i32;
                    let Some(name) = self.image_name(handle) else {
                        continue;
                    };
                    if texture != name {
                        self.flush(texture, clip, &mut start);
                        texture = name;
                    }
                    let color = words[index + 11];
                    let positions = core::array::from_fn(|vertex| {
                        let offset = index + 2 + vertex * 3;
                        let (x, y) = xy(words[offset]);
                        [x, y]
                    });
                    let uvs = core::array::from_fn(|vertex| {
                        let offset = index + 2 + vertex * 3;
                        [
                            f32::from_bits(words[offset + 1]),
                            f32::from_bits(words[offset + 2]),
                        ]
                    });
                    self.vertices
                        .extend_from_slice(&pocket_tri_batch::triangle(positions, uvs, [color; 3]));
                }
                spec::draw_op::TRI if index + 7 <= words.len() => {
                    if texture != self.white {
                        self.flush(texture, clip, &mut start);
                        texture = self.white;
                    }
                    let positions = core::array::from_fn(|vertex| {
                        let (x, y) = xy(words[index + 1 + vertex]);
                        [x, y]
                    });
                    let colors = core::array::from_fn(|vertex| words[index + 4 + vertex]);
                    self.vertices.extend_from_slice(&pocket_tri_batch::triangle(
                        positions,
                        [[0.0, 0.0]; 3],
                        colors,
                    ));
                }
                spec::draw_op::SCISSOR | spec::draw_op::SCISSOR_POP => {}
                spec::draw_op::SURFACE_QUAD if index + 9 <= words.len() => {}
                _ => break,
            }
        }
        self.flush(texture, clip, &mut start);
        Ok(())
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
