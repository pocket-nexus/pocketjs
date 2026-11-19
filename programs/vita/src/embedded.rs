//! The application this program embeds. build.rs copies the compiled bundle
//! `POCKETJS_EMBED_BUNDLE` names verbatim into `BUNDLE`; the runtime admits
//! those bytes as they are.
use crate::Runtime;

// $OUT_DIR/bundle.rs: `BUNDLE`, 16-byte aligned, empty without an embedded
// application (tools/build/embedded-bundle.rs).
include!(concat!(env!("OUT_DIR"), "/bundle.rs"));

/// The embedded application's output name; empty in the generic runtime.
pub const OUTPUT: &str = env!("POCKETJS_APP_NAME");

/// Boot the stock guest in `runtime`: the embedded bundle, or in the generic
/// runtime app0:app.pkb.
///
/// # Safety
/// The requirements of `Runtime::eval_package`.
pub unsafe fn eval(runtime: &mut Runtime) -> Result<(), String> {
    #[cfg(feature = "runtime")]
    return crate::package_file::source().and_then(|source| runtime.eval_source(source));
    #[cfg(not(feature = "runtime"))]
    {
        if BUNDLE.is_empty() {
            return Err("this program embeds no compiled application package".into());
        }
        runtime.eval_package(BUNDLE)
    }
}
