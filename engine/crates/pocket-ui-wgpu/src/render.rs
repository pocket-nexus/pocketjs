//! Compatibility entry points for hosts which still own a `Ui` and encoder.
//! All decoding, resource uploads and GPU drawing live in pocket-web-render.

use anyhow::{Result, anyhow};
use pocket_web_render::WgpuRenderer;
use pocket3d::gpu::Gpu;
use pocketjs_core::Ui;

pub struct UiRenderer {
    driver: WgpuRenderer,
}
impl UiRenderer {
    pub fn new(gpu: &Gpu, target_format: wgpu::TextureFormat) -> Self {
        Self {
            driver: WgpuRenderer::new(&gpu.device, &gpu.queue, target_format)
                .expect("native wgpu renderer format"),
        }
    }
    pub fn set_surface(
        &mut self,
        _gpu: &Gpu,
        handle: u32,
        view: &wgpu::TextureView,
        logical: (u32, u32),
    ) {
        self.driver.set_surface(handle, view, logical);
    }
    pub fn retain_surfaces(&mut self, keep: impl FnMut(u32) -> bool) {
        self.driver.retain_surfaces(keep);
    }
    pub fn render(
        &mut self,
        gpu: &Gpu,
        ui: &mut Ui,
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        target_px: (u32, u32),
        load: wgpu::LoadOp<wgpu::Color>,
    ) -> Result<()> {
        let words = ui.draw().words.clone();
        self.render_words(gpu, ui, &words, encoder, view, target_px, load)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn render_words(
        &mut self,
        gpu: &Gpu,
        ui: &Ui,
        words: &[u32],
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        target_px: (u32, u32),
        load: wgpu::LoadOp<wgpu::Color>,
    ) -> Result<()> {
        self.render_words_scaled(gpu, ui, words, encoder, view, target_px, 1.0, load)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn render_words_scaled(
        &mut self,
        _gpu: &Gpu,
        ui: &Ui,
        words: &[u32],
        encoder: &mut wgpu::CommandEncoder,
        view: &wgpu::TextureView,
        target_px: (u32, u32),
        scale: f32,
        load: wgpu::LoadOp<wgpu::Color>,
    ) -> Result<()> {
        self.driver
            .encode(ui, words, encoder, view, target_px, scale, load)
            .map_err(|error| anyhow!("wgpu DrawList: {error:?}"))?
            .retain_in_encoder();
        Ok(())
    }
}
