//! The program selects its package path; Runtime performs all admission.
use alloc::{boxed::Box, string::String};
use pocket_drivers::PackageSource;
pub fn source() -> Result<Box<dyn PackageSource>, String> {
    pocket_psp_io::package::FileSource::open(c"app.pocket")
        .map(|s| Box::new(s) as Box<dyn PackageSource>)
        .map_err(|_| "Cannot open app.pocket beside EBOOT.PBP".into())
}
