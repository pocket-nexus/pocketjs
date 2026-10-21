//! Vita host registration and shared-scene compatibility for pocket-vita-render.
//! The driver owns geometry, resource versions and GPU completion; this layer
//! supplies the fixed display plan and adapts retained Ui resources.
use pocket_drivers::{DrawList, FrameInput, Renderer, Target};
use pocket_vita_render::{native::VitaDevice, Config, GxmRenderer};
#[cfg(feature = "capture")]
use pocketjs_core::spec;
use pocketjs_core::{text::Atlas, Ui};
use std::{
    cell::{RefCell, RefMut},
    rc::Rc,
};
#[cfg(feature = "capture")]
use std::{fs, io, path::Path};
mod build_plan {
    include!(concat!(env!("OUT_DIR"), "/build_plan.rs"));
}
pub use build_plan::{
    INTEGER_SCALE, LOGICAL_H, LOGICAL_W, PHYSICAL_H, PHYSICAL_W, RASTER_DENSITY, SCALE,
};
pub const DEFAULT_POOL_BYTES: u32 = 2 * 1024 * 1024;
type SharedRenderer = Rc<RefCell<GxmRenderer<VitaDevice>>>;
static mut RENDERER: Option<SharedRenderer> = None;
static mut CANONICAL_PRESENTED: bool = false;
unsafe fn renderer() -> Option<RefMut<'static, GxmRenderer<VitaDevice>>> {
    RENDERER.as_ref().map(|renderer| renderer.borrow_mut())
}
pub fn init() -> Result<(), &'static str> {
    init_with_pool(DEFAULT_POOL_BYTES)
}
pub fn init_with_pool(pool_bytes: u32) -> Result<(), &'static str> {
    unsafe {
        if RENDERER.is_some() {
            return Ok(());
        }
        let device = VitaDevice::new(pool_bytes).map_err(|_| "vita2d initialization failed")?;
        let mut config = Config::new(PHYSICAL_W as u32, PHYSICAL_H as u32, INTEGER_SCALE as u32);
        config.external_compositor = true;
        RENDERER = Some(Rc::new(RefCell::new(
            GxmRenderer::new(device, config).map_err(|_| "GXM renderer registration failed")?,
        )));
        Ok(())
    }
}
/// # Safety
/// Call on the Vita render thread with no scene open. Native 3D may record
/// commands after this call and before present.
pub unsafe fn begin_frame(clear: u32) {
    CANONICAL_PRESENTED = false;
    if let Some(mut renderer) = renderer() {
        assert!(
            renderer.begin_frame(clear).is_ok(),
            "cannot begin GXM frame while a scene is open"
        );
    }
}
/// # Safety
/// Call on the Vita render thread after the shared scene's last draw. GPU
/// completion precedes the display swap; display completion precedes retire.
pub unsafe fn present() {
    if CANONICAL_PRESENTED {
        CANONICAL_PRESENTED = false;
        return;
    }
    if let Some(mut renderer) = renderer() {
        if renderer.present().is_err() {
            crate::vita_log(format_args!("[PocketJS Vita] GXM frame discarded"));
        }
    }
}
pub(crate) unsafe fn discard_frame() {
    if let Some(mut renderer) = renderer() {
        let _ = renderer.discard_frame();
    }
    CANONICAL_PRESENTED = true;
}
/// # Safety
/// Call at a closed-scene guest boundary on the owning render thread.
pub unsafe fn reset_guest() {
    if let Some(mut renderer) = renderer() {
        assert!(
            renderer.reset_guest().is_ok(),
            "cannot reset guest GPU state inside a scene"
        );
    }
}
// Upload hooks invalidate versions without entering the device. DrawList
// references trigger uploads; package parsing does not scan GPU texture slots.
pub fn register_texture(_ui: &Ui, handle: i32) {
    unsafe {
        if let Some(mut renderer) = renderer() {
            renderer.invalidate_texture(handle);
        }
    }
}
pub fn update_texture_in_place(ui: &Ui, handle: i32) {
    register_texture(ui, handle);
}
pub fn free_texture(handle: i32) {
    unsafe {
        if let Some(mut renderer) = renderer() {
            renderer.invalidate_texture(handle);
        }
    }
}
pub fn register_font_atlas(slot: u8, _atlas: &Atlas) {
    unsafe {
        if let Some(mut renderer) = renderer() {
            renderer.invalidate_font(slot);
        }
    }
}
/// # Safety
/// Call on the render thread with no open scene. Presentation stays explicit.
pub unsafe fn render(ui: &Ui, words: &[u32]) {
    begin_frame(0xff00_0000);
    render_over(ui, words);
}
/// # Safety
/// Call inside the shared scene. The driver copies borrowed words/resources
/// before returning; its submission remains owned until present.
pub unsafe fn render_over(ui: &Ui, words: &[u32]) {
    let Some(mut renderer) = renderer() else {
        return;
    };
    let retained = ui.current_draw_list();
    let mut copied = DrawList::new();
    let list = if retained.words.as_ptr() == words.as_ptr() && retained.words.len() == words.len() {
        retained
    } else {
        copied.words.extend_from_slice(words);
        &copied
    };
    let target = renderer.target();
    let mut frame = FrameInput::new(list, ui, &[], Target::DeviceOwned(target));
    if renderer.render(&mut frame).is_err() {
        crate::vita_log(format_args!("[PocketJS Vita] GXM submission failed"));
    }
}

