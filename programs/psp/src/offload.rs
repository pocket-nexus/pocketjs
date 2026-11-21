//! Program selection of the developer transport slot.
pub use pocket_psp_io::offload::*;
pub fn enabled() -> bool {
    !env!("POCKETJS_OFFLOAD_SLOT").is_empty()
}
pub unsafe fn start() {
    pocket_psp_io::offload::start(env!("POCKETJS_OFFLOAD_SLOT"));
}
