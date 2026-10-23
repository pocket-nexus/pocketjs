//! A runtime-owned PocketJS program rendered onto a 3D widget's screen.
//! The fixed texture remains bound to the mesh. Runtime presentation waits
//! for the UI driver before the scene submits reads on the same GPU queue.

use anyhow::{Result, anyhow};
use pocket_drivers::InputFrameBuilder;
use pocket_mod::Guest;
use pocket_ui_wgpu::{ProgramOutput, ProgramTarget, UiProgram, UiSurface};
use pocket3d::gpu::{Gpu, OFFSCREEN_FORMAT, OffscreenTarget};
use std::{rc::Rc, sync::Arc};

pub struct EmbeddedUi {
    program: UiProgram,
    surface: UiSurface,
    output: ProgramOutput,
    target: Arc<ProgramTarget>,
    px: (u32, u32),
    hash: u64,
    revision: u64,
    texture_dirty: bool,
}
impl EmbeddedUi {
    /// Register the screen's real GPU output before admitting and evaluating
    /// the app. Coordinates stay logical; `scale` converts them to pixels.
    pub fn new_with_scale(
        gpu: &Gpu,
        mut program: UiProgram,
        px: (u32, u32),
        scale: f32,
        bundle: &str,
        pak: &[u8],
    ) -> Result<Self> {
        let surface = program.surface();
        let output = ProgramOutput::with_options(
            gpu,
            px,
            scale,
            OFFSCREEN_FORMAT,
            wgpu::Color::BLACK,
            true,
        )?;
        output.register(&mut program)?;
        program.boot(Rc::new(Guest::new()?), "embedded", bundle, pak)?;
        let target = output
            .first()
            .ok_or_else(|| anyhow!("missing embedded target"))?;
        Ok(Self {
            program,
            surface,
            output,
            target,
            px,
            hash: 0,
            revision: 0,
            texture_dirty: true,
        })
    }

    /// Publish sampled device facts and advance exactly one runtime frame.
    /// Changes to atlas pixels count even when the DrawList words are equal.
    pub fn tick(&mut self, facts: InputFrameBuilder) -> Result<bool> {
        self.program.set_input(facts);
        self.program.advance()?;
        let (hash, revision) = self.surface.with_ui(|ui| {
            let hash = fnv1a64(&ui.draw().words);
            (hash, ui.raster_revision())
        });
        let changed = hash != self.hash || revision != self.revision;
        self.hash = hash;
        self.revision = revision;
        self.texture_dirty |= changed;
        Ok(changed)
    }

    /// Complete runtime rendering before the scene samples the fixed texture.
    pub fn render_if_dirty(&mut self, _gpu: &Gpu) -> Result<bool> {
        if !self.texture_dirty {
            return Ok(false);
        }
        anyhow::ensure!(self.output.prepare()?, "embedded target unavailable");
        self.program.present()?;
        self.texture_dirty = false;
        Ok(true)
    }
    pub fn view(&self) -> &wgpu::TextureView {
        &self.target.view
    }
    pub fn target(&self) -> &OffscreenTarget {
        &self.target
    }
    pub fn surface(&self) -> &UiSurface {
        &self.surface
    }
    pub fn size(&self) -> (u32, u32) {
        self.px
    }
    pub fn content_hash(&self) -> u64 {
        self.hash
    }
}

/// FNV-1a 64 over the DrawList words; callers also include raster revision.
fn fnv1a64(words: &[u32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for w in words {
        for b in w.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

#[cfg(test)]
mod tests {
    #[test]
    fn runtime_screen_samples_facts_and_updates_its_fixed_texture() {
        use super::*;
        use pocket_drivers::{AxisSample, abi};
        use pocket_ui_wgpu::{ProgramConfig, embedded_profile};
        let gpu = Gpu::new_headless().unwrap();
        let (profile, profile_hash) = embedded_profile("macos-embedded", [8, 4], 2, 60);
        let program = UiProgram::new(ProgramConfig {
            profile,
            profile_hash,
            host_abi: pocket_spec::BINDING_GENERATION,
            logical: [8, 4],
            heap_limit: 4 * 1024 * 1024,
            frame_buffer_budget: 4096,
        })
        .unwrap();
        program.surface().set_svc_allowlist(["test"]);
        let source = format!(
            "if(ui.__host!=='macos-embedded'||ui.__hostAbi!=={binding_generation}||ui.__viewport.w!==8)throw Error('metadata');ui.svcOpen('test');const n=ui.createNode(0);ui.insertBefore(1,n,0);ui.setProp(n,{},8);ui.setProp(n,{},4);globalThis.frame=(buttons,analog)=>{{ui.setProp(n,{},buttons?0xff00ff00:0xff0000ff);ui.svcSend(String(analog));}};",
            pocketjs_core::spec::prop::WIDTH,
            pocketjs_core::spec::prop::HEIGHT,
            pocketjs_core::spec::prop::BG_COLOR,
            binding_generation = pocket_spec::BINDING_GENERATION
        );
        let mut embedded =
            EmbeddedUi::new_with_scale(&gpu, program, (16, 8), 2., &source, &[]).unwrap();
        let fixed = embedded.target.clone();
        assert!(embedded.tick(InputFrameBuilder::new()).unwrap());
        assert!(embedded.render_if_dirty(&gpu).unwrap());
        assert_eq!(fixed.read_rgba(&gpu).unwrap(), [255, 0, 0, 255].repeat(128));
        assert_eq!(embedded.surface().svc_drain(), ["32896"]);
        let mut facts = InputFrameBuilder::new();
        facts.buttons = 1;
        facts.axes.push(AxisSample {
            id: abi::POCKET_AXIS_LEFT_X,
            value: 255.,
        });
        assert!(embedded.tick(facts).unwrap());
        assert!(embedded.render_if_dirty(&gpu).unwrap());
        assert!(Arc::ptr_eq(&fixed, &embedded.target));
        assert_eq!(fixed.read_rgba(&gpu).unwrap(), [0, 255, 0, 255].repeat(128));
        assert_eq!(embedded.surface().svc_drain(), ["65408"]);
        let mut same = InputFrameBuilder::new();
        same.buttons = 1;
        assert!(!embedded.tick(same).unwrap());
        assert!(!embedded.render_if_dirty(&gpu).unwrap());
        assert_eq!(embedded.output.pending_submissions(), 0);
    }
}