/// Register the process device in one canonical guest instance.
pub(crate) unsafe fn register(
    runtime: *mut pocket_runtime_cabi::abi::PocketRuntime,
) -> Result<(), String> {
    let shared = RENDERER.as_ref().ok_or("GXM is not initialized")?.clone();
    let id =
        pocket_runtime_cabi::embedding::add_renderer(runtime, RegisteredRenderer(shared.clone()))
            .map_err(|s| format!("GXM registration: {s}"))?;
    let status = pocket_runtime_cabi::embedding::add_display(
        runtime,
        RegisteredDisplay {
            shared,
            acquired: false,
            pending: None,
            next: 1,
        },
        id,
    );
    if status == 0 {
        Ok(())
    } else {
        Err(format!("Vita display registration: {status}"))
    }
}
struct RegisteredRenderer(SharedRenderer);
impl pocket_drivers::Renderer for RegisteredRenderer {
    type Submission = pocket_vita_render::Submission;
    fn descriptor(&self) -> pocket_drivers::RendererDescriptor {
        self.0.borrow().descriptor()
    }
    fn render(
        &mut self,
        frame: &mut FrameInput<'_>,
    ) -> Result<Self::Submission, pocket_drivers::RenderError> {
        self.0.borrow_mut().render(frame)
    }
    unsafe fn render_zero_copy(
        &mut self,
        _: &mut FrameInput<'_>,
    ) -> Result<Self::Submission, pocket_drivers::RenderError> {
        Err(pocket_drivers::RenderError::Unsupported)
    }
    fn wait(&mut self, token: &Self::Submission) -> Result<(), pocket_drivers::RenderError> {
        self.0.borrow_mut().wait(token)
    }
    fn retire(&mut self, token: Self::Submission) {
        self.0.borrow_mut().retire(token)
    }
}
struct RegisteredDisplay {
    shared: SharedRenderer,
    acquired: bool,
    pending: Option<u64>,
    next: u64,
}
impl pocket_drivers::DisplayOutput for RegisteredDisplay {
    type Token = u64;
    fn descriptor(&self) -> pocket_drivers::DisplayDescriptor {
        let mut d = pocket_drivers::DisplayDescriptor::new(
            pocket_drivers::DisplayRole::Primary,
            PHYSICAL_W as u32,
            PHYSICAL_H as u32,
            pocket_drivers::PixelFormat::Rgba8888,
            PHYSICAL_W as usize * 4,
            pocket_drivers::TargetOwnership::DeviceOwned,
        );
        d.vsync = pocket_drivers::VsyncSource::Display;
        d
    }
    fn acquire(
        &mut self,
        region: pocket_drivers::Rect,
    ) -> Result<Target<'_>, pocket_drivers::DisplayError> {
        let target = self.shared.borrow().target();
        if self.pending.is_some() || region != target.region {
            return Err(pocket_drivers::DisplayError::InvalidTarget);
        }
        self.acquired = true;
        Ok(Target::DeviceOwned(target))
    }
    fn flush(&mut self, _: &[pocket_drivers::Rect]) -> Result<u64, pocket_drivers::DisplayError> {
        if !self.acquired || self.pending.is_some() {
            return Err(pocket_drivers::DisplayError::InvalidTarget);
        }
        self.acquired = false;
        let token = self.next;
        self.next = self
            .next
            .checked_add(1)
            .ok_or(pocket_drivers::DisplayError::Failed)?;
        self.shared
            .borrow_mut()
            .flush_display()
            .map_err(|_| pocket_drivers::DisplayError::Failed)?;
        self.pending = Some(token);
        Ok(token)
    }
    fn wait(&mut self, token: u64) -> Result<(), pocket_drivers::DisplayError> {
        if self.pending != Some(token) {
            return Err(pocket_drivers::DisplayError::InvalidTarget);
        }
        self.pending = None;
        let result = self
            .shared
            .borrow_mut()
            .wait_display()
            .map_err(|_| pocket_drivers::DisplayError::Failed);
        unsafe {
            CANONICAL_PRESENTED = true;
        }
        result
    }
    fn vsync(&mut self) -> pocket_drivers::VsyncSource {
        pocket_drivers::VsyncSource::Display
    }
}
impl Drop for RegisteredDisplay {
    fn drop(&mut self) {
        if self.pending.take().is_some() {
            let _ = self.shared.borrow_mut().wait_display();
        }
    }
}

