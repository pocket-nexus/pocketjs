//! Native program ownership, rendering, package admission and extension ABI.
#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;
pub mod extension;
pub mod package;
pub mod program;
pub use package::*;
// The archive supplies the exported pocket_runtime_* symbols, the allocator
// and panic handler of the no_std build and the std host hooks; nothing here
// calls it by name.
use pocket_archive as _;

#[cfg(feature = "standalone-extension-provider")]
#[no_mangle]
pub extern "C" fn pocket_native_extension_v1() -> *const extension::ExtensionV1 {
    core::ptr::null()
}
#[cfg(not(feature = "std"))]
mod host_hooks;
