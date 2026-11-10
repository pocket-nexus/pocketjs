use crate::*;
use pocket_drivers::DamageRect;
use pocket_render::glyph_pages::GlyphSource;
use pocket_render::record::SurfaceQuad;
use pocket_render::{Backend, Emit, Fill, GlyphCell, Record, Source, Vertex};

fn cache_error(error: pocket_render::tex_cache::CacheError<RenderError>) -> RenderError {
    match error {
        pocket_render::tex_cache::CacheError::Capacity => RenderError::Failed,
        pocket_render::tex_cache::CacheError::Upload(error) => error,
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
/// A frame's vertices, its draw batches, and the bindings of the painter
/// textures `TexBind::Text` indexes.
type FrameBatches = (Vec<UiVertex>, Vec<DrawCmd>, Vec<wgpu::BindGroup>);

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
    ) -> Result<FrameBatches, RenderError> {
        let mut vertices = Vec::new();
        let mut commands = Vec::new();
        let mut frame = Frame {
            renderer: self,
            resources,
            size,
            scale,
            submission,
            text_bindings: Vec::new(),
            text_views: HashMap::new(),
            text_quads: Vec::new(),
            text_bytes: Vec::new(),
        };
        pocket_render::build(&mut frame, words, viewport, &mut vertices, &mut commands)?;
        let text_bindings = frame.text_bindings;
        // The walk emits logical positions; the shader takes NDC.
        for vertex in &mut vertices {
            let [x, y] = vertex.pos;
            vertex.pos = [
                x * scale / size.0 as f32 * 2.0 - 1.0,
                1.0 - y * scale / size.1 as f32 * 2.0,
            ];
        }
        Ok((vertices, commands, text_bindings))
    }
}

/// One frame's policies for the shared DrawList walk: textures resolve
/// through the caches as the walk meets them and stay pinned for the
/// submission.
struct Frame<'a> {
    renderer: &'a mut WgpuRenderer,
    resources: &'a dyn RenderResources,
    size: (u32, u32),
    scale: f32,
    submission: Option<u64>,
    /// Bindings of the painter textures met in this frame; `TexBind::Text`
    /// indexes this list.
    text_bindings: Vec<wgpu::BindGroup>,
    /// Each painter texture view's index in `text_bindings`.
    text_views: HashMap<wgpu::TextureView, usize>,
    text_quads: Vec<TextQuad>,
    text_bytes: Vec<u8>,
}

impl Frame<'_> {
    /// The `TexBind::Text` index of a painter texture, binding it on first use.
    fn text_binding(&mut self, texture: &wgpu::TextureView) -> usize {
        if let Some(&index) = self.text_views.get(texture) {
            return index;
        }
        let renderer = &*self.renderer;
        let bind = renderer
            .gpu
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pocket text painter texture"),
                layout: &renderer.bind_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(texture),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&renderer.sampler),
                    },
                ],
            });
        let index = self.text_bindings.len();
        self.text_bindings.push(bind);
        self.text_views.insert(texture.clone(), index);
        index
    }
}

/// The box-local bounding box of the screen rectangle `clip` under `run`'s
/// transform; None when the transform is singular or the clip empty.
fn box_clip(run: &TextRun<'_>, clip: DamageRect) -> Option<[f32; 4]> {
    let [a, b, c, d] = run.transform;
    let determinant = a * d - b * c;
    if determinant == 0.0 || !determinant.is_finite() || clip.x1 <= clip.x0 || clip.y1 <= clip.y0 {
        return None;
    }
    let mut bounds = [
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    for (x, y) in [
        (clip.x0, clip.y0),
        (clip.x1, clip.y0),
        (clip.x1, clip.y1),
        (clip.x0, clip.y1),
    ] {
        let (dx, dy) = (x as f32 - run.origin[0], y as f32 - run.origin[1]);
        let (u, v) = (
            (d * dx - c * dy) / determinant,
            (a * dy - b * dx) / determinant,
        );
        bounds = [
            bounds[0].min(u),
            bounds[1].min(v),
            bounds[2].max(u),
            bounds[3].max(v),
        ];
    }
    Some(bounds)
}

fn finite<'a>(values: impl IntoIterator<Item = &'a f32>) -> Result<bool, RenderError> {
    if values.into_iter().any(|value| !value.is_finite()) {
        Err(RenderError::InvalidFrame)
    } else {
        Ok(true)
    }
}

