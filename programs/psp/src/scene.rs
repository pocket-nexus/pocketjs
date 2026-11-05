//! Compatibility with native game compositions that own an open GU list.
//! Rendering and font-page mechanisms live in pocket-psp-render; Ui appears
//! only in this adapter to the independent RenderResources contract.
use pocket_psp_render::{native, Encoder};
use pocketjs_core::Ui;
static mut ENCODER: Option<Encoder> = None;

/// # Safety
/// Call on the GU thread after sceGuSync has completed every encoded pass.
pub unsafe fn reset_pool() {
    if let Some(encoder) = ENCODER.as_mut() {
        encoder.retire();
    }
}
/// # Safety
/// No native command list may reference a font page from the prior guest.
pub unsafe fn reset_fonts() {
    if let Some(encoder) = ENCODER.as_mut() {
        encoder.reset_fonts();
    }
}
/// Publish bytes uploaded through a native extension. The canonical renderer
/// also publishes external resources when their content revision changes.
pub fn writeback_texture(ui: &Ui, handle: i32) {
    let Some(view) = ui.texture(handle) else {
        return;
    };
    pocket_psp_ge::cache::writeback(view.pixels);
    if let Some(palette) = view.palette {
        pocket_psp_ge::cache::writeback(palette);
    }
}
/// # Safety
/// The caller owns an open 1 MiB GU list with at least 24 bytes remaining,
/// and keeps Ui texture bytes immutable
/// until sceGuSync completes. Call reset_pool only after that completion.
pub unsafe fn render(ui: &Ui, words: &[u32]) {
    encode(ui, words, true);
}
/// Encode an overlay without clearing the native scene.
///
/// # Safety
/// Same native-list and resource lifetime requirements as render.
pub unsafe fn render_over(ui: &Ui, words: &[u32]) {
    encode(ui, words, false);
}
unsafe fn encode(ui: &Ui, words: &[u32], clear: bool) {
    let encoder = ENCODER.get_or_insert_with(Encoder::new);
    if let Err(error) = native::encode_open(crate::host::list_ptr(), encoder, ui, words, clear) {
        psp::dprintln!("[PocketJS GE] invalid pass: {:?}", error);
        crate::host::halt("GE pass validation or native command capacity failed");
    }
}
