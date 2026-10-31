//! The PocketJS UI over the room: the shared Runtime, the pocket-gles2 pipeline
//! drawing into the same default framebuffer the room has already filled, and
//! the `pocket.overlay` JSON channel that carries state down and commands up.
use crate::cjk::CjkAtlases;
use anyhow::{anyhow, Result};
use pocket_drivers::{
    BufferIdentity, DeviceTarget, DisplayDescriptor, DisplayError, DisplayOutput, DisplayRole,
    InputFrameBuilder, PixelFormat, Rect, RenderError, Target, TargetOwnership, VsyncSource,
};
use pocket_gles::{CacheLimits, ClearMode, ContextAccess, TargetConfig, Viewport};
use pocket_mod::Guest;
use pocket_package::source::{LoadedPackage, MemorySource};
use pocket_runtime::Profile;
use pocket_ui_surface::{ProgramConfig, UiProgram, UiSurface};
use std::rc::Rc;

struct Current;
// The program's one EGL context stays current on the main thread for its life.
unsafe impl ContextAccess for Current {
    type NativeTarget = ();
    fn ensure_current(&mut self) -> Result<(), RenderError> {
        Ok(())
    }
    fn bind_target(&mut self, _: &()) -> Result<(), RenderError> {
        unsafe { pocket_arcade::gl::glBindFramebuffer(pocket_arcade::gl::FRAMEBUFFER, 0) };
        Ok(())
    }
}

/// The panel as seen by presentation: the frame belongs to the program, which
/// swaps once per frame after this renderer finishes on top of the room.
struct Panel {
    handle: u64,
    size: [u32; 2],
}

impl DisplayOutput for Panel {
    type Token = ();
    fn descriptor(&self) -> DisplayDescriptor {
        let mut descriptor = DisplayDescriptor::new(
            DisplayRole::Primary,
            self.size[0],
            self.size[1],
            PixelFormat::Rgba8888,
            self.size[0] as usize * 4,
            TargetOwnership::DeviceOwned,
        );
        descriptor.vsync = VsyncSource::Display;
        descriptor
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        Ok(None)
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        Ok(Target::DeviceOwned(DeviceTarget::new(
            self.handle,
            region,
            PixelFormat::Rgba8888,
        )))
    }
    fn flush(&mut self, _: &[Rect]) -> Result<(), DisplayError> {
        Ok(())
    }
    fn wait(&mut self, _: ()) -> Result<(), DisplayError> {
        Ok(())
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::Display
    }
}

/// The interface's own literals, which the Latin baked fonts do not cover.
const UI_TEXT: [&str; 2] = [
    include_str!("../../../apps/studio-handheld/app.tsx"),
    include_str!("../../../apps/studio-handheld/model.ts"),
];

pub struct Overlay {
    program: UiProgram,
    surface: UiSurface,
    atlases: CjkAtlases,
    _guest: Rc<Guest>,
}

impl Overlay {
    /// # Safety
    /// The program's EGL context must be current on this thread.
    pub unsafe fn new(
        profile: Profile,
        host_abi: u32,
        profile_hash: [u8; 32],
        package: Vec<u8>,
    ) -> Result<Self> {
        let logical = profile.logical_viewports[0];
        let panel = profile.viewport;
        let facts = profile.host_facts(host_abi, profile_hash);
        let mut source = MemorySource(package.clone());
        let loaded = LoadedPackage::load(&mut source, &facts, 16 * 1024 * 1024)
            .map_err(|error| anyhow!("package: {error:?}"))?;
        let atlases = CjkAtlases::from_pak(loaded.pak());
        drop(loaded);
        let mut program = UiProgram::new(ProgramConfig {
            profile,
            tick_hz: 60,
            profile_hash,
            host_abi,
            logical,
            heap_limit: 32 * 1024 * 1024,
            frame_buffer_budget: 16 * 1024 * 1024,
        })?;
        let mut renderer = pocket_gles2::Renderer::with_limits(
            Current,
            CacheLimits::new(64, 16 * 1024 * 1024, 64, 8 * 1024 * 1024),
        )
        .map_err(|error| anyhow!("renderer: {error:?}"))?;
        renderer.set_swap_synchronized(true);
        let mut config = TargetConfig::new(
            (),
            panel,
            Viewport::new(0, 0, panel[0], panel[1]),
            PixelFormat::Rgba8888,
        );
        config.clear = ClearMode::Preserve;
        config.external_compositor = true;
        let handle = renderer
            .register_target(config)
            .map_err(|error| anyhow!("target: {error:?}"))?;
        let id = program.add_renderer(renderer)?;
        program.add_display(
            Panel {
                handle,
                size: panel,
            },
            id,
        )?;
        let surface = program.surface();
        surface.set_svc_allowlist(["pocket.overlay"]);
        let guest = Rc::new(Guest::new()?);
        program.boot_package(guest.clone(), package)?;
        let mut overlay = Self {
            program,
            surface,
            atlases,
            _guest: guest,
        };
        for text in UI_TEXT {
            overlay.extend_glyphs(text);
        }
        Ok(overlay)
    }

    fn extend_glyphs(&mut self, text: &str) {
        for blob in self.atlases.ensure(text) {
            self.surface.with_ui(|ui| {
                ui.load_font_atlas(&blob);
            });
        }
    }

    /// Hand the UI its whole state; glyphs for its strings exist before it measures.
    pub fn send_state(&mut self, state: &serde_json::Value, text: &str) {
        self.extend_glyphs(text);
        self.surface
            .svc_push(serde_json::json!({ "type": "state", "value": state }).to_string());
    }

    pub fn commands(&self) -> Vec<String> {
        self.surface.svc_drain()
    }

    /// One turn of the UI, drawn over what the framebuffer already holds.
    pub fn frame(&mut self, buttons: u32) -> Result<()> {
        let mut input = InputFrameBuilder::new();
        input.buttons = buttons;
        self.program.set_input(input);
        self.program.advance()?;
        self.program.present()
    }
}
