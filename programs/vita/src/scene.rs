//! Vita host registration and shared-scene compatibility for pocket-vita-render.
//! The driver owns geometry, resource versions and GPU completion; this layer
//! supplies the fixed display plan and adapts retained Ui resources.
use pocket_drivers::{DrawList, FrameInput, Renderer, Target};
use pocket_vita_render::registered::{GxmDisplay, SharedRenderer as RegisteredRenderer};
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
/// commands after this call and before present. This waits for the previous
/// scene's GPU work before vita2d reuses its vertex pool.
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
/// completion precedes the queued display swap and retirement.
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
        GxmDisplay::new(shared, pocket_drivers::DisplayRole::Primary),
        id,
    );
    if status == 0 {
        Ok(())
    } else {
        Err(format!("Vita display registration: {status}"))
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

/// Canonical presentation queued this frame's swap.
pub(crate) unsafe fn mark_presented() {
    CANONICAL_PRESENTED = true;
}