impl Backend for Frame<'_> {
    type Vertex = UiVertex;
    type Texture = TexBind;
    type Clip = (u32, u32, u32, u32);
    type GlyphData = [f32; 4];

    /// Fills sample the white texture across its whole extent.
    fn start(&self) -> Fill<TexBind> {
        Fill {
            texture: TexBind::White,
            uv0: [0.0; 2],
            uv1: [1.0; 2],
        }
    }

    fn clip(&self, rect: DamageRect) -> Self::Clip {
        clip(rect, self.size, self.scale)
    }

    fn fill(&mut self, _texture: TexBind) -> Fill<TexBind> {
        self.start()
    }

    fn image(&mut self, handle: i32) -> Result<Option<TexBind>, RenderError> {
        Ok(self
            .renderer
            .image(self.resources, handle, self.submission)?
            .map(TexBind::Image))
    }

    fn glyph(
        &mut self,
        slot: u8,
        gid: u16,
    ) -> Result<Option<GlyphCell<TexBind, [f32; 4]>>, RenderError> {
        Ok(self
            .renderer
            .glyph(self.resources, slot, gid, self.submission)?
            .map(|glyph| GlyphCell {
                texture: TexBind::Font(glyph.key),
                uv: glyph.uv,
                width: glyph.logical.0,
                height: glyph.logical.1,
                data: glyph.bounds,
            }))
    }

    /// Empty rectangles draw nothing; a non-finite texture coordinate is an
    /// invalid frame.
    fn accepts(&mut self, record: &Record<'_>) -> Result<bool, RenderError> {
        match record {
            Record::Rect(rect) => Ok(rect.width > 0 && rect.height > 0),
            Record::GradRect(gradient) => Ok(gradient.width > 0 && gradient.height > 0),
            Record::TexQuad(image) => finite(image.uv0.iter().chain(&image.uv1)),
            Record::TexTri(image) => finite(image.uvs.iter().flatten()),
            _ => Ok(true),
        }
    }

    /// The shader's `mode` selects the sampling path; glyph vertices carry
    /// their inset sampling bounds.
    fn emitted(&mut self, vertices: &mut [UiVertex], source: Source<[f32; 4]>) {
        match source {
            Source::Fill => {}
            Source::Image | Source::Surface => {
                for vertex in vertices {
                    vertex.mode = 1;
                }
            }
            Source::Glyph(bounds) => {
                for vertex in vertices {
                    vertex.mode = 2;
                    vertex.bounds = bounds;
                }
            }
        }
    }

    fn surface_quad(
        &mut self,
        emit: &mut Emit<'_, UiVertex, TexBind, Self::Clip>,
        surface: &SurfaceQuad,
        clip: DamageRect,
    ) -> Result<(), RenderError> {
        let Some(entry) = self.renderer.surfaces.get(&surface.surface) else {
            return Ok(());
        };
        let logical = entry.logical;
        let [x, y, width, height] = [surface.x, surface.y, surface.width, surface.height];
        finite(&[x, y, width, height])?;
        let width = width.min(logical.0 as f32);
        let height = height.min(logical.1 as f32);
        if width <= 0.0 || height <= 0.0 || logical.0 == 0 || logical.1 == 0 {
            return Ok(());
        }
        let (size, scale) = (self.size, self.scale);
        let scissor = self.clip(clip);
        let [cx, cy] = [surface.clip_x as f32, surface.clip_y as f32];
        let [cw, ch] = [surface.clip_width as f32, surface.clip_height as f32];
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
        let corners: [UiVertex; 6] = pocket_render::quad(
            [x, y],
            [x + width, y + height],
            [0.0; 2],
            [width / logical.0 as f32, height / logical.1 as f32],
            [u32::MAX; 4],
        );
        let vertices = emit.detached(
            TexBind::Surface(surface.surface),
            (x0, y0, x1.saturating_sub(x0), y1.saturating_sub(y0)),
            &corners,
        );
        self.emitted(vertices, Source::Surface);
        Ok(())
    }

    /// The installed painter supplies box-local quads; each lands on screen
    /// through the run's transform, in painter order, under `clip`.
    fn text_run(
        &mut self,
        emit: &mut Emit<'_, UiVertex, TexBind, Self::Clip>,
        run: &TextRun<'_>,
        clip: DamageRect,
    ) -> Result<(), RenderError> {
        finite(run.origin.iter().chain(&run.transform))?;
        // Nothing of a run under a singular transform or an empty clip is
        // visible; the core culls the first.
        let Some(clip_box) = box_clip(run, clip) else {
            return Ok(());
        };
        let context = TextPaintContext {
            scale: self.scale,
            clip: clip_box,
        };
        let mut bytes = core::mem::take(&mut self.text_bytes);
        let mut quads = core::mem::take(&mut self.text_quads);
        quads.clear();
        let painted = match run.text(&mut bytes) {
            None => Err(RenderError::InvalidFrame),
            Some(text) => match self.renderer.text_painter.as_mut() {
                None => Err(RenderError::Unsupported),
                Some(painter) => painter.paint(run, text, &context, &mut quads),
            },
        };
        let scissor = self.clip(clip);
        let result = painted.and_then(|()| {
            for quad in &quads {
                finite(quad.rect.iter().chain(&quad.uv))?;
                let [x0, y0, x1, y1] = quad.rect;
                let [u0, v0, u1, v1] = quad.uv;
                let color = match quad.ink {
                    TextInk::Coverage => run.color,
                    TextInk::Color => run.color | 0x00ff_ffff,
                };
                let corner = |x: f32, y: f32, u: f32, v: f32| {
                    UiVertex::from_components(run.to_screen([x, y]), [u, v], color)
                };
                let (tl, tr) = (corner(x0, y0, u0, v0), corner(x1, y0, u1, v0));
                let (br, bl) = (corner(x1, y1, u1, v1), corner(x0, y1, u0, v1));
                let texture = TexBind::Text(self.text_binding(&quad.texture));
                let vertices = emit.detached(texture, scissor, &[tl, tr, br, tl, br, bl]);
                let bounds = [u0.min(u1), v0.min(v1), u0.max(u1), v0.max(v1)];
                for vertex in vertices {
                    match quad.ink {
                        TextInk::Coverage => {
                            vertex.mode = 2;
                            vertex.bounds = bounds;
                        }
                        TextInk::Color => vertex.mode = 1,
                    }
                }
            }
            Ok(())
        });
        self.text_bytes = bytes;
        self.text_quads = quads;
        result
    }
}