#[cfg(feature = "capture")]
fn validate_texture_residency(ui: &Ui, words: &[u32]) -> io::Result<()> {
    let mut i = 0usize;
    while i < words.len() {
        let next = match words[i] {
            spec::draw_op::RECT => i.checked_add(4),
            spec::draw_op::GRAD_RECT => i.checked_add(6),
            spec::draw_op::TRI => i.checked_add(7),
            spec::draw_op::GLYPH_RUN if i + 2 < words.len() => {
                let slot = (words[i + 1] & 0xff) as u8;
                if ui.font_atlas(slot).is_none() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("DrawList references missing font atlas slot {slot}"),
                    ));
                }
                let resident = unsafe { renderer().is_some_and(|renderer| renderer.font_resident(slot)) };
                if !resident {
                    return Err(io::Error::other(format!(
                        "Vita GPU font atlas slot {slot} was not resident after production rendering"
                    )));
                }
                let count = (words[i + 1] >> 16) as usize;
                i.checked_add(3 + count.saturating_mul(2))
            }
            spec::draw_op::TEX_QUAD | spec::draw_op::TEX_TRI => {
                let op = words[i];
                let handle = *words.get(i + 1).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "truncated texture draw op")
                })? as i32;
                if ui.texture(handle).is_none() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("DrawList references stale texture handle {handle}"),
                    ));
                }
                let resident = unsafe { renderer().is_some_and(|renderer| renderer.texture_resident(handle)) };
                if !resident {
                    return Err(io::Error::other(format!(
                        "Vita GPU texture {handle} was not resident after production rendering"
                    )));
                }
                i.checked_add(if op == spec::draw_op::TEX_QUAD { 9 } else { 12 })
            }
            spec::draw_op::SCISSOR => i.checked_add(3),
            spec::draw_op::SCISSOR_POP => i.checked_add(1),
            spec::draw_op::SURFACE_QUAD => i.checked_add(9),
            op => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unknown DrawList op {op} at word {i}"),
                ));
            }
        }
        .filter(|next| *next <= words.len())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "truncated DrawList op"))?;
        i = next;
    }
    Ok(())
}

/// Render a deterministic golden directly at Vita's physical resolution.
/// Vita3K's Vulkan framebuffer is not read back: on current macOS builds that
/// surface is not coherent with guest CDRAM and produces black dumps. This
/// still runs the real Vita QuickJS/input/frame loop, while the CPU oracle
/// evaluates geometry, gradients, textures and density-aware font coverage at
/// the same 480x272 -> 960x544 integer presentation scale as production GXM.
#[cfg(feature = "capture")]
pub fn capture_golden(ui: &Ui, words: &[u32], path: &str) -> io::Result<()> {
    // The pixels below come from the deterministic CPU oracle because current
    // Vita3K/macOS GXM readback is black. Still verify that the production
    // renderer made every core texture and font atlas resident, so backend-
    // only omissions cannot hide behind a passing CPU golden.
    validate_texture_residency(ui, words)?;
    let mut pixels = vec![0u8; PHYSICAL_W as usize * PHYSICAL_H as usize * 4];
    pocketjs_core::raster::render_scaled(ui, words, &mut pixels, INTEGER_SCALE as u32);
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, pixels)
}
