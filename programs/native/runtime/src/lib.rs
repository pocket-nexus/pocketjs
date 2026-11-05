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
#[cfg(all(feature = "std", feature = "host-hooks"))]
compile_error!(
    "host-hooks selects C hooks for the no_std archive; the std archive defines its own"
);
#[cfg(all(
    feature = "host-backend",
    any(feature = "software-only", feature = "gles1")
))]
compile_error!("host-backend registers no built-in output; software-only and gles1 select one");
#[cfg(all(not(feature = "std"), not(feature = "host-hooks")))]
mod host_hooks;
