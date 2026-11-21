//! Program screenshot composition over mailbox I/O and display readback.
pub use pocket_psp_io::debug_mailbox::{active, init, poll, send};
pub unsafe fn shot() -> bool {
    pocket_psp_io::debug_mailbox::shot(|row, rows, out| {
        pocket_psp_display::read_display_rows_rgba(row, rows, out)
    })
}
