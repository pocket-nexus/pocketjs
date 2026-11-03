//! DrawList visiting, the C software fallback into one acquired CPU surface,
//! and the software renderer an archive registers as renderer 0.
use pocket_drivers::{abi::*, DamageRect};

/// Visit a validated DrawList through the same decoder used by Rust drivers.
///
/// # Safety
/// Record pointers and payloads remain readable and unchanged until return.
/// The visitor observes the ABI's synchronous borrowed-operation contract.
#[no_mangle]
pub unsafe extern "C" fn pocket_draw_list_visit(
    list: *const PocketDrawList,
    resources: *const PocketRenderResources,
    scale: u32,
    visitor: Option<PocketDrawOpVisitFn>,
    context: *mut core::ffi::c_void,
) -> i32 {
    let Some(visitor) = visitor else {
        return POCKET_STATUS_INVALID;
    };
    let Some(list) = (unsafe { PocketDrawList::read_prefix(list) }) else {
        return POCKET_STATUS_INVALID;
    };
    let Some(resources) = (unsafe { PocketRenderResources::read_prefix(resources) }) else {
        return POCKET_STATUS_INVALID;
    };
    if list.version != pocket_spec::DRAW_LIST_VERSION {
        return POCKET_STATUS_UNSUPPORTED;
    }
    if scale == 0
        || [resources.viewport_width, resources.viewport_height]
            .iter()
            .any(|&v| !v.is_finite() || v <= 0.0 || v as f64 > i32::MAX as f64)
    {
        return POCKET_STATUS_INVALID;
    }
    let words = match unsafe { borrowed(list.words, list.word_count) } {
        Ok(words) => words,
        Err(error) => return error.status(),
    };
    let viewport = DamageRect::new(
        0,
        0,
        resources.viewport_width as i32,
        resources.viewport_height as i32,
    );
    // Reject a malformed tail before a driver has submitted any hardware work.
    if pocket_render::validate(words, viewport).is_err() {
        return POCKET_STATUS_INVALID;
    }
    for operation in pocket_render::DrawOps::new(words, viewport) {
        let Ok(operation) = operation else {
            return POCKET_STATUS_INVALID;
        };
        let clip = PocketLogicalClip {
            x0: operation.clip.x0,
            y0: operation.clip.y0,
            x1: operation.clip.x1,
            y1: operation.clip.y1,
            ..PocketLogicalClip::empty()
        };
        let raw = PocketDrawOp {
            words: operation.words.as_ptr(),
            word_count: operation.words.len(),
            clip: &clip,
            scale,
            ..PocketDrawOp::empty()
        };
        let status = unsafe { visitor(context, &raw) };
        if status != POCKET_STATUS_OK {
            return status;
        }
    }
    POCKET_STATUS_OK
}

/// Forwards to `pocket_raster::abi` in an archive built with the
/// `software-renderer` feature. Other archives keep the symbol and return
/// `POCKET_STATUS_UNSUPPORTED` without reading the records or writing the
/// surface.
///
/// # Safety
/// All input pointers provide their announced prefixes and valid borrowed
/// payloads. target grants exclusive CPU access until this function returns.
#[no_mangle]
pub unsafe extern "C" fn pocket_raster_draw_op(
    target: *mut PocketSurface,
    op: *const PocketDrawOp,
    resources: *const PocketRenderResources,
) -> i32 {
    #[cfg(feature = "software-renderer")]
    return unsafe { pocket_raster::abi::pocket_raster_draw_op(target, op, resources) };
    #[cfg(not(feature = "software-renderer"))]
    {
        let _ = (target, op, resources);
        POCKET_STATUS_UNSUPPORTED
    }
}

/// Register the software rasterizer as renderer 0 of a new instance, with
/// the rescale callback boot and the resize entry points call.
#[cfg(feature = "software-renderer")]
pub(crate) fn install_software_renderer(
    runtime: &mut pocket_runtime::Runtime,
) -> Result<(), pocket_runtime::RuntimeError> {
    let renderer = pocket_raster::RasterRenderer::new(1)
        .map_err(|_| pocket_runtime::RuntimeError::InvalidConfiguration)?;
    runtime.set_software_renderer(renderer, pocket_raster::RasterRenderer::new)
}
