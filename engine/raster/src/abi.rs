//! The body of `pocket_raster_draw_op` (`pocket_runtime.h`): one decoded
//! operation drawn into a C caller's CPU surface. An archive built with the
//! software renderer exports the symbol and forwards here.
use pocket_drivers::{
    abi::{
        borrowed, pixel_format, rect, writable, AdapterError, CResources, PocketDrawOp,
        PocketLogicalClip, PocketRenderResources, PocketSurface, POCKET_STATUS_OK,
    },
    DamageRect, RenderError, RenderResources, Surface,
};
use pocket_render::Operation;

/// # Safety
/// All input pointers provide their announced prefixes and valid borrowed
/// payloads. target grants exclusive CPU access until this function returns.
pub unsafe fn pocket_raster_draw_op(
    target: *mut PocketSurface,
    op: *const PocketDrawOp,
    resources: *const PocketRenderResources,
) -> i32 {
    unsafe { draw(target, op, resources) }
        .map(|_| POCKET_STATUS_OK)
        .unwrap_or_else(AdapterError::status)
}
unsafe fn draw(
    target: *mut PocketSurface,
    op: *const PocketDrawOp,
    resources: *const PocketRenderResources,
) -> Result<(), AdapterError> {
    let raw = unsafe { PocketSurface::read_prefix(target) }.ok_or(AdapterError::Invalid)?;
    let region = unsafe { rect(raw.region) }?;
    let format = pixel_format(raw.pixel_format)?;
    let mut surface = Surface::new(
        unsafe { writable(raw.pixels, raw.byte_length) }?,
        region,
        raw.stride_bytes,
        format,
    )
    .map_err(|_| AdapterError::Invalid)?;
    let op = unsafe { PocketDrawOp::read_prefix(op) }.ok_or(AdapterError::Invalid)?;
    let resources = unsafe { CResources::new(resources) }?;
    let words = unsafe { borrowed(op.words, op.word_count) }?;
    let opcode = *words.first().ok_or(AdapterError::Invalid)?;
    // Native-only operations must not appear to have software support.
    if opcode == pocket_spec::draw_op::TEXT_RUN || opcode == pocket_spec::draw_op::SURFACE_QUAD {
        return Err(AdapterError::Unsupported);
    }
    let clip = if op.clip.is_null() {
        let (w, h) = resources.viewport();
        DamageRect::new(0, 0, w as i32, h as i32)
    } else {
        let clip =
            unsafe { PocketLogicalClip::read_prefix(op.clip) }.ok_or(AdapterError::Invalid)?;
        DamageRect::new(clip.x0, clip.y0, clip.x1, clip.y1)
    };
    let scale = if op.struct_size
        < core::mem::offset_of!(PocketDrawOp, scale) + core::mem::size_of::<u32>()
    {
        1
    } else {
        op.scale
    };
    let operation = Operation {
        opcode,
        words,
        clip,
    };
    crate::render_operation(&resources, &operation, &mut surface, scale).map_err(
        |error| match error {
            RenderError::Unsupported => AdapterError::Unsupported,
            RenderError::InvalidFrame => AdapterError::Invalid,
            _ => AdapterError::Failed,
        },
    )
}
