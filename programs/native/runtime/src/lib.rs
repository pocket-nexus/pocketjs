//! Native program ownership, rendering, package admission and extension ABI.
#![cfg_attr(not(feature = "std"), no_std)]
extern crate alloc;
pub mod extension;
pub mod package;
pub mod program;
pub use package::*;

#[cfg(feature = "standalone-extension-provider")]
#[no_mangle]
pub extern "C" fn pocket_native_extension_v1() -> *const extension::ExtensionV1 {
    core::ptr::null()
}
#[cfg(not(feature = "std"))]
mod host_hooks;
