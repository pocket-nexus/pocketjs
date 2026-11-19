//! The application this EBOOT embeds. build.rs copies the compiled bundle
//! `POCKETJS_EMBED_BUNDLE` names verbatim into `BUNDLE`; the runtime admits
//! those bytes as they are.
use alloc::{boxed::Box, string::String};
use pocket_drivers::PackageSource;

// $OUT_DIR/bundle.rs: `BUNDLE`, 16-byte aligned, empty without an embedded
// application (tools/build/embedded-bundle.rs).
include!(concat!(env!("OUT_DIR"), "/bundle.rs"));

/// The embedded application's output name (`POCKETJS_APP_OUTPUT`); empty in
/// the generic runtime.
pub const OUTPUT: &str = env!("POCKETJS_APP");

/// The stock program's guest: the embedded bundle, or in the generic runtime
/// app.pkb beside the EBOOT.
pub fn source() -> Result<Box<dyn PackageSource>, String> {
    #[cfg(feature = "runtime")]
    return crate::package_file::source();
    #[cfg(not(feature = "runtime"))]
    {
        if BUNDLE.is_empty() {
            return Err("this EBOOT embeds no compiled application bundle".into());
        }
        Ok(Box::new(pocket_package::source::StaticMemorySource(BUNDLE)))
    }
}
