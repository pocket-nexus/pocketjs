//! Places the profile `pocket build` exported for this host in OUT_DIR. CI
//! also builds and lints the crate as a plain workspace member; that build
//! receives a stub, and the host reports the missing profile at startup.
fn main() {
    pocket_profile_build::emit(pocket_profile_build::Export::Optional);
}
