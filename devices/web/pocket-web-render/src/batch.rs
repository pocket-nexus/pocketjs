use crate::*;
use pocket_draw_ops::DrawOps;
use pocket_drivers::DamageRect;
use pocket_glyph_pages::GlyphSource;

fn cache_error(error: pocket_tex_cache::CacheError<RenderError>) -> RenderError {
    match error {
        pocket_tex_cache::CacheError::Capacity => RenderError::Failed,
        pocket_tex_cache::CacheError::Upload(error) => error,
    }
}

struct GlyphDraw {
    key: TextureKey,
    uv: [f32; 4],
    bounds: [f32; 4],
    logical: (f32, f32),
}

fn clip(rect: DamageRect, size: (u32, u32), scale: f32) -> (u32, u32, u32, u32) {
    let x0 = ((rect.x0 as f32 * scale).max(0.0) as u32).min(size.0);
    let y0 = ((rect.y0 as f32 * scale).max(0.0) as u32).min(size.1);
    let x1 = ((rect.x1 as f32 * scale).max(0.0) as u32).min(size.0);
    let y1 = ((rect.y1 as f32 * scale).max(0.0) as u32).min(size.1);
    (x0, y0, x1.saturating_sub(x0), y1.saturating_sub(y0))
}
impl WgpuRenderer {
    fn image(
        &mut self,
        resources: &dyn RenderResources,
        handle: i32,
        submission: Option<u64>,
    ) -> Result<Option<TextureKey>, RenderError> {
        let Some(view) = resources.texture(handle) else {
            return Ok(None);
        };
        let Some(revision) = resources.texture_revision(handle) else {
            return Ok(None);
        };
        let key = TextureKey { handle, revision };
        if self.images.get(key).is_some() {
            if let Some(id) = submission {
                self.images.retain(key, id);
            }
            return Ok(Some(key));
        }
        let limit = self.gpu.device.limits().max_texture_dimension_2d;
        if view.w == 0 || view.h == 0 || view.w > limit || view.h > limit {
            return Err(RenderError::InvalidFrame);
        }
        let bytes = (view.w as usize)
            .checked_mul(view.h as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or(RenderError::InvalidFrame)?;
        let gpu = &self.gpu;
        let layout = &self.bind_layout;
        let sampler = if view.linear {
            &self.sampler
        } else {
            &self.sampler_nearest
        };
        let format = self.image_format;
        self.images
            .get_or_upload(
                key,
                bytes,
                submission,
                || {
                    // Cache capacity is checked before CPU expansion or GPU allocation.
                    let rgba = pixels::to_rgba8(&view).ok_or(RenderError::InvalidFrame)?;
                    Ok(gpu.upload_image(layout, sampler, format, &rgba, view.w, view.h))
                },
                drop,
            )
            .map_err(cache_error)?;
        Ok(Some(key))
    }
    fn glyph(
        &mut self,
        resources: &dyn RenderResources,
        slot: u8,
        gid: u16,
        submission: Option<u64>,
    ) -> Result<Option<GlyphDraw>, RenderError> {
        let Some(font) = resources.font_atlas(slot) else {
            return Ok(None);
        };
        if gid >= font.glyph_count {
            return Ok(None);
        }
        GlyphSource::from_font(font, slot).ok_or(RenderError::InvalidFrame)?;
        let Some(revision) = resources.font_revision(slot) else {
            return Ok(None);
        };
        let limit = self.gpu.device.limits().max_texture_dimension_2d.min(1024);
        let layout =
            GlyphPageLayout::with_limit(font, gid, limit).ok_or(RenderError::InvalidFrame)?;
        let key = TextureKey {
            handle: ((slot as i32) << 16) | layout.page() as i32,
            revision,
        };
        if self.fonts.get(key).is_none() {
            let gpu = &self.gpu;
            let bind_layout = &self.bind_layout;
            let sampler = &self.sampler;
            self.fonts
                .get_or_upload(
                    key,
                    layout.coverage_bytes(),
                    submission,
                    || {
                        let mut pixels = vec![0; layout.coverage_bytes()];
                        if !layout.expand_a8(font, &mut pixels) {
                            return Err(RenderError::InvalidFrame);
                        }
                        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                            label: Some("pocket guarded glyph page"),
                            size: wgpu::Extent3d {
                                width: layout.width(),
                                height: layout.height(),
                                depth_or_array_layers: 1,
                            },
                            mip_level_count: 1,
                            sample_count: 1,
                            dimension: wgpu::TextureDimension::D2,
                            format: wgpu::TextureFormat::R8Unorm,
                            usage: wgpu::TextureUsages::TEXTURE_BINDING
                                | wgpu::TextureUsages::COPY_DST,
                            view_formats: &[],
                        });
                        gpu.queue.write_texture(
                            texture.as_image_copy(),
                            &pixels,
                            wgpu::TexelCopyBufferLayout {
                                offset: 0,
                                bytes_per_row: Some(layout.width()),
                                rows_per_image: None,
                            },
                            texture.size(),
                        );
                        let view = texture.create_view(&Default::default());
                        let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                            label: Some("pocket glyph page binding"),
                            layout: bind_layout,
                            entries: &[
                                wgpu::BindGroupEntry {
                                    binding: 0,
                                    resource: wgpu::BindingResource::TextureView(&view),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 1,
                                    resource: wgpu::BindingResource::Sampler(sampler),
                                },
                            ],
                        });
                        Ok(FontTexture {
                            bind,
                            layout,
                            logical: (font.cell_w as f32, font.cell_h as f32),
                        })
                    },
                    drop,
                )
                .map_err(cache_error)?;
        } else if let Some(id) = submission {
            self.fonts.retain(key, id);
        }
        let font = self.fonts.get(key).ok_or(RenderError::InvalidFrame)?;
        let uv = font.layout.sampler(0).uv(gid);
        let dx = 0.5 / font.layout.width() as f32;
        let dy = 0.5 / font.layout.height() as f32;
        Ok(Some(GlyphDraw {
            key,
            uv,
            bounds: [uv[0] + dx, uv[1] + dy, uv[2] - dx, uv[3] - dy],
            logical: font.logical,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn build_batches(
        &mut self,
        resources: &dyn RenderResources,
        words: &[u32],
        size: (u32, u32),
        scale: f32,
        viewport: DamageRect,
        submission: Option<u64>,
    ) -> Result<(Vec<UiVertex>, Vec<DrawCmd>), RenderError> {
        let mut vertices = Vec::new();
        let mut commands = Vec::new();
        let ndc = |[x, y]: [f32; 2]| {
            [
                x * scale / size.0 as f32 * 2.0 - 1.0,
                1.0 - y * scale / size.1 as f32 * 2.0,
            ]
        };
        let xy = |word: u32| {
            [
                (word as u16 as i16) as f32,
                ((word >> 16) as u16 as i16) as f32,
            ]
        };
        let wh = |word: u32| [(word & 0xffff) as f32, (word >> 16) as f32];
        let quad =
            |vertices: &mut Vec<UiVertex>, xy0: [f32; 2], xy1: [f32; 2], uv0, uv1, colors, mode| {
                let mut quad: [UiVertex; 6] =
                    pocket_tri_batch::quad(ndc(xy0), ndc(xy1), uv0, uv1, colors);
                for vertex in &mut quad {
                    vertex.mode = mode;
                }
                vertices.extend(quad);
            };
        for operation in DrawOps::new(words, viewport) {
            let operation = operation.map_err(|_| RenderError::InvalidFrame)?;
            let w = operation.words;
            let scissor = clip(operation.clip, size, scale);
            let start = vertices.len();
            let mut texture = TexBind::White;
            match operation.opcode {
                spec::draw_op::SCISSOR | spec::draw_op::SCISSOR_POP => continue,
                spec::draw_op::RECT | spec::draw_op::GRAD_RECT => {
                    let [x, y] = xy(w[1]);
                    let [width, height] = wh(w[2]);
                    if width <= 0.0 || height <= 0.0 {
                        continue;
                    }
                    let colors = if operation.opcode == spec::draw_op::RECT {
                        [w[3]; 4]
                    } else if w[5] == spec::GradDir::ToTop as u32 {
                        [w[4], w[4], w[3], w[3]]
                    } else if w[5] == spec::GradDir::ToLeft as u32 {
                        [w[4], w[3], w[3], w[4]]
                    } else if w[5] == spec::GradDir::ToRight as u32 {
                        [w[3], w[4], w[4], w[3]]
                    } else {
                        [w[3], w[3], w[4], w[4]]
                    };
                    quad(
                        &mut vertices,
                        [x, y],
                        [x + width, y + height],
                        [0.0; 2],
                        [1.0; 2],
                        colors,
                        0,
                    );
                }
                spec::draw_op::TEX_QUAD => {
                    let Some(key) = self.image(resources, w[1] as i32, submission)? else {
                        continue;
                    };
                    texture = TexBind::Image(key);
                    let [x, y] = xy(w[2]);
                    let [width, height] = wh(w[3]);
                    let uv = [w[4], w[5], w[6], w[7]].map(f32::from_bits);
                    if uv.iter().any(|v| !v.is_finite()) {
                        return Err(RenderError::InvalidFrame);
                    }
                    quad(
                        &mut vertices,
                        [x, y],
                        [x + width, y + height],
                        [uv[0], uv[1]],
                        [uv[2], uv[3]],
                        [w[8]; 4],
                        1,
                    );
                }
                spec::draw_op::TRI => {
                    let triangle: [UiVertex; 3] = pocket_tri_batch::triangle(
                        [ndc(xy(w[1])), ndc(xy(w[2])), ndc(xy(w[3]))],
                        [[0.0; 2]; 3],
                        [w[4], w[5], w[6]],
                    );
                    vertices.extend(triangle);
                }
                spec::draw_op::TEX_TRI => {
                    let Some(key) = self.image(resources, w[1] as i32, submission)? else {
                        continue;
                    };
                    texture = TexBind::Image(key);
                    let positions = core::array::from_fn(|i| ndc(xy(w[2 + i * 3])));
                    let uvs: [[f32; 2]; 3] = core::array::from_fn(|i| {
                        [f32::from_bits(w[3 + i * 3]), f32::from_bits(w[4 + i * 3])]
                    });
                    if uvs.iter().flatten().any(|v| !v.is_finite()) {
                        return Err(RenderError::InvalidFrame);
                    }
                    let mut triangle: [UiVertex; 3] =
                        pocket_tri_batch::triangle(positions, uvs, [w[11]; 3]);
                    for vertex in &mut triangle {
                        vertex.mode = 1;
                    }
                    vertices.extend(triangle);
                }
                spec::draw_op::GLYPH_RUN => {
                    for pair in w[3..].as_chunks::<2>().0 {
                        let Some(GlyphDraw {
                            key,
                            uv,
                            bounds,
                            logical,
                        }) = self.glyph(resources, w[1] as u8, pair[1] as u16, submission)?
                        else {
                            continue;
                        };
                        let start = vertices.len();
                        let [x, y] = xy(pair[0]);
                        quad(
                            &mut vertices,
                            [x, y],
                            [x + logical.0, y + logical.1],
                            [uv[0], uv[1]],
                            [uv[2], uv[3]],
                            [w[2]; 4],
                            2,
                        );
                        for vertex in &mut vertices[start..] {
                            vertex.bounds = bounds;
                        }
                        pocket_tri_batch::append_batch(
                            &mut commands,
                            TexBind::Font(key),
                            scissor,
                            start..vertices.len(),
                        );
                    }
                    continue;
                }
                spec::draw_op::SURFACE_QUAD => {
                    let Some(surface) = self.surfaces.get(&w[1]) else {
                        continue;
                    };
                    let logical = surface.logical;
                    let [x, y, width, height] = [w[2], w[3], w[4], w[5]].map(f32::from_bits);
                    if [x, y, width, height].iter().any(|v| !v.is_finite()) {
                        return Err(RenderError::InvalidFrame);
                    }
                    let width = width.min(logical.0 as f32);
                    let height = height.min(logical.1 as f32);
                    if width <= 0.0 || height <= 0.0 || logical.0 == 0 || logical.1 == 0 {
                        continue;
                    }
                    let [cx, cy] = xy(w[6]);
                    let [cw, ch] = wh(w[7]);
                    // Surface clips use ceil at fractional physical boundaries.
                    let x0 = ((cx * scale).max(0.0).ceil() as u32)
                        .max(scissor.0)
                        .min(size.0);
                    let y0 = ((cy * scale).max(0.0).ceil() as u32)
                        .max(scissor.1)
                        .min(size.1);
                    let x1 = (((cx + cw) * scale).max(0.0).ceil() as u32)
                        .min(scissor.0 + scissor.2)
                        .min(size.0);
                    let y1 = (((cy + ch) * scale).max(0.0).ceil() as u32)
                        .min(scissor.1 + scissor.3)
                        .min(size.1);
                    quad(
                        &mut vertices,
                        [x, y],
                        [x + width, y + height],
                        [0.0; 2],
                        [width / logical.0 as f32, height / logical.1 as f32],
                        [u32::MAX; 4],
                        1,
                    );
                    pocket_tri_batch::append_batch(
                        &mut commands,
                        TexBind::Surface(w[1]),
                        (x0, y0, x1.saturating_sub(x0), y1.saturating_sub(y0)),
                        start..vertices.len(),
                    );
                    continue;
                }
                _ => return Err(RenderError::Unsupported),
            }
            pocket_tri_batch::append_batch(&mut commands, texture, scissor, start..vertices.len());
        }
        Ok((vertices, commands))
    }
}
