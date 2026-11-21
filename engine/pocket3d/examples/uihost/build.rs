//! Places the exported profile named by `POCKETJS_PROFILE_RS` in OUT_DIR. A
//! default workspace build receives a stub, and uihost reports the missing
//! profile at startup.
fn main() {
    pocket_profile_build::emit(pocket_profile_build::Export::Optional);
}
