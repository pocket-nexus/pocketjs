//! Display-list storage that owns its data-cache lines.
//!
//! `sceGuStart` writes a list through the uncached mirror of its address
//! (`| 0x4000_0000`), so the GE reads every command from RAM with no cache
//! flush. The CPU's data cache holds 64-byte lines. A list buffer that starts
//! inside a line shares that line with whatever the linker placed before it.
//! When the CPU writes that neighbour through the cache, the line is loaded
//! with the buffer's first bytes as RAM held them at that moment and marked
//! dirty. Commands written afterwards go to RAM only. When the cache later
//! writes the line back, the old bytes replace those commands, and the GE
//! runs what was there before.
//!
//! Measured on a PSP with a 16-byte-aligned buffer at `0x08aaf310` and an
//! 8-byte static at `0x08aaf304`, written just before `sceGuInit`: after the
//! first list had run, RAM held zeros in the buffer's first 12 words, the 48
//! bytes of the shared line, and commands from word 12 on. Word 9 was
//! `sceGuDrawBuffer`'s framebuffer format, so the GE kept the format its
//! reset list sets (5650) and drew 16-bit pixels into the 32-bit display for
//! the life of the program. Whether the write-back falls between the write
//! and the GE's read depends on which cache set the line is in, so a build
//! shows it or not by where its data lands.
//!
//! [`DisplayList`] is aligned to a cache line and, as every Rust type, sized
//! to a multiple of its alignment: no other object shares a line with it.

use core::ffi::c_void;

/// The data cache's line on the PSP's CPU, in bytes.
pub const CACHE_LINE: usize = 64;

/// A display list of `WORDS` commands in cache lines of its own.
#[repr(C, align(64))]
pub struct DisplayList<const WORDS: usize>([u32; WORDS]);

const _: () = assert!(core::mem::align_of::<DisplayList<1>>() == CACHE_LINE);

impl<const WORDS: usize> DisplayList<WORDS> {
    /// An empty list: every word is a GE `NOP`.
    pub const fn new() -> Self {
        Self([0; WORDS])
    }

    /// The pointer `sceGuStart` takes.
    ///
    /// `this` is the address of a `static mut`: `addr_of_mut!(LIST)`.
    pub const fn as_mut_ptr(this: *mut Self) -> *mut c_void {
        this.cast()
    }
}

impl<const WORDS: usize> Default for DisplayList<WORDS> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{DisplayList, CACHE_LINE};
    use core::mem::{align_of, size_of};
    use core::ptr::addr_of_mut;

    #[test]
    fn a_list_starts_on_a_cache_line_and_fills_whole_lines() {
        assert_eq!(align_of::<DisplayList<0x40000>>(), CACHE_LINE);
        assert_eq!(size_of::<DisplayList<0x40000>>(), 0x40000 * 4);
        // A length that is not a multiple of a line is padded to one: the
        // bytes after the last command are the list's own.
        assert_eq!(size_of::<DisplayList<1>>(), CACHE_LINE);
        assert_eq!(size_of::<DisplayList<16>>(), CACHE_LINE);
        assert_eq!(size_of::<DisplayList<17>>(), 2 * CACHE_LINE);
        assert_eq!(size_of::<DisplayList<223>>(), 14 * CACHE_LINE);
    }

    #[test]
    fn a_static_beside_a_list_is_in_another_line() {
        static mut BEFORE: (usize, usize) = (0, 0);
        static mut LIST: DisplayList<17> = DisplayList::new();
        static mut AFTER: u32 = 0;
        let list = DisplayList::as_mut_ptr(addr_of_mut!(LIST)) as usize;
        assert_eq!(list % CACHE_LINE, 0);
        let lines = list / CACHE_LINE..(list + size_of::<DisplayList<17>>()) / CACHE_LINE;
        for other in [addr_of_mut!(BEFORE) as usize, addr_of_mut!(AFTER) as usize] {
            assert!(!lines.contains(&(other / CACHE_LINE)));
        }
    }
}
